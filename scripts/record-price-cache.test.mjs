import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildFirebasePrices, buildFirebasePricePatch } = require('../record.js');

const payload = buildFirebasePrices(
  { BMNR: 26.46, '005930.KS': 70000 },
  1400,
  { BMNR: 2.5 },
  'server-cache',
  { BMNR: '2026-09-11T14:30:00.000Z', '005930.KS': '2026-09-11T14:29:00.000Z' },
);

assert.equal(payload.BMNR, 26.46);
assert.equal(payload['005930__DOT__KS'], 70000);
assert.equal(payload.timestamps.BMNR, '2026-09-11T14:30:00.000Z');
assert.equal(payload.timestamps['005930__DOT__KS'], '2026-09-11T14:29:00.000Z');
assert.equal(payload.source, 'server-cache');
const patch = buildFirebasePricePatch(
  { BMNR: 26.46, TSLA: 364 }, 1400, { BMNR: 2.5, TSLA: 1 }, 'server-cache',
  { BMNR: '2026-09-11T14:30:00.000Z', TSLA: '2026-09-11T14:20:00.000Z' }, new Set(['BMNR']), true,
);
assert.equal(patch.BMNR, 26.46);
assert.equal(patch.TSLA, undefined, 'stale cached price must not overwrite a newer child value');
assert.equal(patch['timestamps/BMNR'], '2026-09-11T14:30:00.000Z');
assert.equal(patch['changes/BMNR'], 2.5);
assert.equal(patch.timestamps, undefined, 'multi-location patch must not replace metadata maps');
console.log('✓ record cache preserves per-symbol quote timestamps');
