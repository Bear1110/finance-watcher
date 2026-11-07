# Finance Watcher — 給 Claude 的工作準則

@DEVELOPMENT.md

上面是程式結構與規則（改 UI 前看「UI 準則」）。另外：

- 跟使用者溝通、介面文字、commit 訊息都用繁體中文；說明用白話，少用術語。
- 計算放在 `js/server/*`，`js/app.js` 只負責顯示；同一個數字只算一次，頁面和 AI 提示詞（`llm.js`）共用同一份計算。
- UI 改完用無頭 Edge 實際截圖確認，電腦寬度和手機 390px 各看一次。
- push 前先跑 `node --test`（含 `test/ui.test.mjs` 的 UI 規則）。
