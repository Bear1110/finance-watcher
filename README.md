# <img src="icons/logo-64.png" width="40" height="40" alt="" align="top"> Finance Watcher

個人財務記錄網站：資產快照、台股／美股持倉與交易（FIFO 已實現損益）、股利、收支（可記外幣）、代管帳戶、投資績效（TWR / XIRR）、AI 分析。

純靜態網頁（GitHub Pages）、沒有後端，紀錄存在**你自己 Google 雲端硬碟的試算表**，網站作者看不到任何人的資料。

## 怎麼開始

1. 打開網站（部署後的 GitHub Pages 網址）
2. 「設定 → 雲端同步與資料 → 用 Google 登入」：第一次登入會在你的雲端硬碟建立「Finance Watcher 財務紀錄」試算表
3. 換裝置或還原時：「設定 → 下載備份」取得 JSON，再到「設定 → 匯入資料」選這個檔案（會取代目前資料）

手機可以「加到主畫面」，用起來像 App。沒登入也能用，資料只存在那台裝置的瀏覽器。

## 架構

```
瀏覽器
 ├─ js/app.js            畫面與互動，透過 api('/api/...') 取資料
 ├─ js/server/*.js       各功能的 handler；router.js 在瀏覽器裡回應 /api 路由（不走網路）
 │   └─ db.js            記憶體中的資料表 + localStorage，變更記為待同步
 ├─ js/cloud/            Google 登入（GIS token model）與試算表同步
 │   └─ Sheets API ───── 使用者的試算表：一張資料表 = 一個分頁
 └─ 行情 ─┬─ Yahoo 代理（worker/yahoo-proxy.js，Cloudflare Worker）
          └─ 沒有代理時：試算表 quotes 分頁的 GOOGLEFINANCE（只有即時價與匯率）
```

詳見 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 你的資料

- 紀錄只存在你自己的 Google 試算表（權限 `drive.file`：網站只能存取它自己建立的那份檔案）
- Gemini API Key 與行情代理網址只存在各自裝置的瀏覽器，不會寫進試算表
- 行情代理只轉送股票代號與日期範圍，不經手任何金額或紀錄
- 完整說明見[隱私權政策](privacy.html)與[服務條款](terms.html)
