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
        .replace(/<span class="legend-item">[\s\S]*?<\/span>[^<]*<\/span>/g, ''); // legend: dot + label
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

test('UI: modals are native <dialog>s (Esc, focus kept inside, page behind inert)', () => {
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/<(\w+)\b[^>]*class="[^"]*\bmodal-overlay\b/g)) {
      assert.equal(m[1], 'dialog', `${file}:${lineOf(src, m.index)} modal-overlay on a <${m[1]}>: use <dialog class="modal-overlay"> with openModal/closeModal`);
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

test('UI: bright blue only for small things; big blue areas use the calm blue (--accent-fill / --accent-tint)', () => {
  const css = readFileSync(new URL('css/style.css', root), 'utf8');
  for (const m of css.matchAll(/(background(?:-color)?|accent-color)\s*:\s*var\(--accent(?:-hover)?\)/g)) {
    assert.fail(`css/style.css:${lineOf(css, m.index)} ${m[0]}: use var(--accent-fill) (solid, white text) or var(--accent-tint) (primary button)`);
  }
  for (const [file, src] of sources) {
    const m = src.match(/background(?:-color)?\s*:\s*var\(--accent(?:-hover)?\)/);
    assert.ok(!m, `${file}:${m && lineOf(src, m.index)} ${m?.[0]}: use var(--accent-fill)`);
  }
});

test('UI: tables are phone lists (.m-list) or grids that scroll sideways on purpose (.scroll-grid)', () => {
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/<table\b([^>]*)>/g)) {
      if (/\b(m-list|scroll-grid)\b/.test(m[1])) continue;
      assert.fail(`${file}:${lineOf(src, m.index)} <table> without class="m-list" (data-m on the headers) or "scroll-grid" (a matrix)`);
    }
  }
});

test('app.js: no two top-level functions or consts share a name (a classic script: the later one silently replaces the first)', () => {
  const src = readFileSync(new URL('js/app.js', root), 'utf8');
  const seen = new Map();
  for (const m of src.matchAll(/^(?:async\s+)?(?:function\*?\s+|const\s+|let\s+)([A-Za-z_$][\w$]*)/gm)) {
    const line = lineOf(src, m.index);
    assert.ok(!seen.has(m[1]), `js/app.js:${line} ${m[1]} is already defined at line ${seen.get(m[1])}`);
    seen.set(m[1], line);
  }
});
