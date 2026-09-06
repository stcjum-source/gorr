import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '..', 'assets.html'), 'utf8');

assert.match(html, /function normalizePortfolios\(/, 'persisted portfolio data is not normalized');
assert.match(html, /\^\[A-Za-z0-9_-\]/, 'portfolio IDs are not restricted before inline use');
assert.match(html, /\^#\[0-9a-fA-F\]\{6\}\$/, 'portfolio colors are not validated');
assert.match(html, /if\(S\.view==='history'\).*hidden=true/, 'portfolio scope remains visible on all-assets history');
assert.match(html, /if\(v==='history'\)S\.portfolioId='all'/, 'history does not reset to all-assets scope');
assert.match(html, /expectedPriced/, 'daily return completeness is not tracked');
assert.match(html, /priced!==expectedPriced/, 'partial daily returns are still displayed');
assert.match(html, /nameEl\.textContent=p\.name/, 'portfolio names are not rendered with textContent');
assert.match(html, /option\.textContent=p\.name/, 'portfolio option names are not rendered with textContent');
assert.match(html, /titleEl\.replaceChildren\(\)/, 'title container still accepts generated HTML');
assert.match(html, /subtitleEl\.textContent=subtitle/, 'portfolio subtitle is not rendered with textContent');
assert.doesNotMatch(html, /titleEl\.innerHTML/, 'portfolio subtitle still uses innerHTML');

console.log('✓ portfolio security, history scope, complete-return, and text rendering guards are present');
