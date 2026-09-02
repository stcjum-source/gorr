#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'asset-symbols.json');
const US_ALIASES = {
  AAPL: ['애플'], AMZN: ['아마존'], BMNR: ['비트마인'], CRCL: ['써클'],
  GOOG: ['구글', '알파벳'], GOOGL: ['구글', '알파벳'], IREN: ['아이렌'],
  META: ['메타'], MSFT: ['마이크로소프트'], MSTR: ['마이크로스트래티지'],
  NFLX: ['넷플릭스'], NVDA: ['엔비디아'], O: ['리얼티인컴'],
  PLTR: ['팔란티어'], TSLA: ['테슬라'], TSLL: ['테슬라 레버리지'],
};

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'gorr-asset-catalog/1.0' } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

async function fetchJSON(url) {
  return JSON.parse(await fetchText(url));
}

function parsePipeFile(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split('|');
  return lines.filter(line => line && !line.startsWith('File Creation Time')).map(line => {
    const values = line.split('|');
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
}

function cleanSecurityName(value) {
  return String(value || '')
    .replace(/\s+-\s+(Common Stock|Ordinary Shares|American Depositary Shares.*|Class [A-Z].*)$/i, '')
    .trim();
}

async function main() {
  const kospiUrl = 'https://m.stock.naver.com/api/json/sise/siseListJson.nhn?menu=market_sum&sosok=0&pageSize=3000&page=1';
  const kosdaqUrl = 'https://m.stock.naver.com/api/json/sise/siseListJson.nhn?menu=market_sum&sosok=1&pageSize=3000&page=1';
  const etfUrl = 'https://finance.naver.com/api/sise/etfItemList.nhn';
  const upbitUrl = 'https://api.upbit.com/v1/market/all?is_details=false';
  const nasdaqUrl = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt';
  const otherUrl = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt';

  const [kospi, kosdaq, etfs, upbit, nasdaqText, otherText] = await Promise.all([
    fetchJSON(kospiUrl), fetchJSON(kosdaqUrl), fetchJSON(etfUrl), fetchJSON(upbitUrl),
    fetchText(nasdaqUrl), fetchText(otherUrl),
  ]);

  const results = [];
  const addDomestic = (row, suffix, exchange) => {
    if (!row.cd || !row.nm) return;
    results.push({ bucket: 'stocks', name: row.nm, ticker: `${row.cd}.${suffix}`, currency: 'KRW', exchange });
  };
  (kospi.result?.itemList || []).forEach(row => addDomestic(row, 'KS', 'KOSPI'));
  (kosdaq.result?.itemList || []).forEach(row => addDomestic(row, 'KQ', 'KOSDAQ'));
  (etfs.result?.etfItemList || []).forEach(row => {
    if (row.itemcode && row.itemname) results.push({
      bucket: 'etf', name: row.itemname, ticker: `${row.itemcode}.KS`, currency: 'KRW', exchange: 'KOSPI',
    });
  });
  (Array.isArray(upbit) ? upbit : []).filter(row => String(row.market || '').startsWith('KRW-')).forEach(row => {
    results.push({
      bucket: 'crypto', name: row.korean_name || row.english_name || row.market,
      englishName: row.english_name || '', market: row.market, currency: 'KRW', exchange: 'UPBIT',
    });
  });

  parsePipeFile(nasdaqText).forEach(row => {
    if (!row.Symbol || row['Test Issue'] === 'Y') return;
    const item = {
      bucket: row.ETF === 'Y' ? 'etf' : 'stocks', name: cleanSecurityName(row['Security Name']),
      ticker: row.Symbol, currency: 'USD', exchange: 'NASDAQ',
    };
    if (US_ALIASES[item.ticker]) item.aliases = US_ALIASES[item.ticker];
    results.push(item);
  });
  const otherExchange = { A: 'NYSE American', N: 'NYSE', P: 'NYSE Arca', Z: 'Cboe', V: 'IEX' };
  parsePipeFile(otherText).forEach(row => {
    const ticker = row['ACT Symbol'] || row['NASDAQ Symbol'];
    if (!ticker || row['Test Issue'] === 'Y') return;
    const item = {
      bucket: row.ETF === 'Y' ? 'etf' : 'stocks', name: cleanSecurityName(row['Security Name']),
      ticker, currency: 'USD', exchange: otherExchange[row.Exchange] || row.Exchange || 'US',
    };
    if (US_ALIASES[item.ticker]) item.aliases = US_ALIASES[item.ticker];
    results.push(item);
  });

  const unique = new Map();
  // 같은 국내 ETF가 일반 종목 목록에도 있으면 뒤에서 읽은 ETF 항목을 우선한다.
  for (const item of results) unique.set(item.market || item.ticker, item);
  const items = [...unique.values()].sort((a, b) =>
    `${a.bucket}:${a.market || a.ticker}`.localeCompare(`${b.bucket}:${b.market || b.ticker}`, 'en')
  );
  let updatedAt = new Date().toISOString();
  try {
    const previous = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    if (JSON.stringify(previous.items) === JSON.stringify(items)) updatedAt = previous.updatedAt || updatedAt;
  } catch (_) {}
  const payload = { version: 1, updatedAt, count: items.length, items };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(payload)}\n`);
  process.stdout.write(`asset-symbols.json: ${items.length} assets\n`);
}

main().catch(error => {
  process.stderr.write(`asset symbol update failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
