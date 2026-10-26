import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

const filesUnder = (dir) =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [relative(root, join(root, dir, e.name))]);

test('the service worker precaches every app file, so the app works offline', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const precache = JSON.parse(`[${/const PRECACHE = \[([\s\S]*?)\];/.exec(sw)[1].replaceAll("'", '"').replace(/,\s*$/, '')}]`);
  const appFiles = ['index.html', 'manifest.webmanifest', ...['css', 'icons', 'js'].flatMap(filesUnder)].filter((f) => !f.endsWith('.DS_Store'));
  assert.deepEqual(precache.filter((f) => f !== './').sort(), appFiles.sort());
});
