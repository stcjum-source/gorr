#!/usr/bin/env node
/**
 * 자산 자동 기록 스크립트
 *
 * 환경변수:
 *   FIREBASE_KEY  Firebase 서비스 계정 JSON 문자열 (GitHub Secret)
 *
 * 사용:
 *   FIREBASE_KEY='...' node record.js
 */

'use strict';

const ROOM   = process.env.ASSET_ROOM || '2402';
const DB_URL = 'https://gorr-66f73-default-rtdb.firebaseio.com';
const ETF_TICKER_FIX = {
  '243890.KS': '0163Y0.KS',
  '494640.KS': '0117V0.KS',
  '469130.KS': '0131V0.KS',
};
const NAVER_US = {
  PLTR: { code: 'PLTR.O', type: 'stock' },
  TSLA: { code: 'TSLA.O', type: 'stock' },
  TSLL: { code: 'TSLL.O', type: 'etf' },
  CRCL: { code: 'CRCL.K', type: 'stock' },
  BMNR: { code: 'BMNR.K', type: 'stock' },
  MSTR: { code: 'MSTR.O', type: 'stock' },
  IREN: { code: 'IREN.O', type: 'stock' },
  O: { code: 'O.K', type: 'stock' },
};
const encodePriceKey = key => String(key).replaceAll('.', '__DOT__');
const decodePriceKey = key => String(key).replaceAll('__DOT__', '.');

function decodeChanges(raw) {
  const decoded = {};
  for (const [key, value] of Object.entries(raw || {})) decoded[decodePriceKey(key)] = value;
  return decoded;
}

function buildFirebasePrices(prices, exRate, changes, source) {
  const payload = {};
  for (const [key, value] of Object.entries(prices)) {
    if (Number.isFinite(Number(value))) payload[encodePriceKey(key)] = Number(value);
  }
  const encodedChanges = {};
  for (const [key, value] of Object.entries(changes || {})) encodedChanges[encodePriceKey(key)] = value;
  return { ...payload, exRate, changes: encodedChanges, updatedAt: new Date().toISOString(), ...(source ? { source } : {}) };
}

// ── 유틸 ──────────────────────────────────────────────────────
function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

async function fetchWithTimeout(url, ms = 8000, opts = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function fetchJSON(url, ms = 8000, opts = {}) {
  try {
    const r = await fetchWithTimeout(url, ms, opts);
    if (!r.ok) return null;
    return r.json();
  } catch (_) {
    return null;
  }
}

// ── 코인 가격 (업비트 → 빗썸 백업) ────────────────────────────
async function fetchCryptoPrices(cryptos) {
  const prices = {};
  if (!cryptos.length) return prices;

  const markets = cryptos.map(c => c.market).join(',');
  const d = await fetchJSON(`https://api.upbit.com/v1/ticker?markets=${markets}`);
  if (Array.isArray(d) && d.length) {
    d.forEach(item => { prices[item.market] = item.trade_price; });
    log(`코인 업비트 ${Object.keys(prices).length}/${cryptos.length}개 로드`);
    return prices;
  }

  // 빗썸 백업
  const b = await fetchJSON('https://api.bithumb.com/public/ticker/ALL_KRW');
  if (b?.status === '0000' && b.data) {
    cryptos.forEach(c => {
      const sym = c.market.replace('KRW-', '');
      if (b.data[sym]?.closing_price) {
        prices[c.market] = parseFloat(b.data[sym].closing_price);
      }
    });
    log(`코인 빗썸 백업 ${Object.keys(prices).length}/${cryptos.length}개 로드`);
  }
  return prices;
}

// ── 환율 ──────────────────────────────────────────────────────
async function fetchExRate() {
  const d1 = await fetchJSON('https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD');
  if (d1?.[0]?.basePrice) { log(`환율 두나무: ${d1[0].basePrice}`); return d1[0].basePrice; }

  const d2 = await fetchJSON('https://api.exchangerate-api.com/v4/latest/USD');
  if (d2?.rates?.KRW) { log(`환율 exchangerate-api: ${d2.rates.KRW}`); return d2.rates.KRW; }

  log('환율 조회 실패');
  return null;
}

// ── 주식/ETF 가격 ──────────────────────────────────────────────
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchNaverPrice(code) {
  const d = await fetchJSON(
    `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`,
    8000,
    { headers: { 'User-Agent': BROWSER_UA } }
  );
  if (d?.datas?.[0]?.closePrice) {
    return parseFloat(String(d.datas[0].closePrice).replace(/,/g, ''));
  }
  // m.stock 백업
  const d2 = await fetchJSON(
    `https://m.stock.naver.com/api/stock/${code}/basic`,
    8000,
    { headers: { 'User-Agent': BROWSER_UA } }
  );
  if (d2?.closePrice) {
    return parseFloat(String(d2.closePrice).replace(/,/g, ''));
  }
  return null;
}

// Yahoo가 클라우드(GitHub Actions) IP를 차단하므로, 직접 호출 실패 시
// CORS 릴레이 프록시를 거쳐 다른 IP에서 나가는 것처럼 재시도한다.
// (assets.html 브라우저 앱과 동일한 우회 전략)
const RELAY_PROXIES = [
  u => u, // 1순위: 직접 호출
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  u => `https://thingproxy.freeboard.io/fetch/${u}`,
];

async function fetchYahooPrice(ticker) {
  const headers = {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    const target = `${base}/v8/finance/chart/${ticker}?interval=1d&range=2d`;
    for (const wrap of RELAY_PROXIES) {
      const d = await fetchJSON(wrap(target), 10000, { headers });
      const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) return price;
    }
  }
  return null;
}

