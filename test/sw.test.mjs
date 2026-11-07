import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

// sw.js precaches SHELL with cache.addAll, which fails the whole install if one file is missing.
const root = new URL('../', import.meta.url);
const shell = [...readFileSync(new URL('sw.js', root), 'utf8').match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('sw.js SHELL: every entry exists', () => {
  for (const f of shell.filter((f) => f !== './')) assert.ok(existsSync(new URL(f, root)), `${f} is in SHELL but missing`);
});

test('sw.js SHELL: lists every script', () => {
  const scripts = ['js', 'js/cloud', 'js/server'].flatMap((d) =>
    readdirSync(new URL(d, root)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`));
  for (const f of scripts) assert.ok(shell.includes(f), `${f} is missing from SHELL`);
});
