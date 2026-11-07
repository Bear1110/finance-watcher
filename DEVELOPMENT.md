# 開發說明

## 程式結構

畫面（`index.html`、`js/app.js`、`css/style.css`）一律呼叫 `api('/api/...')` 取資料。
`api()` 不走網路，而是交給 `js/server/router.js`，由瀏覽器裡的 handler 回應：

| 模組（js/server） | 負責 |
| --- | --- |
| `db.js` | 記憶體資料表 + localStorage、待同步紀錄 |
| `router.js` + 各模組的 `route()` | `/api` 路由 |
| `util.js` | 共用的請求解析、回應、日期與數字格式 |
| `ledger.js` / `lots.js` | 自有帳戶交易的 FIFO 重播（持倉、已實現損益）；`lots.js` 是批次規則，績效的逐日持有成本也用它 |
| `stocks.js` | 持倉、交易、已實現損益 |
| `assets.js` / `expenses.js` / `dividends.js` / `managed.js` / `settings.js` / `reports.js` / `llm.js` / `export.js` | 各功能頁 |
| `twr.js` / `twr_calc.js` / `performance.js` / `datacheck.js` | 投資績效（TWR / XIRR）與資料檢查 |
| `market.js` | 報價、匯率、歷史股價、股利歷史、ETF 前十大成分股 |
| `portfolio.js` / `lookthrough.js` | 組合分析：集中度、美元佔比；穿透持股（ETF 拆成分股，跟直接持有合併並記下來源） |
| `profile.js` | 關於你：使用者自填的財務狀況（存成一個 `profile` 設定；每月生活費仍是 `monthly_expense`），帶進 AI 提示詞；「股市大跌時」壓力測試（`/api/profile/stress`） |
| `aiimport.js` | AI 匯入（收支、股票交易、資產快照）：產生只有格式說明的提示詞、寬鬆解析 AI 回覆、預覽與判斷重複、整批寫入；過去日期的資產快照用績效序列補當天的股票市值與匯率 |

## 資料與同步

- `db.js` 的 `SCHEMA` 定義每張表的欄位型別；`synced: true` 的表同步到試算表，`price_history*` 只是本機快取
- 每次寫入先存 localStorage 並記為待同步（`pending`），之後：讀整份試算表 → 以列為單位套上本機的修改（最後寫入者勝）→ 寫回有變動的分頁
- 新增列的 id 以時間產生（`Date.now()*10+亂數`），兩台裝置離線新增不會撞號；匯入的舊 id 保留，外鍵（`account_id`）不用轉換
- 列的身分：多數表用 `id`，`stock_holdings` 用 `symbol`，`settings` 用 `key`
- 分頁用固定 sheetId 辨識（`js/cloud/sheets.js` 的 `SHEET_IDS`，只能新增不能改號），使用者改分頁名稱不會壞；欄位依標題名稱對應
- 寫入分頁時先覆寫、再清掉多出來的尾巴，寫到一半失敗也不會留下空分頁
- 收支可以記外幣（`expenses.js` 的 `EXPENSE_CURRENCIES`）：每筆存當天的市場匯率 `fx_rate`（`{幣別}TWD=X` 當日或前一個交易日收盤，可手動改），統計一律換算台幣；沒有 `fx_rate` 的舊美金紀錄用設定的 USD/TWD 匯率。離線時查不到匯率就先用同幣別最近一筆的匯率估算（`fx_pending=1`），之後有網路時 `/api/expenses/refresh-fx`（收支頁載入、恢復連線時）換成市場匯率；從沒記過的幣別離線時要手動填匯率。新增時預設上次用的幣別（本機 localStorage `expenseCurrency`）

## AI 匯入

流程：勾選種類 → 產生提示詞（只有格式說明，不含使用者資料）→ 用 `chatgpt.com/?q=` / `claude.ai/new?q=` 開啟或複製 →
使用者在 AI 那邊貼上自己的資料或截圖 → 把回覆貼回來 → `/api/ai-import/parse` 預覽 → `/api/ai-import/commit` 寫入。

回覆格式是一個外框分區：`{ "format": "finance-watcher-import", "version": 1, "expenses": [...] }`。
目前有收支（`expenses`）與股票交易（`transactions`）。新增一種（股利、資產快照…）只要在 `aiimport.js` 的 `KINDS`
登記一項（介面見檔案開頭說明），再在 `app.js` 的 `IMPORT_COLUMNS` 補上預覽欄位。

股票交易的特別處理：
- 分割：成交價約為當日（已還原分割的）收盤價整數倍時，視為分割前的交易，換算成分割後的股數與價格（需要行情代理）
- 賣出時持股不足（例如對帳單只涵蓋後面幾個月）：有損益金額就當「歷史損益」匯入（`pl_manual`，不扣持股），沒有就列為錯誤
- 已有「匯入持倉」建立的持股時提醒，避免實際買進再匯入一次造成重複
- 沒給手續費與稅的台股交易依設定的折扣估算
- 「以對帳單取代」（`mode: 'replace'`，`transactions.plan()`）：對帳單期間（AI 抄的查詢期間，沒有就用最早～最晚交易日）內，
  這次出現的股票的自有帳戶舊交易全部刪掉、換成對帳單；期間開始前的持股 = 目前持股 − 對帳單淨買進 − 留下來的交易淨買進，
  存成一筆匯入持倉（沿用舊匯入持倉的成本，沒有就用目前均價）。合計列對不上、有無法匯入的列、倒推出負數時不允許取代

