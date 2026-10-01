# 公司 GitLab 與 GitLab Runner 架設手冊

> 建立日期 2026-09-29。對應 [DEPLOYMENT.md](DEPLOYMENT.md) §1 主機規劃:**主機 1(Ubuntu)= GitLab + Container Registry `:5050`**;**主機 2(Windows + WSL2 內的 Docker Engine,不用 Docker Desktop)= 測試區 + Runner `windows-runner`**;主機 3(正式區,Runner `prod-deploy` Protected)之後比照主機 2。
> 架設完成後,測試區改走 CI(DEPLOYMENT.md §2–§3),不再依 [TEST-DEPLOY-RUNBOOK.md](TEST-DEPLOY-RUNBOOK.md) 手動部署。
> 標示 **【你執行】** 的步驟涉及密碼、Token 或系統權限,由你本人輸入;其餘可由 Claude 經 SSH 操作。

---

## 0. 開工前要決定 / 提供

| 項目 | 建議 | 你的值 |
| --- | --- | --- |
| 主機 1 IP(伺服器網段 10.10.130.x) | 固定 IP | |
| 主機 2 IP | 固定 IP | |
| 主機 1 SSH 帳號 | 一般帳號 + sudo(加入 `docker` 群組後,docker 指令不需 sudo) | |
| 主機 2 Windows 帳號 | 工作排程器以此帳號開機啟動 WSL(§3.5) | `user` |
| GitLab 走 HTTP 或 HTTPS | **第一階段 HTTP**(內網、快速上線);AD CS 憑證(P-05)到位後改 HTTPS。HTTP 下 Git 密碼以明文經內網傳送,Registry 需在各主機設 `insecure-registries` | |
| GitLab 版本 | 安裝當天的最新穩定版,**固定 tag**(不用 `latest`);Runner 與 GitLab 同 major.minor | |
| 主機 1 是否也裝 Runner | **先不裝**(DEPLOYMENT.md:主機 1 只放 GitLab);CI 全部由主機 2 執行 | |

主機 1 硬體:GitLab 官方建議至少 **4 vCPU、8 GB RAM**(4 GB 可跑但需 swap 並調低 worker),系統碟外另留 **50 GB 以上**給 `/srv/gitlab`(Registry 映像會持續增加)。

---

## 1. 準備 SSH(讓 Claude 可以操作)

### 1.1 產生 Claude 專用金鑰(在你的開發機,Claude 可代做)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/giganexus_ops -C "claude-ops@S112009" -N ""
cat ~/.ssh/giganexus_ops.pub
```

### 1.2 主機 1(Ubuntu)【你執行】

```bash
# OpenSSH Server(多半已安裝)
sudo apt-get update && sudo apt-get install -y openssh-server
# 放入 1.1 的公鑰
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "<1.1 的公鑰整行>" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
# 讓此帳號不需 sudo 即可使用 docker(重新登入後生效)
sudo usermod -aG docker "$USER"
# GitLab 資料目錄
sudo mkdir -p /srv/gitlab && sudo chown "$USER": /srv/gitlab
```

### 1.3 主機 2(Windows)【你執行,系統管理員 PowerShell】

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic
# SSH 登入後預設進 PowerShell
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
# 帳號屬於 Administrators 時,公鑰放這個檔案(一般帳號則放 %USERPROFILE%\.ssh\authorized_keys)
Add-Content -Path C:\ProgramData\ssh\administrators_authorized_keys -Value "<1.1 的公鑰整行>"
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

### 1.4 驗證(Claude 執行)

```bash
ssh -i ~/.ssh/giganexus_ops <帳號>@<主機1 IP> "docker version --format '{{.Server.Version}}'; nproc; free -h; df -h /srv"
ssh -i ~/.ssh/giganexus_ops <帳號>@<主機2 IP> "docker version --format '{{.Server.Version}}'; git --version"
```

---

## 2. 主機 1:以 Docker 安裝 GitLab CE

### 2.1 Compose 檔(Claude 建立 `/srv/gitlab/docker-compose.yml`)

```yaml
# GitLab CE(DEPLOYMENT.md §1 主機 1)。資料全部在 /srv/gitlab,備份見 §2.5
services:
  gitlab:
    image: gitlab/gitlab-ce:${GITLAB_VERSION:?}
    container_name: gitlab
    restart: always
    hostname: gitlab
    shm_size: '256m'
    environment:
      GITLAB_OMNIBUS_CONFIG: |
        external_url 'http://${GITLAB_HOST:?}'
        registry_external_url 'http://${GITLAB_HOST}:5050'
        gitlab_rails['gitlab_shell_ssh_port'] = 2222
        gitlab_rails['time_zone'] = 'Asia/Taipei'
        # 內網小型規模:節省記憶體
        puma['worker_processes'] = 2
        sidekiq['concurrency'] = 10
        prometheus_monitoring['enable'] = false
        # 對外寄信(通知、重設密碼)之後再設定 SMTP
    ports:
      - '80:80'        # Web / Git over HTTP
      - '5050:5050'    # Container Registry
      - '2222:22'      # Git over SSH(主機本身的 sshd 佔用 22)
    volumes:
      - /srv/gitlab/config:/etc/gitlab
      - /srv/gitlab/logs:/var/log/gitlab
      - /srv/gitlab/data:/var/opt/gitlab
