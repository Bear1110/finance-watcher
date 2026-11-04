// Google Sheets / Drive REST calls. One spreadsheet, one tab per synced table.
//
// Tabs are found by fixed sheetId, so a renamed tab keeps working. Columns are
// matched by header name, so reordering columns in the sheet is safe; columns
// the sheet lacks are appended on the right.

import { APP_PROPERTY, SPREADSHEET_TITLE } from '../config.js';
import { SCHEMA, SYNCED_TABLES } from '../server/db.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
export const SCHEMA_VERSION = 1;

// Stable ids: never renumber, only add.
export const SHEET_IDS = {
  settings: 1,
  asset_snapshots: 2,
  stock_transactions: 3,
  stock_holdings: 4,
  dividends: 5,
  expenses: 6,
  // 7: budgets, retired (年度收支計畫 removed; the tab stays as the user's archive)
  // 8: stock_snapshots, retired (the tab is the user's archive; never reuse the id)
  managed_accounts: 9,
  managed_snapshots: 10,
  managed_cash_movements: 11,
  // 12: llm_conversations, retired (never reuse the id)
};
export const QUOTES_SHEET_ID = 99;
// Ids of retired tables: their tabs may still be in the user's sheet as an archive, so a new
// table must never take one (ensureTabs would see the old tab and sync into it).
const RETIRED_SHEET_IDS = new Set([7, 8, 12]);
for (const id of [...Object.values(SHEET_IDS), QUOTES_SHEET_ID]) {
  if (RETIRED_SHEET_IDS.has(id)) throw new Error(`sheet id ${id} is retired, pick a new one`);
}
const QUOTES_TITLE = 'quotes';
const QUOTE_COLUMNS = ['symbol', 'ticker', 'price', 'prev_close', 'name', 'currency'];

// A cell holds at most 50,000 characters.
const MAX_CELL = 49000;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(token, url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error?.message || msg; } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  return res.status === 204 ? null : res.json();
}

const quoteTitle = (title) => `'${title.replace(/'/g, "''")}'`;

const columnsOf = (table) => Object.keys(SCHEMA[table].columns);

export async function fetchEmail(token) {
  const info = await api(token, 'https://www.googleapis.com/oauth2/v3/userinfo');
  return info.email;
}

async function findSpreadsheet(token) {
  const q = `appProperties has { key='${APP_PROPERTY.key}' and value='${APP_PROPERTY.value}' } and trashed = false`;
  const url = `${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`;
  const { files } = await api(token, url);
  return files[0]?.id ?? null;
}

const headerRow = (values) => ({
  values: values.map((v) => ({ userEnteredValue: { stringValue: v }, userEnteredFormat: { textFormat: { bold: true } } })),
});

function tabSpec(table) {
  return {
    properties: { sheetId: SHEET_IDS[table], title: table, gridProperties: { frozenRowCount: 1 } },
    data: [{ startRow: 0, startColumn: 0, rowData: [headerRow(columnsOf(table))] }],
  };
}

async function createSpreadsheet(token) {
  const sheet = await api(token, SHEETS, {
    method: 'POST',
    body: {
      properties: { title: SPREADSHEET_TITLE, locale: 'zh_TW', timeZone: 'Asia/Taipei' },
      sheets: SYNCED_TABLES.map(tabSpec),
    },
  });
  await api(token, `${DRIVE}/${sheet.spreadsheetId}`, {
    method: 'PATCH',
    body: { appProperties: { [APP_PROPERTY.key]: APP_PROPERTY.value } },
  });
  return sheet.spreadsheetId;
}

/** Spreadsheet serial date (days since 1899-12-30) → YYYY-MM-DD. */
function serialToDate(n) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);
}

function cellToValue(type, col, v) {
  if (v === '' || v === undefined || v === null) return undefined;
  // Someone typed a date into the sheet: Sheets turned it into a serial number.
  if (type === 'text' && typeof v === 'number' && /(^|_)date$/.test(col)) return serialToDate(v);
  if (type === 'text') return String(v);
  return v;
}

function valueToCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && v.length > MAX_CELL) return v.slice(0, MAX_CELL) + '…(truncated)';
  return v;
}

export class Spreadsheet {
  constructor(id, titles) {
    this.id = id;
    this.titles = titles; // sheetId -> title
    this.headers = {}; // table -> [header names] as last read
    this.rows = {}; // table -> rows holding data (header included), as last read
  }

  get url() {
    return `https://docs.google.com/spreadsheets/d/${this.id}/edit`;
  }

  range(table, a1 = '') {
    return quoteTitle(this.titles[SHEET_IDS[table]]) + (a1 ? `!${a1}` : '');
  }

  /** Add tabs that are missing (older sheet, or a tab the user deleted). Returns true if any. */
  async ensureTabs(token) {
    const missing = SYNCED_TABLES.filter((t) => !this.titles[SHEET_IDS[t]]);
    if (!missing.length) return false;
    const taken = new Set(Object.values(this.titles));
    const requests = missing.map((t) => ({
      addSheet: { properties: { sheetId: SHEET_IDS[t], title: taken.has(t) ? `${t}_${SHEET_IDS[t]}` : t, gridProperties: { frozenRowCount: 1 } } },
    }));
    await api(token, `${SHEETS}/${this.id}:batchUpdate`, { method: 'POST', body: { requests } });
    this.titles = await getSheetTitles(token, this.id);
    return true;
  }

  /** Read every synced tab: { table: [row objects] }. */
  async readAll(token) {
    const ranges = SYNCED_TABLES.map((t) => `ranges=${encodeURIComponent(this.range(t))}`).join('&');
    const data = await api(token, `${SHEETS}/${this.id}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`);
    const out = {};
    SYNCED_TABLES.forEach((table, i) => {
      const rows = data.valueRanges?.[i]?.values ?? [];
      const headers = (rows[0] ?? []).map((h) => String(h).trim());
      this.headers[table] = headers;
      this.rows[table] = rows.length; // the API drops empty trailing rows: this is the last used row
      const cols = SCHEMA[table].columns;
      out[table] = [];
      for (const row of rows.slice(1)) {
        if (!row.some((c) => c !== '' && c != null)) continue;
        const obj = {};
        headers.forEach((h, j) => {
          if (h in cols) {
            const v = cellToValue(cols[h], h, row[j]);
            if (v !== undefined) obj[h] = v;
          }
        });
        out[table].push(obj);
      }
    });
    return out;
  }

  /**
   * Rewrite whole tabs: { table: rows }. Rows are written over the old ones first
   * and only then is the leftover tail cleared, so a failure midway never leaves
   * a tab empty. Only rows that held data are cleared: a range past the grid is rejected.
   */
  async writeTables(token, byTable) {
    const data = [];
    const clears = [];
    for (const [table, rows] of Object.entries(byTable)) {
      const have = this.headers[table] ?? [];
      const headers = [...have, ...columnsOf(table).filter((c) => !have.includes(c))];
      this.headers[table] = headers;
      const values = [headers, ...rows.map((r) => headers.map((h) => valueToCell(r[h])))];
      data.push({ range: this.range(table, 'A1'), values });
      const old = this.rows[table] ?? 0;
      if (old > values.length) clears.push(this.range(table, `${values.length + 1}:${old}`)); // whole rows
    }
    if (!data.length) return;
    await api(token, `${SHEETS}/${this.id}/values:batchUpdate`, {
      method: 'POST',
      body: { valueInputOption: 'RAW', data },
    });
    if (clears.length) await api(token, `${SHEETS}/${this.id}/values:batchClear`, { method: 'POST', body: { ranges: clears } });
  }

  // ------------------------------------------------------------ GOOGLEFINANCE

