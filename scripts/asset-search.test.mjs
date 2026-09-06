import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const html = readFileSync(resolve(root, 'assets.html'), 'utf8');
const catalogScriptPath = resolve(root, 'asset-symbols.js');

assert.match(html, /<script src="\.\/asset-symbols\.js/, 'standalone catalog script is not loaded');
assert.ok(existsSync(catalogScriptPath), 'asset-symbols.js is missing');
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(catalogScriptPath, 'utf8'), sandbox);
const items = sandbox.window.ASSET_SYMBOL_CATALOG?.items;
assert.ok(Array.isArray(items) && items.length > 1000, 'standalone catalog is empty');
assert.match(html, /window\.ASSET_SYMBOL_CATALOG/, 'catalog loader does not use standalone data');

const normalize = value => String(value || '').trim().toUpperCase().replace(/[\s._-]+/g, '');
const search = query => {
  const q = normalize(query).replace(/^KRW/, '');
  return items.filter(item => {
    const symbol = normalize(item.market || item.ticker).replace(/^KRW/, '');
    return symbol.includes(q) || normalize(item.name).includes(q) || normalize(item.englishName).includes(q) || (item.aliases || []).some(alias => normalize(alias).includes(q));
  });
};

for (const [query, bucket, symbol] of [
  ['삼성전자', 'stocks', '005930.KS'],
  ['Tesla', 'stocks', 'TSLA'],
  ['TSLA', 'stocks', 'TSLA'],
  ['TIGER', 'etf', null],
  ['QQQ', 'etf', 'QQQ'],
]) {
  const results = search(query).filter(item => item.bucket === bucket);
  assert.ok(results.length, `${bucket} search failed for ${query}`);
  if (symbol) assert.ok(results.some(item => item.ticker === symbol), `${query} did not return ${symbol}`);
}

assert.match(html, /직접 추가/, 'manual-add fallback is missing');
console.log('✓ standalone stock/ETF catalog supports Korean, English, ticker, and manual fallback');