// Stooq: Yahoo와 완전히 별개인 무료 시세 소스 (CSV).
// 미국 주식은 소문자 + ".us" 접미사를 쓴다. 예: PLTR → pltr.us
async function fetchStooqPrice(ticker) {
  const sym = `${ticker.toLowerCase()}.us`;
  const url = `https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`;
  try {
    const r = await fetchWithTimeout(url, 8000, { headers: { 'User-Agent': BROWSER_UA } });
    if (!r.ok) return null;
    const text = await r.text();
    // 헤더: Symbol,Date,Time,Open,High,Low,Close,Volume
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    const cols = lines[1].split(',');
    const close = parseFloat(cols[6]);
    if (!isNaN(close) && close > 0) return close;
  } catch (_) {}
  return null;
}

// { price, source } 형태로 반환 — 어느 소스가 성공했는지 로깅용
async function fetchStockPrice(ticker, hint = {}) {
  // 국내 (KS/KQ) → 네이버, 실패 시 Yahoo
  if (ticker.endsWith('.KS') || ticker.endsWith('.KQ')) {
    const code = ticker.replace('.KS', '').replace('.KQ', '');
    const p = await fetchNaverPrice(code);
    if (p != null) return { price: p, source: 'naver' };
    const y = await fetchYahooPrice(ticker);
    if (y != null) return { price: y, source: 'yahoo' };
    return { price: null, source: null };
  }
  // 미국 → 네이버 해외시세 → Yahoo → Stooq 백업
  const naver = hint.naverCode
    ? { code: hint.naverCode, type: hint.naverType || 'stock' }
    : NAVER_US[ticker];
  if (naver) {
    const d = await fetchJSON(`https://polling.finance.naver.com/api/realtime/worldstock/${naver.type}/${naver.code}`);
    const p = Number(d?.datas?.[0]?.closePriceRaw || String(d?.datas?.[0]?.closePrice || '').replace(/,/g, ''));
    if (p > 0) return { price: p, source: 'naver-world' };
  } else if (/^[A-Z][A-Z0-9.-]*$/.test(ticker)) {
    // 신규 미국 주식/ETF도 Yahoo로 바로 넘기지 않고 NASDAQ(.O)/NYSE(.K)를 자동 확인한다.
    const codes = `${ticker}.O,${ticker}.K`;
    for (const type of ['stock', 'etf']) {
      const d = await fetchJSON(`https://polling.finance.naver.com/api/realtime/worldstock/${type}/${codes}`);
      const row = d?.datas?.find(item => item.symbolCode === ticker);
      const p = Number(row?.closePriceRaw || String(row?.closePrice || '').replace(/,/g, ''));
      if (p > 0) return { price: p, source: `naver-world-auto-${type}` };
    }
  }
  const y = await fetchYahooPrice(ticker);
  if (y != null) return { price: y, source: 'yahoo' };
  const s = await fetchStooqPrice(ticker);
  if (s != null) return { price: s, source: 'stooq' };
  return { price: null, source: null };
}