  /**
   * Live quotes via GOOGLEFINANCE formulas in a 'quotes' tab (used when no Yahoo
   * proxy is configured). Returns { yahooSymbol: { price, prevClose, name, currency } }.
   */
  async quotes(token, symbols) {
    if (!this.titles[QUOTES_SHEET_ID]) {
      await api(token, `${SHEETS}/${this.id}:batchUpdate`, {
        method: 'POST',
        body: { requests: [{ addSheet: { properties: { sheetId: QUOTES_SHEET_ID, title: QUOTES_TITLE, gridProperties: { frozenRowCount: 1 } } } }] },
      });
      this.titles = await getSheetTitles(token, this.id);
    }
    const r = quoteTitle(this.titles[QUOTES_SHEET_ID]);
    const read = async () => (await api(token, `${SHEETS}/${this.id}/values/${encodeURIComponent(r)}?valueRenderOption=UNFORMATTED_VALUE`)).values ?? [];
    let rows = await read();
    const listed = new Set(rows.slice(1).map((x) => String(x[0])));
    const missing = symbols.filter((s) => !listed.has(s) && toGoogleTicker(s));
    if (missing.length || !rows.length) {
      const start = Math.max(rows.length, 1);
      const values = missing.map((s, i) => {
        const n = start + i + 1;
        return [s, toGoogleTicker(s),
          `=IFERROR(GOOGLEFINANCE(B${n},"price"),"")`,
          `=IFERROR(GOOGLEFINANCE(B${n},"closeyest"),"")`,
          `=IFERROR(GOOGLEFINANCE(B${n},"name"),"")`,
          `=IFERROR(GOOGLEFINANCE(B${n},"currency"),"")`];
      });
      await api(token, `${SHEETS}/${this.id}/values:batchUpdate`, {
        method: 'POST',
        body: {
          valueInputOption: 'USER_ENTERED',
          data: [{ range: `${r}!A1`, values: [QUOTE_COLUMNS] }, ...(values.length ? [{ range: `${r}!A${start + 1}`, values }] : [])],
        },
      });
      rows = await read();
      // Freshly written formulas can still be loading; give them a moment once.
      if (rows.slice(1).some((x) => missing.includes(String(x[0])) && !(Number(x[2]) > 0))) {
        await new Promise((res) => setTimeout(res, 2000));
        rows = await read();
      }
    }
    const out = {};
    for (const x of rows.slice(1)) {
      const sym = String(x[0] ?? '');
      if (!symbols.includes(sym)) continue;
      const price = Number(x[2]);
      if (!(price > 0)) continue;
      out[sym] = { price, prevClose: Number(x[3]) || 0, name: String(x[4] ?? ''), currency: String(x[5] ?? '') };
    }
    return out;
  }
}

/** Yahoo symbol → GOOGLEFINANCE ticker ('' when unsupported). */
export function toGoogleTicker(sym) {
  const m = sym.match(/^([A-Z0-9]+)=X$/);
  if (m) return `CURRENCY:${m[1]}`;
  if (sym.endsWith('.TW')) return `TPE:${sym.slice(0, -3)}`;
  if (sym.endsWith('.TWO')) return `TPEX:${sym.slice(0, -4)}`;
  if (sym.startsWith('^')) return '';
  return sym.replace('-', '.');
}

async function getSheetTitles(token, spreadsheetId) {
  const meta = await api(token, `${SHEETS}/${spreadsheetId}?fields=sheets.properties(sheetId,title)`);
  const titles = {};
  for (const s of meta.sheets) titles[s.properties.sheetId] = s.properties.title;
  return titles;
}

/**
 * Find (or create) the user's spreadsheet. cachedId comes from localStorage and
 * is re-searched when stale. Returns { sheet, created }.
 */
export async function openSpreadsheet(token, { cachedId }) {
  if (cachedId) {
    try {
      const sheet = new Spreadsheet(cachedId, await getSheetTitles(token, cachedId));
      await sheet.ensureTabs(token);
      return { sheet, created: false };
    } catch (e) {
      if (!(e instanceof ApiError) || ![403, 404].includes(e.status)) throw e;
    }
  }
  let id = await findSpreadsheet(token);
  let created = false;
  if (!id) { id = await createSpreadsheet(token); created = true; }
  const sheet = new Spreadsheet(id, await getSheetTitles(token, id));
  await sheet.ensureTabs(token);
  return { sheet, created };
}
