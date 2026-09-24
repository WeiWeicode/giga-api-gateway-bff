# GigaNexus Gateway — 既有專案參考

> 記錄公司既有專案中**已在正式環境驗證過**的做法,作為 Gateway 實作與備案的依據。
> 對應 PRD 版本:**v0.4**(2026-09-24)。本文件**不記錄任何帳密、主機位址或連線字串**,實際值以各專案的 secret / 環境變數為準。

---

## 1. GeneralBackend(Notes 系統後端)

| 項目 | 內容 |
| --- | --- |
| 位置 | `D:\檔案分享\程式碼\GeneralBackend\backend` |
| 用途 | `notesapp` 後端(選單 / 分頁權限、登入紀錄)、BPM 組織人員查詢、AD 帳密驗證 |
| 技術 | Express 5、**Sequelize 6**、**mssql 12(tedious 18)**、**activedirectory2**、jsonwebtoken、cookie-parser、cors |
| 部署 | Docker(`node:alpine` + pm2),port `5123` |
| 操作手冊 | 同目錄 `NotesSqlBackend操作手冊.md`、`NotesVueSql操作手冊.md` |
| 與 Gateway 的關係 | ① 提供 SQL Server 2012 與 AD 的已驗證連線方式(本文件 §1.1、§1.3);② BPM 人員欄位對應來源(§1.2);③ 本身為 PRD §7.2.4 待遷移的既有系統(IMPL-PLAN P2-8) |

### 1.1 SQL Server 2012 連線(已驗證)

`config/acc.js` 的 `WebAppDbConfig` 以 Sequelize 連線 SQL Server 2012,重點設定:

```js
new Sequelize(database, username, password, {
  dialect: 'mssql',
  host,
  define: { timestamps: false },
  dialectOptions: {
    options: { encrypt: false },   // tedious 實際讀取的是 options.encrypt
  },
  logging: false,
})
```

- **已證明**:目前的 Node.js(`node:alpine`)+ tedious 18 在 `encrypt: false` 下可穩定連線 SQL Server 2012 RTM,與 [DATABASE.md](DATABASE.md) §0「內網不加密」決策一致。
- Gateway 的 W3-1 PoC 以此組連線參數為**基準設定**;Drizzle 與 Kysely 底層同為 tedious,連線層行為應相同,PoC 重點放在 ORM 產生的 SQL 與 2012 的相容性。
- **備案(第三條路)**:若 Drizzle 與 Kysely 在 2012 上都無法通過 PoC,改用本專案已驗證的 **Sequelize 6 + mssql/tedious** 組合(見 [TECH-STACK.md](TECH-STACK.md) §4)。

### 1.2 BPM(EFGP)人員與組織查詢(已驗證)

`controllers/GeneralControlle.js` 以 `mssql` 直接查詢 BPM 資料庫(SQL Server 2019)的 EFGP 組織資料表,可作為 [DATABASE.md](DATABASE.md) §8.2 BPM 欄位對應的依據(PRD Q9):

| 資料 | BPM 來源 | 說明 |
| --- | --- | --- |
| 工號 | `dbo.Users.id` | 與 AD 帳號相同 |
| 姓名 | `dbo.Users.userName` | |
| Email | `dbo.Users.mailAddress` | |
| 部門代碼 / 名稱 | `dbo.OrganizationUnit.id` / `organizationUnitName` | 經 `dbo.Functions`(任職)連到人員 |
| 職稱 | `dbo.FunctionDefinition.functionDefinitionName` | `Functions.definitionOID` |
| 職級 | `dbo.FunctionLevel.levelValue` | `Functions.approvalLevelOID`(使用者提供的完整查詢另 JOIN 此表) |
| 組織(公司) | `dbo.Organization.organizationName` | `OrganizationUnit.organizationOID` |
| 主要任職 | `dbo.Functions.isMain = 1` | 一人多職時只取主要部門 |
| 在職 | `dbo.Users.leaveDate IS NULL` | 有值即離職 |
| 直屬主管 | `Functions.specifiedManagerOID`(指定主管)優先,否則 `OrganizationUnit.managerOID`;**若主管就是本人**,改取上層單位主管(`superUnitOID`),再不行取上上層 | 查詢邏輯見該檔案 `主管工號` 欄位的 CASE 運算式 |

- 既有查詢以 `OFFSET … FETCH` 分頁,並使用參數化查詢(`request.input`)。
- Gateway 建議請 BPM 負責人把上述 JOIN 與主管邏輯包成**唯讀 view**(例如 `dbo.vw_gn_employee`),Gateway 只讀 view,不直接依賴 EFGP 內部資料表。

### 1.3 AD 驗證(已驗證)

`controllers/ADcontroller.js` 以 `activedirectory2` 驗證帳密,顯示公司實際上有**多個 AD 網域**:

| 識別名稱 | UPN 尾碼 | 說明 |
| --- | --- | --- |
| 碩禾 | `@gsc.com.tw` | 舊網域;驗證失敗時自動改試「碩禾_新」 |
| 碩禾_新 | `@gsmc.com.tw` | 新網域 |
| 鹽城碩禾 | `@ygdmc.gsc.com.tw` | 子公司網域 |

