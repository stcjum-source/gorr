const NAVER_BASE = 'https://polling.finance.naver.com/api/realtime/worldstock';
const YAHOO_BASES = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,14}$/;
const MAX_SYMBOLS = 30;

function quoteTime(now) {
  return now().toISOString();
}

async function fetchJSON(url, fetchImpl, timeoutMs = 5500, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gorr-quote-relay/1.0',
        ...(options.headers || {}),
      },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseNaverRow(row, updatedAt) {
  const price = Number(row?.closePriceRaw || String(row?.closePrice || '').replaceAll(',', ''));
  if (!(price > 0)) return null;
  const rawChange = Number(row?.fluctuationsRatioRaw ?? row?.fluctuationsRatio);
  const falling = row?.compareToPreviousPrice?.code === '5';
  return {
    price,
    change: Number.isFinite(rawChange) ? (falling ? -Math.abs(rawChange) : Math.abs(rawChange)) : null,
    source: 'naver',
    updatedAt,
  };
}

function parseYahoo(payload, updatedAt) {
  const meta = payload?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!(price > 0)) return null;
  let change = Number(meta?.regularMarketChangePercent);
  if (!Number.isFinite(change)) {
    const previous = Number(meta?.chartPreviousClose);
    change = previous > 0 ? ((price - previous) / previous) * 100 : null;
  }
  return { price, change: Number.isFinite(change) ? change : null, source: 'yahoo', updatedAt };
}

export function validSymbols(symbols) {
  return symbols.length > 0 && symbols.length <= MAX_SYMBOLS && symbols.every(symbol => SYMBOL_RE.test(symbol));
}

export async function fetchQuotes(symbols, fetchImpl = fetch, now = () => new Date()) {
  const unique = [...new Set(symbols)];
  const updatedAt = quoteTime(now);
  const quotes = {};
  const naverCodes = unique.flatMap(symbol => [`${symbol}.O`, `${symbol}.K`]).join(',');

  const naverPayloads = await Promise.all([
    fetchJSON(`${NAVER_BASE}/stock/${naverCodes}`, fetchImpl, 2500),
    fetchJSON(`${NAVER_BASE}/etf/${naverCodes}`, fetchImpl, 2500),
  ]);
  for (const row of naverPayloads.flatMap(payload => payload?.datas || [])) {
    const symbol = String(row?.symbolCode || '').toUpperCase();
    if (!unique.includes(symbol) || quotes[symbol]) continue;
    const quote = parseNaverRow(row, updatedAt);
    if (quote) quotes[symbol] = quote;
  }

  await Promise.all(unique.filter(symbol => !quotes[symbol]).map(async symbol => {
    const payloads = await Promise.all(YAHOO_BASES.map(base =>
      fetchJSON(`${base}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`, fetchImpl, 3000)
    ));
    for (const payload of payloads) {
      const quote = parseYahoo(payload, updatedAt);
      if (quote) { quotes[symbol] = quote; return; }
    }
  }));

  return quotes;
}

function corsOrigin(request, env) {
  const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return null;
  return allowed.includes('*') || allowed.includes(origin) ? (allowed.includes('*') ? '*' : origin) : null;
}

function json(body, status, request, env, cacheControl = 'no-store') {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-methods': 'GET,OPTIONS',
    'cache-control': cacheControl,
    vary: 'Origin',
  };
  const origin = corsOrigin(request, env);
  if (origin) headers['access-control-allow-origin'] = origin;
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

export async function handleRequest(request, env = {}, deps = {}) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS' && url.pathname === '/quotes') {
    const headers = { 'access-control-allow-methods': 'GET,OPTIONS', vary: 'Origin' };
    const origin = corsOrigin(request, env);
    if (origin) headers['access-control-allow-origin'] = origin;
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'GET' || url.pathname !== '/quotes') return json({ error: 'not found' }, 404, request, env);
  const raw = url.searchParams.get('symbols') || '';
  const symbols = raw.split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
  if (!validSymbols(symbols)) return json({ error: 'invalid symbols' }, 400, request, env);
  const quotes = await fetchQuotes(symbols, deps.fetch || fetch, deps.now || (() => new Date()));
  return json({ quotes }, 200, request, env, 'public, max-age=30, stale-while-revalidate=30');
}

function firebaseUrl(env, path, token) {
  const base = String(env.FIREBASE_DB_URL || '').replace(/\/$/, '');
  return `${base}/${path}.json?auth=${encodeURIComponent(token)}`;
}

async function firebaseToken(env, fetchImpl) {
  if (!env.FIREBASE_API_KEY || !env.FIREBASE_REFRESH_TOKEN) throw new Error('Firebase authentication configuration is incomplete');
  const payload = await fetchJSON(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`,
    fetchImpl,
    7000,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.FIREBASE_REFRESH_TOKEN }).toString(),
    },
  );
  if (!payload?.id_token) throw new Error('Firebase token refresh failed');
  return payload.id_token;
}

export async function scheduledRefresh(env = {}, deps = {}) {
  if (!env.FIREBASE_DB_URL || !env.ASSET_ROOM) throw new Error('Firebase schedule configuration is incomplete');
  const fetchImpl = deps.fetch || fetch;
  const now = deps.now || (() => new Date());
  const token = await firebaseToken(env, fetchImpl);
  const room = encodeURIComponent(env.ASSET_ROOM);
  const assets = await fetchJSON(firebaseUrl(env, `assets/${room}`, token), fetchImpl, 7000);
  if (!assets) throw new Error('Asset room could not be loaded');
  const items = [...(assets.stocks || []), ...(assets.etf || [])].filter(item => {
    if (item.manual || !item.ticker) return false;
    if (String(item.currency || '').toUpperCase() === 'KRW') return false;
    return !/\.(KS|KQ)$/i.test(item.ticker);
  });
  const symbols = [...new Set(items.map(item => String(item.ticker).toUpperCase()))].filter(symbol => SYMBOL_RE.test(symbol));
  if (!symbols.length) return { updated: 0 };
  const batches = [];
  for (let index = 0; index < symbols.length; index += MAX_SYMBOLS) batches.push(symbols.slice(index, index + MAX_SYMBOLS));
  const quotes = Object.assign({}, ...(await Promise.all(batches.map(batch => fetchQuotes(batch, fetchImpl, now)))));
  const patch = { source: 'quote-relay-cron', updatedAt: now().toISOString() };
  for (const [symbol, quote] of Object.entries(quotes)) {
    const key = symbol.replaceAll('.', '__DOT__');
    patch[key] = quote.price;
    patch[`timestamps/${key}`] = quote.updatedAt;
    if (quote.change != null) patch[`changes/${key}`] = quote.change;
  }
  if (!Object.keys(quotes).length) throw new Error('Scheduled quote refresh returned no prices');
  const response = await fetchImpl(firebaseUrl(env, `assets/${room}/prices`, token), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`Firebase price patch failed: ${response.status}`);
  return { updated: Object.keys(quotes).length };
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(scheduledRefresh(env));
  },
};
