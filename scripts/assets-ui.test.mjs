import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '..', 'assets.html'), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

function declarations(text) {
  return Object.fromEntries(text.split(';').map(part => part.split(/:(.*)/s).slice(0, 2).map(value => value.trim())).filter(([property, value]) => property && value));
}
function palettes() {
  const roots = [...css.matchAll(/:root\s*\{([^{}]*)\}/g)].map(match => declarations(match[1]));
  return [roots[0], Object.assign({}, roots[0], roots[1])];
}
function computedStyle(selector) {
  const result = {};
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].split(',').map(value => value.trim()).includes(selector)) Object.assign(result, declarations(match[2]));
  }
  return result;
}
function resolveColor(value, variables) {
  const variable = value?.match(/^var\((--[\w-]+)\)$/)?.[1];
  return variable ? resolveColor(variables[variable], variables) : value;
}
function contrast(foreground, background) {
  const luminance = color => {
    let hex = color.slice(1);
    if (hex.length === 3) hex = [...hex].map(char => char + char).join('');
    const channels = hex.match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + .05) / (darker + .05);
}

const checks = [];
function test(name, fn) { checks.push({ name, fn }); }
function has(pattern, message) { assert.match(html, pattern, message); }

test('renders the approved mobile Monitor shell and total-asset hero', () => {
  has(/class="appbar"/, 'missing app bar');
  has(/class="hero"/, 'missing total asset hero');
  has(/class="hero-amount"[^>]*id="totalVal"/, 'hero must own the live total value');
  has(/class="sync-status"/, 'missing update/sync status');
});

test('renders allocation from live calcTotals values', () => {
  has(/function renderAllocation\(t\)/, 'missing allocation renderer');
  has(/renderAllocation\(t\)/, 'dashboard must render live allocation');
  has(/class="allocation"/, 'missing allocation card');
  has(/class="allocation-donut"/, 'missing allocation visualization');
  for (const key of ['t.crypto', 't.stocks', 't.etf', 't.cash']) has(new RegExp(key.replace('.', '\\.')), `allocation must use ${key}`);
});

test('provides four bottom navigation destinations including holdings', () => {
  has(/class="bottom-nav"/, 'missing fixed bottom navigation');
  for (const [view, label] of [['dashboard', '현황'], ['holdings', '보유자산'], ['history', '기록'], ['manage', '관리']]) {
    has(new RegExp(`setV\\('${view}'\\)[^>]*>[\\s\\S]{0,160}${label}`), `missing ${label} bottom-nav action`);
  }
  has(/S\.view==='holdings'/, 'holdings view is not routed');
});

test('keeps the former total-assets view accessible as a secondary action', () => {
  has(/setV\('total'\)/, 'former total-assets view is no longer accessible');
  has(/renderTotalAssets\(t\)/, 'former total-assets renderer must remain');
});

test('holdings search affordance is a native keyboard-accessible button', () => {
  has(/<button type="button" class="search-shell" onclick="setV\('manage'\)">/, 'holdings search must be a real button');
  assert.doesNotMatch(html, /<div class="search-shell"[^>]*role="button"/, 'scripted div button remains');
});

test('uses compact grouped holdings and history hierarchy', () => {
  has(/function renderHoldings\(t\)/, 'missing dedicated holdings renderer');
  has(/class="asset-group"/, 'missing grouped holding cards');
  has(/class="holding-row"/, 'missing compact holding rows');
  has(/function toggleHoldingGroup\(type\)/, 'missing holdings expand/collapse behavior');
  has(/S\.expandedHoldingGroups/, 'missing holdings expansion state');
  has(/items\.slice\(0,2\)/, 'collapsed groups must show only two items');
  has(/class="group-toggle"/, 'missing remaining-items toggle control');
  has(/나머지.*개 보기/, 'missing collapsed-group count label');
  has(/class="period-tabs"/, 'missing history period hierarchy');
  has(/class="chart-card"/, 'missing primary chart card');
  has(/class="record-list"/, 'missing history record list');
  has(/S\.showAllHistory/, 'missing compact history-list state');
  has(/const recent=S\.showAllHistory\?recentAll:recentAll\.slice\(0,5\)/, 'expanded history must show every record while collapsed shows five');
  assert.doesNotMatch(html, /showAllHistory\?40/, 'expanded history still has a hidden 40-record cap');
  has(/class="history-toggle"/, 'missing history expand/collapse control');
  has(/class="record-btn"[^>]*onclick="updatePrices\(true\)"[^>]*>오늘 자산 기록하기/, 'history CTA must record today through updatePrices(true)');
});

test('uses coherent semantic colors, dark mode, and 44px interactive targets', () => {
  has(/--green:\s*#[0-9a-f]{3,6}/i, 'missing semantic positive green');
  has(/--red:\s*#[0-9a-f]{3,6}/i, 'missing semantic negative red');
  has(/--blue:\s*#[0-9a-f]{3,6}/i, 'missing stock/currency blue');
  has(/\.up[^}]*color:\s*var\(--green\)/, 'positive state is not green');
  has(/\.dn[^}]*color:\s*var\(--red\)/, 'negative state is not red');
  has(/min-height:\s*44px/, 'interactive controls need a 44px minimum target');
  has(/@media\(prefers-color-scheme:dark\)\{:root\{[\s\S]*?--dock:/, 'redesigned app has no dark palette');
  has(/background:var\(--dock\)/, 'fixed navigation does not adapt to dark mode');
  has(/border-bottom:1px solid var\(--line\)/, 'card separators do not adapt to dark mode');
});

test('green CTA foreground meets WCAG AA contrast in light and dark palettes', () => {
  for (const selector of ['.btn-s', '.smart-add-btn', '.record-btn', '.setup-btn']) {
    const style = computedStyle(selector);
    for (const [index, variables] of palettes().entries()) {
      const ratio = contrast(resolveColor(style.color, variables), resolveColor(style.background, variables));
      assert.ok(ratio >= 4.5, `${selector} ${index ? 'dark' : 'light'} contrast is ${ratio.toFixed(2)}:1`);
    }
    assert.equal(style.color, 'var(--on-green)', `${selector} must use --on-green`);
  }
});

test('explains setup-code purpose and validation rules clearly', () => {
  has(/가계부와 같은 공유 코드/, 'setup copy must explain cross-app sharing');
  has(/3~20자/, 'setup copy must state the allowed length');
  has(/영문.*숫자/, 'setup copy must explain allowed characters');
  has(/pattern="\[A-Za-z0-9_-\]\{3,20\}"/, 'setup input must expose the validation rule');
});

test('preserves core data and feature integrations', () => {
  for (const token of ['firebase.initializeApp', 'updatePrices(', 'PRICE_CACHE_KEY', 'smartSearchAssets', 'saveItem()', 'delItem(', 'renderHistory(', 'renderTotalAssets(']) {
    assert.ok(html.includes(token), `core feature missing: ${token}`);
  }
});

let failed = 0;
for (const { name, fn } of checks) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (error) { failed += 1; console.error(`✗ ${name}\n  ${error.message}`); }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);
