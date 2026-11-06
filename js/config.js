// 部署前必填：Google Cloud Console → API 和服務 → 憑證 → OAuth 2.0 用戶端 ID（網頁應用程式）
// 用戶端 ID 本來就會公開在前端；真正的保護是「已授權的 JavaScript 來源」設定。
// 留空時網站仍可用，資料只存在這台裝置的瀏覽器裡（不同步）。
export const CLIENT_ID = '568631908966-ovff6v05svkj614270d6q2a4l098o6r1.apps.googleusercontent.com';

// drive.file：只能存取本網站建立或使用者親自選取的檔案（非敏感權限）
// openid email：顯示目前登入的帳號
export const SCOPES = 'https://www.googleapis.com/auth/drive.file openid email';

// 標記在試算表的 Drive appProperties 上，用來找回網站建立的那份檔案
export const APP_PROPERTY = { key: 'financeWatcher', value: '1' };
export const SPREADSHEET_TITLE = 'Finance Watcher 財務紀錄';

// Yahoo Finance 不允許瀏覽器直接呼叫（沒有 CORS），行情要經過一個轉送代理。
// 部署 worker/yahoo-proxy.js 到 Cloudflare Workers 後把網址填在這裡（結尾不加斜線）。
// 留空時：即時報價與匯率改用 Google 試算表的 GOOGLEFINANCE（需登入），歷史股價相關功能（績效、股利建議）無法使用。
export const DEFAULT_YAHOO_PROXY = 'https://finance-watcher-yahoo.bearcc01205.workers.dev';
