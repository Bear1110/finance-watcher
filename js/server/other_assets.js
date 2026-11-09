// 其他資產 (a home, a car, 勞退, insurance cash value…): a value the user fills in now and then.
// Whether they count toward net worth is a setting (include_other_assets, on by default); each row can
// also be left out on its own (counted: 0), e.g. a property kept here for the record only.

import * as db from './db.js';
import { route } from './router.js';
import { badRequest, body, cmp } from './util.js';

/** The rows that count toward net worth (when the setting is on). */
export const countedRows = () => db.where('other_assets', (a) => a.counted !== 0);

/** Total of the counted rows (TWD), whatever the setting: what a snapshot records. */
export const otherAssetsTotal = () => countedRows().reduce((s, a) => s + (a.value || 0), 0);

/** Does net worth include 其他資產? */
export const includeOtherAssets = () => db.getSetting('include_other_assets') !== '0';

/** The 其他資產 total that counts toward net worth (0 when the setting is off). */
export const countedOtherAssets = () => (includeOtherAssets() ? otherAssetsTotal() : 0);

function decode(req) {
  const b = body(req);
  const a = { name: String(b.name ?? '').trim(), value: Number(b.value), note: String(b.note ?? '') };
  if (!a.name) throw badRequest('請填名稱');
  if (!(a.value >= 0)) throw badRequest('價值不可為負');
  a.updated = db.today();
  return a;
}

route('GET', '/api/other-assets', () => db.all('other_assets').sort((a, b) => b.value - a.value || cmp(a.name, b.name)));
route('POST', '/api/other-assets', (req) => db.insert('other_assets', decode(req)));
route('PUT', '/api/other-assets/{id}', (req) => {
  if (!db.update('other_assets', req.params.id, decode(req))) throw badRequest('找不到這筆資產');
  return { status: 'updated' };
});
// Ticking a row in or out isn't a new value: `updated` stays
route('PUT', '/api/other-assets/{id}/counted', (req) => {
  if (!db.update('other_assets', req.params.id, { counted: body(req).counted ? 1 : 0 })) throw badRequest('找不到這筆資產');
  return { status: 'updated' };
});
route('DELETE', '/api/other-assets/{id}', (req) => { db.remove('other_assets', req.params.id); return { status: 'deleted' }; });
