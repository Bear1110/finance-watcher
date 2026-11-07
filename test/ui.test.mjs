import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// DEVELOPMENT.md › UI 準則, checked over index.html and the HTML that js/app.js builds.
const root = new URL('../', import.meta.url);
const sources = ['index.html', 'js/app.js'].map((f) => [f, readFileSync(new URL(f, root), 'utf8')]);
const lineOf = (src, i) => src.slice(0, i).split('\n').length;

test('UI: a card header holds the title (with meta) and controls, no loose text', () => {
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/class="card-header">([\s\S]*?)<\/div>\s*\n/g)) {
      // Everything after the title: only controls (header-actions, toggles, buttons, legends)
      const rest = m[1].replace(/<h3[\s\S]*?<\/h3>/, '');
      // Text inside buttons, toggles, legends and filters is fine: check only the header's own children
      const own = rest.replace(/<(button|select|label|a)\b[\s\S]*?<\/\1>/g, '')
        .replace(/<span class="legend-item">[\s\S]*?<\/span>[^<]*<\/span>/g, '') // legend: dot + label
        .replace(/<span class="filter-sep">[^<]*<\/span>/g, ''); // the ~ between two dates
      const text = own.match(/<small\b|<p\b/) || own.replace(/<[^>]+>/g, '').replace(/\$\{[^}]*\}/g, '').trim();
      assert.ok(!text, `${file}:${lineOf(src, m.index)} card header has text outside the title: ${String(text).slice(0, 40)}`);
    }
  }
});

test('UI: a select with a few fixed options is shown as buttons (data-segmented)', () => {
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const options = (m[2].match(/<option\b/g) || []).length;
      if (!options || options > 5 || /data-(segmented|keep-select)\b/.test(m[1])) continue;
      assert.fail(`${file}:${lineOf(src, m.index)} <select> with ${options} options: add data-segmented (or data-keep-select)`);
    }
  }
});

test('UI: hints use form-hint with card-hint / chart-note, no inline margins or one-off *-hint classes', () => {
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/class="([^"]*\bform-hint\b[^"]*)"\s+style=/g)) {
      assert.fail(`${file}:${lineOf(src, m.index)} form-hint with an inline style: use card-hint or chart-note`);
    }
    for (const m of src.matchAll(/class="[^"]*\b([\w-]+-hint)\b/g)) {
      assert.ok(['form-hint', 'card-hint'].includes(m[1]), `${file}:${lineOf(src, m.index)} one-off hint class ${m[1]}`);
    }
  }
});