// 해외종목을 주식/ETF 각 한 번의 요청으로 조회한다. 개별 Yahoo 요청의 429와
// 무료 프록시 지연을 정상 경로에서 제거하고, 실패 종목만 후속 소스로 넘긴다.
async function fetchNaverUsPrices(items) {
  const result = new Map();
  const groups = { stock: [], etf: [] };

  for (const item of items) {
    if (item.manual || item.ticker.endsWith('.KS') || item.ticker.endsWith('.KQ')) continue;
    const known = item.naverCode
      ? { code: item.naverCode, type: item.naverType || 'stock' }
      : NAVER_US[item.ticker];
    if (known) {
      groups[known.type].push({ ticker: item.ticker, codes: [known.code] });
    } else if (/^[A-Z][A-Z0-9.-]*$/.test(item.ticker)) {
      const entry = { ticker: item.ticker, codes: [`${item.ticker}.O`, `${item.ticker}.K`] };
      // 종류를 미리 하드코딩하지 않아도 되도록 신규 티커는 주식/ETF 양쪽에서 확인한다.
      groups.stock.push(entry);
      groups.etf.push(entry);
    }
  }

  await Promise.all(Object.entries(groups).map(async ([type, entries]) => {
    if (!entries.length) return;
    const codes = [...new Set(entries.flatMap(entry => entry.codes))].join(',');
    const d = await fetchJSON(`https://polling.finance.naver.com/api/realtime/worldstock/${type}/${codes}`, 10000, {
      headers: { 'User-Agent': BROWSER_UA },
    });
    for (const row of d?.datas || []) {
      const entry = entries.find(candidate => candidate.codes.includes(row.reutersCode) || candidate.ticker === row.symbolCode);
      const price = Number(row.closePriceRaw || String(row.closePrice || '').replace(/,/g, ''));
      const change = Number(row.fluctuationsRatioRaw ?? row.fluctuationsRatio);
      if (entry && price > 0) result.set(entry.ticker, {
        price,
        change: Number.isFinite(change) ? change : null,
        source: 'naver-world-batch',
      });
    }
  }));

  return result;
}

// ── 총자산 계산 (assets.html calcAssetVal과 동일 로직) ─────────
function calcTotals(cryptos, stocks, etfs, cashArr, prices, exRate) {
  let crypto = 0, stocksT = 0, etf = 0, cash = 0;

  cryptos.forEach(item => {
    const p = prices[item.market];
    if (p != null) crypto += item.qty * p;
  });

  stocks.forEach(item => {
    if (item.manual) return;
    const p = prices[item.ticker];
    if (p != null) stocksT += item.qty * p * exRate;
  });

  etfs.forEach(item => {
    if (item.manual) return;
    const p = prices[item.ticker];
    if (p != null) {
      etf += item.currency === 'USD' ? item.qty * p * exRate : item.qty * p;
    }
  });

  cashArr.forEach(item => { cash += Number(item.amount) || 0; });

  return { crypto, stocks: stocksT, etf, cash };
}

// ── Firebase history 정규화 (배열/객체 모두 처리) ──────────────
function normalizeHistory(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return Object.values(raw).filter(Boolean);
}

// 기록 품질 점수 — 클수록 신뢰도 높음 (assets.html recRank와 동일 규칙).
// complete(모두 실시간) > finalized(서버 확정) > stale 개수 적을수록.
// 부실한 값이 좋은 값을 덮어쓰지 못하게 하는 데 사용.
function recRank(r) {
  if (!r) return -1;
  const finalized = r.provisional === false;
  const staleN = Array.isArray(r.stale) ? r.stale.length : 0;
  return (r.complete ? 2 : 0) + (finalized ? 1 : 0) - staleN * 0.001;
}

