# 開發說明

## 程式結構

畫面（`index.html`、`js/app.js`、`css/style.css`）一律呼叫 `api('/api/...')` 取資料。
`api()` 不走網路，而是交給 `js/server/router.js`，由瀏覽器裡的 handler 回應：

| 模組（js/server） | 負責 |
| --- | --- |
| `db.js` | 記憶體資料表 + localStorage、待同步紀錄 |
| `router.js` + 各模組的 `route()` | `/api` 路由 |
| `util.js` | 共用的請求解析、回應、日期與數字格式 |
| `ledger.js` | 自有帳戶交易的 FIFO 重播（持倉、已實現損益） |
| `stocks.js` | 持倉、交易、股票快照 |
| `assets.js` / `expenses.js` / `dividends.js` / `managed.js` / `settings.js` / `reports.js` / `llm.js` / `export.js` | 各功能頁 |
| `twr.js` / `twr_calc.js` / `performance.js` / `datacheck.js` | 投資績效（TWR / XIRR）與資料檢查 |
| `market.js` | 報價、匯率、歷史股價、股利歷史 |
| `aiimport.js` | AI 匯入：產生只有格式說明的提示詞、寬鬆解析 AI 回覆、預覽與判斷重複、整批寫入 |

## 資料與同步

- `db.js` 的 `SCHEMA` 定義每張表的欄位型別；`synced: true` 的表同步到試算表，`price_history*` 只是本機快取
- 每次寫入先存 localStorage 並記為待同步（`pending`），之後：讀整份試算表 → 以列為單位套上本機的修改（最後寫入者勝）→ 寫回有變動的分頁
- 新增列的 id 以時間產生（`Date.now()*10+亂數`），兩台裝置離線新增不會撞號；匯入的舊 id 保留，外鍵（`account_id`）不用轉換
- 列的身分：多數表用 `id`，`stock_holdings` 用 `symbol`，`settings` 用 `key`，`budgets` 用 `年-月`
- 分頁用固定 sheetId 辨識（`js/cloud/sheets.js` 的 `SHEET_IDS`，只能新增不能改號），使用者改分頁名稱不會壞；欄位依標題名稱對應
- 寫入分頁時先覆寫、再清掉多出來的尾巴，寫到一半失敗也不會留下空分頁
- 只存在本機、不同步的設定：`gemini_api_key`、`yahoo_proxy_url`（`db.LOCAL_SETTINGS`）

## AI 匯入

流程：勾選種類 → 產生提示詞（只有格式說明，不含使用者資料）→ 用 `chatgpt.com/?q=` / `claude.ai/new?q=` 開啟或複製 →
使用者在 AI 那邊貼上自己的資料或截圖 → 把回覆貼回來 → `/api/ai-import/parse` 預覽 → `/api/ai-import/commit` 寫入。

回覆格式是一個外框分區：`{ "format": "finance-watcher-import", "version": 1, "expenses": [...] }`。
新增一種可匯入的資料（股票交易、股利、資產快照…）只要在 `aiimport.js` 的 `KINDS` 登記一項
（`label`、`example`、`prompt()`、`normalize()`、`key()`、`existing()`、`insert()`），
再在 `app.js` 的 `renderImportSection()` 補上預覽表格。

舊的「AI 對話紀錄」已停用；`llm_conversations` 表只為了把刪除同步到試算表而保留。

## 行情

Yahoo Finance 沒有 CORS，瀏覽器不能直接呼叫。`market.js` 的所有請求都是 Yahoo chart API，經過代理轉送：

1. Cloudflare 後台 → Workers → 建立 → 貼上 `worker/yahoo-proxy.js` → 部署
2. 把 `ALLOWED_ORIGINS` 改成自己的 GitHub Pages 網域
3. 網址填進 `js/config.js` 的 `DEFAULT_YAHOO_PROXY`（使用者也可在設定頁覆寫）

沒有代理時：即時報價與 USD/TWD 匯率改用試算表 `quotes` 分頁的 `GOOGLEFINANCE` 公式（需登入）；
投資績效、股利建議、資料檢查的漏記股利項目無法使用，會顯示說明。

## Google Cloud 設定

1. 建立專案，啟用 **Google Sheets API** 與 **Google Drive API**
2. OAuth 同意畫面：外部；範圍 `drive.file`、`openid`、`userinfo.email`（都是非敏感範圍）
3. 憑證 → OAuth 用戶端 ID → 網頁應用程式；已授權的 JavaScript 來源：`https://<帳號>.github.io`、`http://localhost:8000`
4. 用戶端 ID 填進 `js/config.js` 的 `CLIENT_ID`
5. 只給自己用可以停在「測試中」並把自己加為測試使用者；要公開需要隱私權政策頁再改成「正式版」

## 本機開發

```sh
python -m http.server 8000   # ES modules 必須透過 HTTP 載入
node --test                  # 單元測試（FIFO、TWR、代管帳戶、股利估算、收支統計、AI 匯入）
```

改了 `js/` 底下的檔案清單時，記得同步 `sw.js` 的 `SHELL` 並把 `VERSION` 加一。

更新提示（「有新版本可用」）見 `js/update.js` 開頭說明，不用手動改版本號。

## 安全：CSP 與 SRI

`index.html` 開頭的 Content-Security-Policy 限制網頁只能連到列出的網域，就算有惡意程式碼混進來也很難把資料送出去。

- 新增外部服務（換 Yahoo 代理網址、加新 API）時，要同步更新 `connect-src`，不然請求會被瀏覽器擋下來。設定頁自訂的代理網址也一樣受限制
- Chart.js 有加 `integrity`（SRI）。升級版本時要重新算雜湊，並和 npm 官方套件比對：
  `curl -sL <網址> | openssl dgst -sha384 -binary | openssl base64 -A`
- 要用 `dist/chart.umd.js`。4.4.1 的 npm 套件裡沒有 `chart.umd.min.js`，那個檔案是 jsdelivr 即時產生的，雜湊不保證固定

## 部署

推到 GitHub 後，在倉庫 Settings → Pages 選擇從 `main` 分支根目錄發布。

## 待辦

- [x] 建 OAuth 用戶端 ID，填進 `js/config.js`（專案 finance-watcher-513403）
- [x] 部署 Yahoo 代理（`cd worker && npx wrangler deploy`），填進 `js/config.js` 的 `DEFAULT_YAHOO_PROXY`
- [ ] 隱私權政策頁（OAuth 正式版需要）
- [x] PNG 圖示（`apple-touch-icon` 180、192／512、maskable 512，由 `icons/icon.svg` 轉出）
- [ ] 確認 `GOOGLEFINANCE` 查得到所有持股（部分台股 ETF 可能沒有）
- [ ] 手機版：寬表格目前是橫向捲動，可再改成卡片式
