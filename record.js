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

const admin = require('firebase-admin');

const ROOM   = '2402';
const DB_URL = 'https://gorr-66f73-default-rtdb.firebaseio.com';

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

  log('환율 조회 실패 → 기본값 1450 사용');
  return 1450;
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

async function fetchYahooPrice(ticker) {
  const headers = { 'User-Agent': BROWSER_UA, Accept: 'application/json' };
  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    const d = await fetchJSON(
      `${base}/v8/finance/chart/${ticker}?interval=1d&range=2d`,
      10000,
      { headers }
    );
    const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (price) return price;
  }
  return null;
}

async function fetchStockPrice(ticker) {
  // 국내 (KS/KQ) → 네이버, 실패 시 Yahoo
  if (ticker.endsWith('.KS') || ticker.endsWith('.KQ')) {
    const code = ticker.replace('.KS', '').replace('.KQ', '');
    const p = await fetchNaverPrice(code);
    if (p != null) return p;
    return fetchYahooPrice(ticker);
  }
  // 미국 → Yahoo Finance
  return fetchYahooPrice(ticker);
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

// ── 메인 ──────────────────────────────────────────────────────
async function main() {
  log(`=== 자산 자동 기록 시작 (룸: ${ROOM}) ===`);

  // Firebase 초기화
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
  const etfs    = data.etf     || [];
  const cashArr = data.cash    || [];
  const history = normalizeHistory(data.history);
  log(`로드 완료: 코인 ${cryptos.length}개 / 주식 ${stocks.length}개 / ETF ${etfs.length}개 / 기록 ${history.length}일`);

  // 가격 조회
  const prices = {};

  log('--- 코인 가격 조회 ---');
  Object.assign(prices, await fetchCryptoPrices(cryptos));

  log('--- 환율 조회 ---');
  const exRate = await fetchExRate();

  const tradeItems = [...stocks, ...etfs].filter(i => !i.manual);
  log(`--- 주식/ETF ${tradeItems.length}개 가격 조회 ---`);
  await Promise.allSettled(
    tradeItems.map(async item => {
      const p = await fetchStockPrice(item.ticker);
      if (p != null) {
        prices[item.ticker] = p;
        log(`  ✓ ${item.name} (${item.ticker}): ${p}`);
      } else {
        log(`  ✗ ${item.name} (${item.ticker}): 조회 실패`);
      }
    })
  );

  // 로드율 검증
  const coinOk     = cryptos.length === 0 || cryptos.every(c => prices[c.market] != null);
  const loadedCnt  = tradeItems.filter(i => prices[i.ticker] != null).length;
  const ratio      = tradeItems.length === 0 ? 1 : loadedCnt / tradeItems.length;
  log(`\n로드율 — 코인: ${coinOk ? '✓' : '✗'} / 주식ETF: ${(ratio * 100).toFixed(0)}% (${loadedCnt}/${tradeItems.length})`);

  if (!coinOk || ratio < 0.7) {
    log('❌ 로드율 부족 — 기록을 중단합니다 (코인 미로드 또는 주식/ETF 70% 미만)');
    process.exit(1);
  }

  // 총자산 계산
  const totals = calcTotals(cryptos, stocks, etfs, cashArr, prices, exRate);
  const grand  = totals.crypto + totals.stocks + totals.etf + totals.cash;
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
    total:  Math.round(grand),
    crypto: Math.round(totals.crypto),
    stocks: Math.round(totals.stocks),
    etf:    Math.round(totals.etf),
    cash:   Math.round(totals.cash),
  };
  if (ei >= 0) {
    arr[ei] = entry;
    log('기존 오늘 기록 덮어쓰기');
  } else {
    arr.push(entry);
    log('새 기록 추가');
  }
  arr.sort((a, b) => (a.date > b.date ? 1 : -1));

  await db.ref(`assets/${ROOM}/history`).set(arr);
  log(`\n✅ 완료: ${ds} → ${(grand / 1e8).toFixed(2)}억원`);

  await admin.app().delete();
}

main().catch(e => {
  log(`❌ 오류: ${e.message}`);
  process.exit(1);
});