// ── 메인 ──────────────────────────────────────────────────────
async function main() {
  log(`=== 자산 자동 기록 시작 (룸: ${ROOM}) ===`);

  // Firebase 초기화
  const admin = require('firebase-admin');
  const keyJson = process.env.FIREBASE_KEY;
  if (!keyJson) { log('❌ FIREBASE_KEY 환경변수 없음'); process.exit(1); }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(keyJson);
  } catch (e) {
    log('❌ FIREBASE_KEY JSON 파싱 실패'); process.exit(1);
  }

  admin.initializeApp({
    credential:  admin.credential.cert(serviceAccount),
    databaseURL: DB_URL,
  });
  const db = admin.database();
  log('Firebase 연결 완료');

  // 자산 데이터 로드
  log('Firebase에서 자산 데이터 로드 중...');
  const snap = await db.ref(`assets/${ROOM}`).once('value');
  const data = snap.val();
  if (!data) { log(`❌ assets/${ROOM} 데이터 없음`); process.exit(1); }

  const cryptos = data.crypto  || [];
  const stocks  = data.stocks  || [];
  const rawEtfs = data.etf     || [];
  const etfs    = rawEtfs.map(item => ETF_TICKER_FIX[item.ticker] ? { ...item, ticker: ETF_TICKER_FIX[item.ticker] } : item);
  const cashArr = data.cash    || [];
  const history = normalizeHistory(data.history);
  log(`로드 완료: 코인 ${cryptos.length}개 / 주식 ${stocks.length}개 / ETF ${etfs.length}개 / 기록 ${history.length}일`);

  // 가격 조회. 실패한 종목은 Firebase의 마지막 정상가로 폴백한다.
  // freshKeys는 "이번 실행에서 실제 조회된 시세"만 추적한다.
  const cachedPrices = data.prices || {};
  const prices = {};
  for (const [key, value] of Object.entries(cachedPrices)) {
    if (key !== 'changes' && key !== 'exRate' && key !== 'updatedAt' && Number.isFinite(Number(value))) {
      prices[decodePriceKey(key)] = Number(value);
    }
  }
  const freshKeys = new Set();

  log('--- 코인 가격 조회 ---');
  const freshCrypto = await fetchCryptoPrices(cryptos);
  Object.assign(prices, freshCrypto);
  Object.keys(freshCrypto).forEach(key => freshKeys.add(key));

  log('--- 환율 조회 ---');
  const fetchedExRate = await fetchExRate();
  const cachedExRate = Number(cachedPrices.exRate);
  const exRate = fetchedExRate ?? (Number.isFinite(cachedExRate) && cachedExRate > 0 ? cachedExRate : null);
  const fxFresh = fetchedExRate != null;
  if (exRate == null) {
    log('❌ 환율의 실시간값과 마지막 정상값이 모두 없어 기록을 중단합니다');
    process.exit(1);
  }
  if (!fxFresh) log(`  ⚠ 환율 폴백: ${exRate}`);

  const tradeItems = [...stocks, ...etfs].filter(i => !i.manual);
  log(`--- 주식/ETF ${tradeItems.length}개 가격 조회 ---`);
  const foreignBatch = await fetchNaverUsPrices(tradeItems);
  const changes = decodeChanges(cachedPrices.changes);
  for (const [ticker, quote] of foreignBatch) {
    prices[ticker] = quote.price;
    freshKeys.add(ticker);
    if (quote.change != null) changes[ticker] = quote.change;
    log(`  ✓ ${ticker}: ${quote.price} [${quote.source}]`);
  }
  await Promise.allSettled(
    tradeItems.filter(item => !freshKeys.has(item.ticker)).map(async item => {
      const { price, source } = await fetchStockPrice(item.ticker, item);
      if (price != null) {
        prices[item.ticker] = price;
        freshKeys.add(item.ticker);
        log(`  ✓ ${item.name} (${item.ticker}): ${price} [${source}]`);
      } else {
        log(`  ✗ ${item.name} (${item.ticker}): 조회 실패`);
      }
    })
  );

  // 장중 가격 캐시 전용 실행. history는 건드리지 않고 Firebase 시세만 갱신한다.
  // 브라우저의 Yahoo/CORS 조회가 실패해도 앱은 이 마지막 서버 가격을 계속 표시한다.
  if (process.env.PRICE_ONLY === '1') {
    await db.ref(`assets/${ROOM}/prices`).set(buildFirebasePrices(prices, exRate, changes, 'server-cache'));
    log(`✅ 장중 가격 캐시 갱신: ${Object.keys(prices).length}개`);
    await admin.app().delete();
    return;
  }

  // 완전성 검증: 실시간 또는 마지막 정상가가 모든 자산에 있어야만 기록한다.
  const neededKeys = [...cryptos.map(c => c.market), ...tradeItems.map(i => i.ticker)];
  const missing = neededKeys.filter(key => prices[key] == null);
  const stale = neededKeys.filter(key => prices[key] != null && !freshKeys.has(key));
  const hasUsdAssets = tradeItems.some(i => i.currency === 'USD') || stocks.some(i => !i.manual && i.currency !== 'KRW');
  if (hasUsdAssets && !fxFresh) stale.push('USD/KRW');
  const complete = missing.length === 0 && stale.length === 0;
  log(`\n시세 품질 — 실시간 ${freshKeys.size}/${neededKeys.length}, 폴백 ${stale.length}, 누락 ${missing.length}`);

  if (missing.length) {
    log(`❌ 가격이 전혀 없는 자산: ${missing.join(', ')} — 기록을 중단합니다`);
    process.exit(1);
  }

  // 총자산 계산
  const totals = calcTotals(cryptos, stocks, etfs, cashArr, prices, exRate);
  const invest = totals.crypto + totals.stocks + totals.etf;
  const grand  = invest + totals.cash;
  log(`\n총자산: ${Math.round(grand).toLocaleString('ko-KR')}원`);
  log(`  코인 ${Math.round(totals.crypto).toLocaleString('ko-KR')}원`);
  log(`  주식 ${Math.round(totals.stocks).toLocaleString('ko-KR')}원`);
  log(`  ETF  ${Math.round(totals.etf).toLocaleString('ko-KR')}원`);
  log(`  현금 ${Math.round(totals.cash).toLocaleString('ko-KR')}원`);

  // 한국 날짜 (UTC+9)
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const ds  = kst.toISOString().slice(0, 10);
  log(`\n기록 날짜 (KST): ${ds}`);

  // history 업데이트
  const arr = [...history];
  const ei  = arr.findIndex(h => h.date === ds);
  const entry = {
    date:   ds,
    // total은 그래프용 투자자산(코인+주식+ETF). 현금은 cash에 별도 저장.
    total:  Math.round(invest),
    crypto: Math.round(totals.crypto),
    stocks: Math.round(totals.stocks),
    etf:    Math.round(totals.etf),
    cash:   Math.round(totals.cash),
    complete,
    stale,
    source: 'server',
    provisional: false,
    ts: new Date().toISOString(),
  };
  if (ei >= 0) {
    if (recRank(arr[ei]) > recRank(entry)) {
      log('⚠ 기존 기록이 더 정확해 덮어쓰지 않음');
    } else {
      arr[ei] = entry;
      log('기존 오늘 기록을 더 나은 품질의 서버 값으로 덮어쓰기');
    }
  } else {
    arr.push(entry);
    log('새 기록 추가');
  }
  arr.sort((a, b) => (a.date > b.date ? 1 : -1));

  await db.ref(`assets/${ROOM}`).update({
    history: arr,
    prices: buildFirebasePrices(prices, exRate, changes),
  });
  log(`\n✅ 완료: ${ds} → ${(grand / 1e8).toFixed(2)}억원`);

  await admin.app().delete();
}

if (require.main === module) {
  main().catch(e => {
    log(`❌ 오류: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { fetchNaverUsPrices, fetchStockPrice, buildFirebasePrices, decodePriceKey };
