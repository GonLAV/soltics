# Base44 Dev Environment

## Project
A Solitics-style real-time campaign delivery demo. Single Node.js process —
HTTP server + two WebSocket endpoints (`/ws`, `/ws/inspector`). No database,
no external services; all state is in-memory (`src/db/index.js`).

## Running
```bash
docker compose -f docker-compose.base44.yml up -d --build
```
App listens on port 3000 (mapped from container PORT=3000).

## Key URLs
- `/` — mock customer website (popup appears here)
- `/dashboard.html` — live flow inspector
- `/api/v1/health` — health check

## Structure
- `popup-delivery-demo/server.js` — entry point
- `popup-delivery-demo/public/` — static frontend (index.html, dashboard, SDK)
- `popup-delivery-demo/src/` — backend (api, ingestion, profiles, realtime, engine)
- `popup-delivery-demo/tests/` — Playwright tests

## Notes
- Only runtime dependency is `ws`; dev dep is `@playwright/test`.
- No external credentials needed.
- Nodemon with `--legacy-watch` is used for live reload inside the bind mount.
- Tests: `cd popup-delivery-demo && npx playwright test` (requires chromium install).
