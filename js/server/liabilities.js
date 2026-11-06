// 負債 (mortgage, loans): remaining principal, updated now and then. Net worth subtracts the total.

import * as db from './db.js';
import { route } from './router.js';
import { badRequest, body, cmp } from './util.js';

/** Total remaining principal (TWD). */
export const liabilitiesTotal = () => db.all('liabilities').reduce((s, l) => s + (l.balance || 0), 0);

function decode(req) {
  const b = body(req);
  const l = { name: String(b.name ?? '').trim(), balance: Number(b.balance), note: String(b.note ?? '') };
  if (!l.name) throw badRequest('請填名稱');
  if (!(l.balance >= 0)) throw badRequest('剩餘本金不可為負');
  l.updated = db.today();
  return l;
}

route('GET', '/api/liabilities', () => db.all('liabilities').sort((a, b) => b.balance - a.balance || cmp(a.name, b.name)));
route('POST', '/api/liabilities', (req) => db.insert('liabilities', decode(req)));
route('PUT', '/api/liabilities/{id}', (req) => {
  if (!db.update('liabilities', req.params.id, decode(req))) throw badRequest('找不到這筆負債');
  return { status: 'updated' };
});
route('DELETE', '/api/liabilities/{id}', (req) => { db.remove('liabilities', req.params.id); return { status: 'deleted' }; });