- 登入時由使用者選擇網域(`adserver` 參數),以 `帳號@網域` 的 UPN 形式 bind 驗證。
- 各網域各有一組服務帳號與 baseDN(存於環境變數)。
- 目前連線為 **`ldap://`(未加密)**,與 PRD §8.2.1「僅允許 LDAPS / StartTLS」不同,PRD Q12 已決定:過渡期沿用 `ldap://`(已取得主管與工程師同意,2026-09-24),W2 為網域控制站補發憑證後改為 LDAPS。
- Gateway 據此調整:三個網域全部納入(PRD Q11),支援多網域設定與「舊網域失敗改試新網域」的順序;無網域子公司改用本機帳號(PRD §8.2.5)。

### 1.4 不沿用的做法

| 既有做法 | 原因 | Gateway 做法 |
| --- | --- | --- |
| 每次請求 `sql.connect(...)` 建立連線 | 高併發時連線數失控 | 每個資料庫一個長期連線池([TECH-STACK.md](TECH-STACK.md) §4) |
| CORS 允許跨來源並攜帶 Cookie | Gateway 為同網域,不需要 CORS | 同網域 + httpOnly Cookie + CSRF([FRONTEND-GUIDE.md](FRONTEND-GUIDE.md)) |
| `jsonwebtoken` 對稱金鑰 | 下游服務需持有同一把密鑰才能驗證 | ES256 非對稱金鑰 + JWKS(PRD §8.2.2) |
| `activedirectory2` | 其底層 `ldapjs` 已停止維護 | `ldapts`(PRD §8.2.1) |
| `ldap://` 未加密 | 帳密以明文傳輸 | 過渡期沿用 `ldap://`(Q12),補發憑證後改 LDAPS / StartTLS |
| 帳密放在 `.env` | 容易誤入映像檔或版控 | Docker secret / 受保護的 CI 變數 |

---

## 2. 舊單一入口(PortalSolar)

| 項目 | 內容 |
| --- | --- |
| 原始碼位置 | `S:\S1800\04程式備份\PortalSolar`(ASP.NET WebForms)。**此為兩三年前的備份,現行正式版本不在 NAS 上,內容可能已不同** |
| 資料庫 | `PortalSolar`(與 LOS 同一台 SQL Server 2012),帳號表 `LoginData` |
| 使用時機 | 員工沒有 AD 帳號時,改以資料庫帳密驗證 |

### 2.1 帳密驗證(`App_Code/GSCLib.cs`)

- `Login.AccoutCheck`:以 `PID`(工號)查 `LoginData`,將輸入密碼經 `Cipher.Encrypt` 加密後與 `PNum` 比對。
- `Cipher.Encrypt`:`MD5(UTF8(金鑰字串 + 伺服器常數))` 的前 8 bytes 為 DES 金鑰、後 8 bytes 為 IV;DES-CBC、PKCS7 填補;輸出 Base64。常數字串不在本文件記錄。
- 驗證時**不檢查** `Certify`。Gateway 據此移植比對邏輯([DATABASE.md](DATABASE.md) §9.1)。

### 2.2 舊註冊與忘記密碼

- `LoginNewAccount.aspx.cs`(註冊):需工號 + **身分證字號**,與 `LOS.dbo.EmployeeInfo` 比對;以 AD 查詢,已有 AD 帳號者不可申請;已有 `LoginData` 者不可重複申請。建立時 `Certify` 固定為 `NoPass`。
- `ForgetPassword.aspx.cs`(忘記密碼):解密 `PNum` 取得原密碼;LOS 有 Email 時寄送,**沒有 Email 時直接顯示在畫面上**。

### 2.3 安全問題(依備份原始碼,Gateway 不沿用)

| 問題 | 位置 | 影響 |
| --- | --- | --- |
| 「確認密碼」以**明文**寫入 `LoginData.EName` | `LoginNewAccount.aspx.cs`(`EName` 輸入框為密碼欄位) | 可讀取該表的人都能看到舊註冊者的密碼 |
| 忘記密碼時解密並**顯示原密碼** | `ForgetPassword.aspx.cs` | 知道工號並通過檢查者可看到他人密碼 |
| 可逆加密(DES),金鑰寫在程式中 | `GSCLib.cs` | 持有原始碼即可還原所有 `PNum` |
| SQL 以字串串接組成 | `AccoutCheck`、註冊、忘記密碼 | SQL injection 風險 |

- 處理方式(PRD Q22):**舊系統不修改**;Gateway 不讀取 `EName`,將所有舊密碼視為已外洩,遷移後強制設定新密碼(PRD §8.2.5);舊系統隨功能轉移逐步關閉。

### 2.4 單一登入(`EipLogin.aspx`)

- **接收端**:`EipLogin.aspx.cs` 從 QueryString 取 `UserID`、`Time`,以共用金鑰(單 DES,Key 與 IV 相同,十六進位字串)解密;時間超過 10 分鐘即拒絕;通過後查 ERP / EasyFlow GP 建立 Session。
- **發送端**:舊入口網登入後以相同方式加密工號與時間,導向 MBO、PRS 季考核、年終考核、福委會等系統的 `EIPLogin.aspx`(`Site.master.cs`、`Site_Mobile.master.cs`、`MainFormX.aspx.cs`)。
- Gateway **不提供**相容連結(PRD Q21):新舊入口並行,使用者仍由舊入口進入尚未轉移的子系統;功能轉移約 7 成後,舊系統逐步關閉已轉移的功能。此機制無完整性驗證且金鑰共用,Gateway 不持有其金鑰。