停用的表（`budgets`、`stock_snapshots`、`llm_conversations`）已不在 `SCHEMA`，不再同步；試算表裡的舊分頁可以自行刪除。它們的 sheetId（7、8、12）列在 `sheets.js` 的 `RETIRED_SHEET_IDS`，新表不能再用。本機殘留的待同步紀錄在載入時略過。

## 行情

Yahoo Finance 沒有 CORS，瀏覽器不能直接呼叫。`market.js` 的請求經過代理轉送：大多是 Yahoo chart API（`/v8/finance/chart`），穿透持股另用 `quoteSummary` 的 `topHoldings`（`/v10/finance/quoteSummary`，Yahoo 要 cookie + crumb，由 Worker 代拿；只允許 `quoteType`、`topHoldings` 兩個模組）。Worker 改過要重新部署：

1. Cloudflare 後台 → Workers → 建立 → 貼上 `worker/yahoo-proxy.js` → 部署
2. 把 `ALLOWED_ORIGINS` 改成自己的 GitHub Pages 網域
3. 網址填進 `js/config.js` 的 `DEFAULT_YAHOO_PROXY`

沒有代理時：即時報價與 USD/TWD 匯率改用試算表 `quotes` 分頁的 `GOOGLEFINANCE` 公式（需登入）；
投資績效、股利建議、資料檢查的漏記股利項目、穿透持股無法使用，會顯示說明。部分台股 ETF 在 `GOOGLEFINANCE` 可能查不到報價（已知限制，平常走代理不受影響）。

## Google Cloud 設定

1. 建立專案，啟用 **Google Sheets API** 與 **Google Drive API**
2. OAuth 同意畫面：外部；範圍 `drive.file`、`openid`、`userinfo.email`（都是非敏感範圍）
3. 憑證 → OAuth 用戶端 ID → 網頁應用程式；已授權的 JavaScript 來源：`https://<帳號>.github.io`、`http://localhost:8000`
4. 用戶端 ID 填進 `js/config.js` 的 `CLIENT_ID`
5. 只給自己用可以停在「測試中」並把自己加為測試使用者；要公開時把 `privacy.html`、`terms.html`（英文版 `-en.html`）的網址填進 OAuth 同意畫面，再改成「正式版」。改了權限範圍或外部服務記得同步更新這兩頁

## 本機開發

```sh
python -m http.server 8000   # ES modules 必須透過 HTTP 載入
node --test                  # 單元測試（FIFO、TWR、代管帳戶、股利估算、收支統計、AI 匯入）
```

`sw.js` 的 `SHELL`（預先快取的檔案清單）有增減時把 `VERSION` 加一，例如新增或刪除 `js/` 底下的檔案、換圖示檔名。

網址（`https://bear1110.github.io/finance-watcher/`）寫死在：`index.html` 的 canonical 與 `og:*`、`worker/yahoo-proxy.js` 的 `ALLOWED_ORIGINS`、Google Cloud 的 OAuth 已授權來源。換網域或 repo 名稱時要一起改。

更新提示（「有新版本可用」）見 `js/update.js` 開頭說明，不用手動改版本號。

新手導覽：步驟在 `js/tour.js` 的 `TOUR_STEPS`，要框住的元素在 `index.html` 用 `data-tour` 標記。改版面時保留這些屬性，否則該步會改成畫面中央、沒有框。

## 安全：CSP 與 SRI

`index.html` 開頭的 Content-Security-Policy 限制網頁只能連到列出的網域，就算有惡意程式碼混進來也很難把資料送出去。

- 新增外部服務（換 Yahoo 代理網址、加新 API）時，要同步更新 `connect-src`，不然請求會被瀏覽器擋下來
- Chart.js 有加 `integrity`（SRI）。升級版本時要重新算雜湊，並和 npm 官方套件比對：
  `curl -sL <網址> | openssl dgst -sha384 -binary | openssl base64 -A`
- 要用 `dist/chart.umd.js`。4.4.1 的 npm 套件裡沒有 `chart.umd.min.js`，那個檔案是 jsdelivr 即時產生的，雜湊不保證固定

## 部署

推到 GitHub 後，在倉庫 Settings → Pages 選擇從 `main` 分支根目錄發布。

## 待辦

- [x] 建 OAuth 用戶端 ID，填進 `js/config.js`（專案 finance-watcher-513403）
- [x] 部署 Yahoo 代理（`cd worker && npx wrangler deploy`），填進 `js/config.js` 的 `DEFAULT_YAHOO_PROXY`
- [x] 隱私權政策頁與服務條款（`privacy.html`、`terms.html`（英文版 `-en.html`），OAuth 正式版需要）
- [x] Logo 與圖示（焦慮看盤小熊）：原圖在 `icons/src/`，用 `python tools/make-icons.py` 產生所有尺寸，分享預覽圖的模板是 `tools/og.html`（用法見腳本開頭）
