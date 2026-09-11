import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchQuotes, handleRequest, scheduledRefresh } from '../quote-relay/worker.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function test(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (error) { console.error(`✗ ${name}\n  ${error.stack || error.message}`); process.exitCode = 1; }
}

await test('relay returns per-symbol quote timestamps and fills a Naver miss from Yahoo', async () => {
  const calls = [];
  const fakeFetch = async url => {
    calls.push(String(url));
    if (String(url).includes('polling.finance.naver.com')) {
      return jsonResponse({ datas: [{ symbolCode: 'TSLA', reutersCode: 'TSLA.O', closePriceRaw: '210.5', fluctuationsRatioRaw: '1.25' }] });
    }
    if (String(url).includes('/chart/BMNR?')) {
      return jsonResponse({ chart: { result: [{ meta: { regularMarketPrice: 26.46, regularMarketChangePercent: 2.5 } }] } });
    }
    return new Response('not found', { status: 404 });
  };
  const now = () => new Date('2026-09-11T14:30:00.000Z');
  const result = await fetchQuotes(['TSLA', 'BMNR'], fakeFetch, now);
  assert.deepEqual(result.TSLA, { price: 210.5, change: 1.25, source: 'naver', updatedAt: '2026-09-11T14:30:00.000Z' });
  assert.deepEqual(result.BMNR, { price: 26.46, change: 2.5, source: 'yahoo', updatedAt: '2026-09-11T14:30:00.000Z' });
  assert.ok(calls.some(url => url.includes('/chart/BMNR?')), 'Yahoo fallback must run for the missing ticker');
});

await test('HTTP endpoint rejects malformed symbols instead of forwarding arbitrary URLs', async () => {
  const request = new Request('https://relay.example/quotes?symbols=TSLA,../../secret');
  const response = await handleRequest(request, {}, { fetch: async () => { throw new Error('must not fetch'); } });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid symbols' });
});

await test('CORS fails closed and preflight returns a valid empty 204 response', async () => {
  const request = new Request('https://relay.example/quotes?symbols=BMNR', { headers: { Origin: 'null' } });
  const response = await handleRequest(request, {}, { fetch: async () => jsonResponse({ datas: [] }) });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const preflight = await handleRequest(new Request('https://relay.example/quotes', { method: 'OPTIONS', headers: { Origin: 'https://stcjum-source.github.io' } }), { ALLOWED_ORIGIN: 'https://stcjum-source.github.io' });
  assert.equal(preflight.status, 204);
  assert.equal(await preflight.text(), '');
});

await test('HTTP endpoint exposes cacheable CORS JSON for valid quote requests', async () => {
  const fakeFetch = async url => String(url).includes('polling.finance.naver.com')
    ? jsonResponse({ datas: [{ symbolCode: 'BMNR', reutersCode: 'BMNR.K', closePriceRaw: '26.46' }] })
    : new Response('not found', { status: 404 });
  const request = new Request('https://relay.example/quotes?symbols=BMNR', { headers: { Origin: 'https://stcjum-source.github.io' } });
  const response = await handleRequest(request, { ALLOWED_ORIGIN: 'https://stcjum-source.github.io' }, { fetch: fakeFetch, now: () => new Date('2026-09-11T14:30:00.000Z') });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://stcjum-source.github.io');
  assert.match(response.headers.get('cache-control') || '', /max-age/);
  const body = await response.json();
  assert.equal(body.quotes.BMNR.price, 26.46);
  assert.equal(body.quotes.BMNR.updatedAt, '2026-09-11T14:30:00.000Z');
});

await test('scheduled refresh reads current foreign holdings and patches Firebase with per-symbol timestamps', async () => {
  const writes = [];
  const calls = [];
  const extraStocks = Array.from({ length: 31 }, (_, index) => ({ ticker: `X${String(index).padStart(2, '0')}`, currency: 'USD' }));
  const fakeFetch = async (url, options = {}) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('securetoken.googleapis.com')) {
      assert.match(String(options.body), /refresh_token=test-refresh-token/);
      return jsonResponse({ id_token: 'test-token' });
    }
    if (target.includes('/assets/2402.json')) return jsonResponse({
      stocks: [{ ticker: 'BMNR', currency: 'USD' }, ...extraStocks, { ticker: '../../secret', currency: 'USD' }, { ticker: '005930.KS', currency: 'KRW' }],
      etf: [{ ticker: 'QQQ', currency: 'USD' }],
      prices: { timestamps: { '005930__DOT__KS': '2026-09-11T14:20:00.000Z' }, changes: { '005930__DOT__KS': 0.5 } },
    });
    if (target.includes('polling.finance.naver.com')) {
      const codes = decodeURIComponent(new URL(target).pathname.split('/').pop()).split(',');
      const symbols = [...new Set(codes.map(code => code.replace(/\.(O|K)$/, '')))];
      return jsonResponse({ datas: symbols.map(symbol => ({ symbolCode: symbol, closePriceRaw: symbol === 'BMNR' ? '26.46' : symbol === 'QQQ' ? '600.1' : '10' })) });
    }
    if (target.includes('/assets/2402/prices.json')) {
      writes.push(JSON.parse(options.body));
      return jsonResponse({ ok: true });
    }
    return new Response('not found', { status: 404 });
  };
  await scheduledRefresh({
    FIREBASE_API_KEY: 'public-test-key',
    FIREBASE_REFRESH_TOKEN: 'test-refresh-token',
    FIREBASE_DB_URL: 'https://example.firebaseio.com',
    ASSET_ROOM: '2402',
  }, { fetch: fakeFetch, now: () => new Date('2026-09-11T14:30:00.000Z') });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].BMNR, 26.46);
  assert.equal(writes[0].QQQ, 600.1);
  assert.equal(writes[0]['timestamps/BMNR'], '2026-09-11T14:30:00.000Z');
  assert.equal(writes[0]['timestamps/QQQ'], '2026-09-11T14:30:00.000Z');
  assert.equal(writes[0]['timestamps/X30'], '2026-09-11T14:30:00.000Z', 'scheduled refresh must process batches beyond 30 symbols');
  assert.equal(writes[0].timestamps, undefined, 'scheduled refresh must not replace the whole timestamp map');
  assert.equal(writes[0].changes, undefined, 'scheduled refresh must not replace the whole change map');
  assert.equal(writes[0]['005930__DOT__KS'], undefined, 'domestic quotes are outside this relay');
  assert.equal(calls.some(url => url.includes('secret')), false, 'malformed holdings must never reach an upstream URL');
});

await test('Cloudflare owns the 15-minute schedule and the delayed GitHub cron is disabled', async () => {
  const wrangler = readFileSync(resolve(here, '..', 'quote-relay', 'wrangler.toml'), 'utf8');
  const githubWorkflow = readFileSync(resolve(here, '..', '.github', 'workflows', 'market-prices.yml'), 'utf8');
  assert.match(wrangler, /crons\s*=\s*\["\*\/15 0-6,13-21 \* \* 1-5"\]/);
  assert.doesNotMatch(githubWorkflow, /^\s*schedule:/m);
  assert.match(githubWorkflow, /^\s*workflow_dispatch:/m, 'manual server refresh must remain available as a fallback');
});