```

`/srv/gitlab/.env`:

```
GITLAB_VERSION=<版本>-ce.0
GITLAB_HOST=<主機1 IP>
```

### 2.2 防火牆【你執行】

```bash
sudo ufw allow OpenSSH
sudo ufw allow from 10.10.0.0/16 to any port 80,2222,5050 proto tcp
sudo ufw enable && sudo ufw status
```

> **現況(2026-10-01 確認)**:主機 1 的 ufw 已啟用,INPUT 預設 DROP。已另外放行遠端桌面(xrdp):`sudo ufw allow from 10.10.0.0/16 to any port 3389 proto tcp comment 'xrdp'`。
> - Docker 對外發布的 port(`80`、`2222`、`5050`、Portainer `9443`)經 iptables DNAT 走 FORWARD 鏈,**不受 ufw INPUT 規則限制**;主機本身的服務(`22`、`3389`)才需要 `ufw allow`。
> - 新增主機本身的服務 port 卻連不到(用戶端逾時,但主機上 `ss -tlnp` 有監聽、連 `127.0.0.1` 正常),先查 `sudo ufw status numbered`。
> - 開發機以 SSH 登入主機 1 請用 `Port 22`;`~/.ssh/config` 為 GitLab 設的 `Port 2222` 會把連線帶進 GitLab 容器(見工作區 `AGENT.md` §5)。

### 2.3 啟動(Claude 執行)

```bash
cd /srv/gitlab
docker compose pull
docker compose up -d
# 第一次啟動約 3–5 分鐘,直到 (healthy)
watch -n 10 'docker ps --filter name=gitlab --format "{{.Status}}"'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/users/sign_in   # 200
```

### 2.4 初次登入與基本設定【你執行】

```bash
# 初始 root 密碼(24 小時後自動刪除,請立即登入改密碼)
sudo cat /srv/gitlab/config/initial_root_password
```

1. 瀏覽器開 `http://<主機1 IP>/`,以 `root` 登入 → 立即改密碼。
2. Admin → Settings → General → **Sign-up restrictions:關閉 Sign-up enabled**(內部系統不開放自行註冊)。
3. 建立自己的帳號並設為 Administrator;之後日常不用 `root`。
4. 建立 Group `giganexus`(REGISTRY 路徑為 `<主機1 IP>:5050/giganexus/giga-api-gateway-bff`,對應 `deploy/test.env.example`)。
5. 之後 AD 登入(LDAP)可在 `gitlab.rb` 設定,**不在本次範圍**。

### 2.5 備份(Claude 建立排程)

compose 的 `GITLAB_OMNIBUS_CONFIG` 加上 `gitlab_rails["backup_keep_time"] = 604800`(資料備份保留 7 天,修改後 `docker compose up -d` 重建容器)。`user` 的 crontab(已建立,2026-09-29):

