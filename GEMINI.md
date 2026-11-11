# GEMINI.md

> 本檔只負責把 Gemini CLI 導向本專案的 `AGENT.md`;規則一律寫在 `AGENT.md`,不要在這裡另寫。

**Gemini 的分工(必守)**:負責前端的頁面與元件(畫面、版面、樣式、互動、mock 資料,以及這些頁面的元件測試)、寫需求企劃(`docs/PRD.md`、功能企劃、Gherkin 驗收場景),以及執行測試、撰寫測試報告(`docs/test-reports/YYYY-MM-DD-<主題>.md`)。後端程式、前端邏輯層(`composables/`、`api/`、狀態、路由、權限判斷)、架構與技術文件由 Claude 負責;**不能動 CI/CD、Docker、部署設定**。細則見 `AGENT.md` 的「AI 分工(Claude / Gemini)」。

@./AGENT.md
