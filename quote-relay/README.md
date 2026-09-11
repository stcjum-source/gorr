# 해외주식 시세 중계 Worker

브라우저의 CORS 차단 없이 네이버 해외주식 시세를 조회하고, 누락된 종목은 Yahoo로 보완한다. 각 종목에 `updatedAt`을 함께 반환하며 Cloudflare Cron으로 Firebase 해외주식 캐시를 15분마다 갱신한다.

## 배포 전 설정

`quote-relay` 디렉터리에서 다음 Worker 환경값을 설정한다.

- `FIREBASE_API_KEY`: Firebase 익명 인증에 사용하는 Web API 키
- `FIREBASE_REFRESH_TOKEN`: 한 번 만든 전용 익명 계정의 장기 갱신 토큰. 매 실행마다 새 계정을 만들지 않고 같은 계정으로 인증한다.
- `FIREBASE_DB_URL`: Realtime Database 기본 URL
- `ASSET_ROOM`: 갱신할 자산 방 코드

민감하거나 개인적인 값은 `wrangler.toml`이나 Git에 넣지 말고 Worker secret으로 설정한다.

```sh
npx wrangler secret put FIREBASE_API_KEY
npx wrangler secret put FIREBASE_REFRESH_TOKEN
npx wrangler secret put FIREBASE_DB_URL
npx wrangler secret put ASSET_ROOM
npx wrangler deploy
```

배포가 끝나면 반환된 Worker URL을 루트의 `quote-relay-config.js`에 지정한다.

```js
window.ASSET_QUOTE_RELAY_URL = 'https://gorr-quotes.<account>.workers.dev';
```

## 검증

```sh
node scripts/quote-relay.test.mjs
curl 'http://127.0.0.1:8787/quotes?symbols=BMNR,TSLA'
```