```bash
# 02:00 資料備份(產生於容器內 /var/opt/gitlab/backups = 主機 /srv/gitlab/data/backups,root 權限)
0 2 * * * docker exec -t gitlab gitlab-backup create CRON=1 >> /tmp/gitlab-backup.log 2>&1
# 02:30 設定檔與加密金鑰(不在資料備份內,遺失則無法還原 CI 變數、2FA),依星期輪替保留 7 份
30 2 * * * docker exec gitlab sh -c 'tar czf /var/opt/gitlab/backups/gitlab-config-$(date +\%a).tar.gz -C /etc/gitlab gitlab.rb gitlab-secrets.json' >> /tmp/gitlab-backup.log 2>&1
```

備份與 GitLab 在同一台主機,**需另外複製到其他主機**(方式待 IT 決定)。

---

## 3. 主機 2:Windows + WSL2 內的 Docker Engine 與 GitLab Runner

> **2026-09-29 決定:不使用 Docker Desktop。** 專案映像皆為 Linux 容器,Windows 原生 `dockerd.exe` 只能執行 Windows 容器,因此在 WSL2(發行版 `Ubuntu`,目前為 24.04 LTS)內安裝 Docker Engine 與 Linux 版 Runner(shell executor)。CI 的 `sh` 腳本與 `docker run -v "$CI_PROJECT_DIR:/repo"` 與一般 Linux 主機相同。
> **已知限制**(Windows 10 build 19045):WSL2 只有 NAT 網路(mirrored 模式需 Windows 11 22H2),外部連入測試區需經 Windows 轉送;2026-10-01 起以 Traefik + PROXY protocol 轉送並保留使用者真實 IP(DEPLOYMENT.md §6.1);WSL VM 需以工作排程器開機啟動並常駐。主機 3(10.10.130.122)比照辦理,Runner tag 改 `prod-deploy`(Protected)。

### 3.1 VM 與 Windows 前置【你 / VMware 管理員執行】

| 項目 | 說明 |
| --- | --- |
| VMware 巢狀虛擬化 | VM 關機 → 設定 → CPU → 勾選 **Virtualize Intel VT-x/EPT or AMD-V/RVI**;未開啟時 WSL2 無法啟動(目前 `VirtualizationFirmwareEnabled = False`) |
| CPU | 目前 2 核,建議 **4 核**(測試區容器 + CI 建置映像) |
| 啟用 WSL2(系統管理員 PowerShell,完成後重開機) | `dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart`<br>`dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart` |
| 安裝 Ubuntu(重開機後) | `wsl --update`、`wsl --set-default-version 2`、`wsl --install --web-download -d Ubuntu`(線上清單只有 `Ubuntu`,指定 `Ubuntu-22.04` 會回「不正確發佈名稱」);首次啟動建立 Linux 帳號(建議 `user`)與密碼 |

### 3.2 WSL 內安裝(Claude 經 SSH 以 `wsl -d Ubuntu -u root` 執行)

```bash
# systemd(Docker、Runner 以 systemd 服務啟動);設定後在 Windows 執行 wsl --shutdown 再啟動
printf '[boot]\nsystemd=true\n' > /etc/wsl.conf

# Docker Engine(官方 apt 套件庫)
apt-get update && apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
# Registry 目前為 HTTP
printf '{ "insecure-registries": ["10.10.130.123:5050"] }\n' > /etc/docker/daemon.json
systemctl enable --now docker

# Node.js 22(shell executor 忽略 image:,check:bff 直接用主機的 Node)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs

# GitLab Runner(官方 apt 套件庫)
curl -fsSL https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh | bash
apt-get install -y gitlab-runner
usermod -aG docker gitlab-runner

# 測試區受保護目錄(取代 TEST-DEPLOY-RUNBOOK 的 D:/giganexus)
mkdir -p /srv/giganexus/deploy/secrets /srv/giganexus/deploy/config
```

### 3.3 在 GitLab 建立 Runner【你執行,瀏覽器】

Admin → CI/CD → Runners → **New instance runner**:

- Tags:`windows-runner`(沿用 `.gitlab-ci.yml` 的 tag 名稱);**不勾** Run untagged jobs
- 完成後畫面出現 `glrt-` 開頭的 Token,**只顯示一次**,留在畫面上給下一步使用

### 3.4 註冊【你執行,在 WSL 的 Ubuntu 視窗】

