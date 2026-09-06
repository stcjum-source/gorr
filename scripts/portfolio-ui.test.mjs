import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '..', 'assets.html'), 'utf8');
const checks = [];
const test = (name, fn) => checks.push({ name, fn });
const has = (pattern, message) => assert.match(html, pattern, message);

test('adds a global portfolio scope without replacing existing navigation', () => {
  has(/id="portfolioScope"/, 'portfolio scope is missing');
  has(/function renderPortfolioScope\(/, 'portfolio scope renderer is missing');
  has(/setPortfolioScope\(/, 'portfolio scope selection is missing');
  has(/class="bottom-nav"/, 'existing navigation was removed');
});

test('legacy assets fall back to the protected default portfolio', () => {
  has(/DEFAULT_PORTFOLIO_ID/, 'default portfolio constant is missing');
  has(/function itemPortfolioId\(item\)/, 'legacy fallback helper is missing');
  has(/safePortfolioId\(item\?\.portfolioId\)\|\|DEFAULT_PORTFOLIO_ID/, 'legacy fallback is missing');
  has(/기본 포트폴리오는 삭제할 수 없어요/, 'default deletion guard is missing');
});

test('totals and holdings use the selected portfolio assets', () => {
  has(/function scopedAssets\(/, 'scope filter helper is missing');
  has(/function calcTotals\(assets=scopedAssets\(\)\)/, 'totals are not scope-aware');
  has(/const assets=scopedAssets\(\)/, 'holdings are not scope-aware');
});

test('asset forms assign and move assets between portfolios', () => {
  has(/id="fPortfolio"/, 'portfolio selector is missing from asset forms');
  has(/portfolioId:document\.getElementById\('fPortfolio'\)/, 'portfolio assignment is not saved');
});

test('portfolio management supports create edit and safe deletion', () => {
  has(/function openPortfolioManager\(/, 'portfolio manager is missing');
  has(/function savePortfolio\(/, 'portfolio save behavior is missing');
  has(/function deletePortfolio\(/, 'portfolio delete behavior is missing');
  has(/자산 자체는 삭제되지 않습니다/, 'safe deletion copy is missing');
  has(/portfolioAssetCount\(/, 'delete confirmation does not calculate moved assets');
});

test('daily return is recomputed from aggregate previous valuation', () => {
  has(/function portfolioDailyDelta\(/, 'aggregate daily delta calculator is missing');
  has(/previousTotal/, 'aggregate previous valuation is not calculated');
  has(/개별 수익률 평균이 아닌 합산 전일 평가액 기준/, 'calculation basis is not explained');
});

let failed = 0;
for (const { name, fn } of checks) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}\n  ${error.message}`); }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);
