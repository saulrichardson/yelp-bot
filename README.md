# yelp-bot

Local backend service (Fastify + Playwright) for automating a single Yelp account.

## Setup

1. Install dependencies:
   - `npm install`
2. Install Playwright browser(s):
   - `npx playwright install chromium`
3. Create `.env`:
   - Copy `.env.example`, then either:
     - Set credentials:
       - `YELP_BUSINESS_USERNAME=...`
       - `YELP_BUSINESS_PASSWORD=...`
       - (Alias supported: `YELP_BIZ_USERNAME` + `YELP_BIZ_PASSWORD` — set only one pair)
     - Or skip credentials and use manual auth to persist a session (see below)
4. Optional tuning:
   - `SLOW_MO_MS=250` (default is 250ms to behave more “human-like”)

## Explore Yelp for Business

- `npm run explore`
- Quick “is the login page reachable?” check: `npm run smoke:biz` (does not require credentials)

Artifacts are written to `artifacts/yelp-biz/`.

## Notes

- `.env`, `state/`, and `artifacts/` are intentionally git-ignored (they may contain secrets/session cookies).

## Manual (headed) auth bootstrap

This project always runs headful. Yelp may present CAPTCHAs / verification challenges. This helper opens a browser and lets you log in normally; your session is persisted to `state/yelp-biz/user-data/` for reuse.

- `npm run auth:biz`

## Run the backend

- Dev: `npm run dev`
- Prod: `npm run build && npm start`

### HTTP endpoints

- `GET /health` -> `{ ok: true }`
- `POST /yelp/biz/ensure-auth` -> launches Playwright (if needed) and logs into Yelp for Business (if needed)
- `GET /yelp/biz/page` -> current page URL/title (or `{ started: false }`)
- `GET /yelp/biz/status` -> current page URL/title + flags (captcha/2FA/login)
- `POST /yelp/biz/navigate` -> navigate to an allowed Yelp URL (optionally capture artifacts)

Example:

```bash
curl -sS -X POST http://127.0.0.1:3000/yelp/biz/ensure-auth
curl -sS -X POST http://127.0.0.1:3000/yelp/biz/navigate \
  -H 'content-type: application/json' \
  -d '{"url":"https://biz.yelp.com/","captureLabel":"manual-biz-home"}'
```