```bash
sudo gitlab-runner register --non-interactive --url "http://10.10.130.123" --token "<glrt- Token>" --executor shell --description "host2-test"
```

### 3.5 開機自動啟動 WSL 並常駐【你執行,系統管理員 PowerShell】

WSL 沒有程序執行時會自動停止 VM(Windows 10 不支援 `vmIdleTimeout`),以工作排程器在開機時啟動一個常駐程序;需儲存 Windows 帳號密碼:

```powershell
$a = New-ScheduledTaskAction -Execute "C:\Windows\System32\wsl.exe" -Argument "-d Ubuntu -u root --exec /bin/sh -c 'exec sleep infinity'"
$t = New-ScheduledTaskTrigger -AtStartup
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "WSL-GigaNexus" -Action $a -Trigger $t -Settings $s -User "user" -Password "<Windows 密碼>" -RunLevel Highest
```

### 3.6 測試區對外轉發(部署測試區時才需要)

以 Traefik 做 L4 轉送(保留來源 IP):把 `deploy/windows-l4/` 的檔案與官方 `traefik.exe`(比對 SHA256)放到 `C:\traefik`,以系統管理員執行 `install.ps1 -HostIp <主機 IP>`(建立開機工作 `GigaNexus-Traefik`、移除 portproxy 80 / 443),並以 `New-NetFirewallRule` 開放 80 / 443。轉送目標為 WSL localhost 轉送的 `127.0.0.1:10080 / 10443`,WSL IP 變動不影響。細節與還原見 DEPLOYMENT.md §6.1。

### 3.7 驗證(Claude 執行)

```powershell
wsl -d Ubuntu -u root -- sh -c "docker info --format '{{.ServerVersion}}'; node -v; gitlab-runner --version | head -1; gitlab-runner verify"
```

GitLab Admin → Runners 顯示綠燈(online);**重開 Windows 主機後(不登入桌面)Runner 仍為 online**。

---

## 4. 把專案推上 GitLab 並跑第一條 Pipeline

1. 在 Group `giganexus` 建立空專案:`giga-api-gateway-bff`、`giga-Portal`、`GigaItApp`(**不要**勾選初始化 README)。
2. 開發機加上 GitLab 遠端並推送(Claude 可代做,Git 認證由你輸入):

   ```bash
   cd <工作區>/giga-api-gateway-bff
   git remote add gitlab http://<主機1 IP>/giganexus/giga-api-gateway-bff.git
   git push gitlab main
   git push gitlab main:develop     # .gitlab-ci.yml 以 develop 自動部署測試區
   ```

3. 專案設定:
   - Repository → Protected branches:`main`、`develop`(禁止 force push)
   - CI/CD → Variables:`GW_DEPLOY_DIR` = `/srv/giganexus/deploy`(Protected;WSL 內的受保護目錄,取代 TEST-DEPLOY-RUNBOOK 的 `D:/giganexus`)
4. 第一條 Pipeline 預期要調整的地方(**尚未在實際 Runner 執行過**,COMPANY-ENV-PLAN §5):
   - `check:nginx` 的 `docker run -v "$CI_PROJECT_DIR:/repo"`:Git Bash 下路徑格式與 `MSYS_NO_PATHCONV`
   - `build` 推送到 HTTP Registry(WSL 內 `/etc/docker/daemon.json` 的 `insecure-registries`,§3.2)
   - `deploy-test`:`$GW_DEPLOY_DIR/test.env` 內的 `REGISTRY`、`IMAGE_TAG` 改由 Pipeline 覆寫

---

## 5. 驗收清單

- [ ] `http://<主機1 IP>/` 可登入;已關閉自行註冊;root 密碼已更改
- [ ] 主機 1 重開機後 GitLab 自動恢復(`restart: always`)
- [ ] 每日備份排程已建立,`gitlab-secrets.json` 另有保存
- [ ] 主機 2 可 `docker login <主機1 IP>:5050`
- [ ] Runner `windows-runner` online;主機 2 重開機(不登入桌面)後,WSL、Docker 與 Runner 皆恢復
- [ ] `giga-api-gateway-bff` 第一條 Pipeline 的 `check` 階段通過
