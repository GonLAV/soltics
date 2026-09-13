# Solitics-style Real-Time Campaign Platform — runnable demo

A working implementation of the real-time campaign flow: a browser SDK that sends events
over REST and holds a WebSocket, a backend that ingests events and maintains user profiles,
a campaign engine that decides whether to trigger, and an action sender that pushes the
popup instruction back down the socket.

Everything runs in one Node process with no external services and no web framework —
only `ws` at runtime and `@playwright/test` for the tests.

```
CLIENT BROWSER            SOLITICS BACKEND           CAMPAIGN ENGINE          DATA STORES
┌───────────────┐  REST   ┌──────────────────┐      ┌──────────────────┐     ┌─────────────┐
│ Customer site │────────▶│ API Layer        │      │ Campaign Manager │────▶│ Campaigns   │
│               │◀────────│ (REST endpoints) │      │ Audience & Rules │     │ User Profs  │
│ Solitics SDK  │  ack    ├──────────────────┤      │ Decision Engine  │◀───▶│ Analytics   │
│               │         │ Event Ingestion  │─────▶│ Action Sender    │     └─────────────┘
│               │  WS     ├──────────────────┤      └────────┬─────────┘
│  ┌─────────┐  │◀════════│ Profile & Segm.  │               │
│  │ Popup   │  │         │ Real-time Server │◀══════════════┘
│  └─────────┘  │         └──────────────────┘   campaign instruction
└───────────────┘
```

## Quick start

```bash
npm install
npx playwright install chromium
npm start
```

| URL | What it is |
|---|---|
| http://localhost:4173/ | Mock customer website — the popup appears here |
| http://localhost:4173/dashboard.html | **Flow inspector** — every box above lights up live |
| http://localhost:4173/api/v1/health | Backend status |

Open the inspector in one tab and the customer site in another, then click "Add to cart"
and watch the request walk through API → Ingestion → Profile → Rules → Decision →
Action Sender → Real-time Server → popup.

## Suggested interview walkthrough

The demo is designed to communicate product quality and engineering judgment in about five
minutes:

1. Open the storefront and dashboard side by side. Explain that the browser uses REST for
   commands and feedback, while delivery arrives asynchronously over WebSocket.
2. Close the welcome offer, add the $40 tee, and show that the engine records
   `CONDITION_FAILED` rather than silently doing nothing.
3. Add the $75 hoodie. The cumulative $115 cart now qualifies, the journey nodes animate,
   and the free-shipping action appears on the storefront.
4. Open **Quality center** and run the audience-isolation and frequency-cap probes. These
   use the real API and decision engine, not mocked UI results.
5. Use **Decision observability** to show how stable reason codes identify the failing stage
   during an incident, then connect the three architectural risks to their controls.

This sequence demonstrates the core QA-manager decisions: observable outcomes rather than
binary pass/fail, risk-based coverage, deterministic test identities, synchronous versus
asynchronous assertions, and production-style synthetic monitoring.

## Project layout

```
popup-delivery-demo/
├─ public/
│  ├─ index.html          # mock customer website (shop UI that fires real events)
│  ├─ solitics-sdk.js     # the SDK: init → REST → WebSocket → render popup
│  ├─ dashboard.html/.js  # live flow inspector
│  ├─ theme.js            # shared light/dark toggle (cosmetic only)
│  └─ styles.css
├─ src/
│  ├─ bus.js              # internal trace bus (observability only)
│  ├─ db/index.js         # Campaigns DB, User Profiles DB, Analytics DB (in-memory)
│  ├─ backend/
│  │  ├─ api.js           # API Layer — REST endpoints
│  │  ├─ ingestion.js     # Event Ingestion & Processing
│  │  ├─ profiles.js      # User Profile & Segmentation
│  │  ├─ realtime.js      # Real-time Server (WebSocket registry + delivery)
│  │  ├─ sessions.js      # session registry
│  │  └─ inspector.js     # dashboard trace channel
│  └─ engine/
│     ├─ campaign-manager.js  # campaign definitions
│     ├─ audience-rules.js    # Audience & Rules (pure functions)
│     ├─ decision-engine.js   # "should this trigger?" + frequency capping
│     └─ action-sender.js     # builds and sends the instruction
├─ server.js              # composes everything onto one HTTP server
├─ tests/
│  ├─ contract.ts                  # what the portable tests assume (env-overridable)
│  ├─ popup-delivery.spec.ts       # portable: runs against the mock OR a real platform
│  ├─ demo-instrumentation.spec.ts # mock-only: this page's SDK panel and test hooks
│  └─ campaign-engine.spec.ts      # mock-only: engine decisions over REST
└─ playwright.config.ts
```

## The delivery chain, step by step

1. **SDK init** — `POST /api/v1/sdk/init` with a `userId`. The backend identifies the
   profile, derives segments and returns a `sessionId`.
2. **WebSocket** — the SDK opens `ws://host/ws?sessionId=…`. The Real-time Server registers
   the socket. Actions decided before the socket is live are queued and flushed on connect.
3. **Event** — `POST /api/v1/events`. Ingestion validates and normalises it, writes it to
   the Analytics DB, and folds it into the profile (counters → segments).
4. **Decision** — the Decision Engine loads active campaigns, filters by trigger event, asks
   Audience & Rules, then applies frequency caps. Every rejection carries a stable
   `reasonCode` and a human-readable explanation.
5. **Action** — the Action Sender stamps a `deliveryId`, pushes the instruction over the
   socket and records `campaign_delivered`.
6. **Render** — the SDK renders one popup, then reports `popup_displayed` / `popup_closed`
   back over REST, closing the analytics loop.

The REST ack from step 3 contains the full decision list, so you can assert on engine
behaviour without a browser — that is what `campaign-engine.spec.ts` does.

## Seeded campaigns

| Campaign | Trigger | Audience | Condition | Cap |
|---|---|---|---|---|
| `cmp-20-off` | `page_view` | `high_intent` | — | 1 / session |
| `cmp-free-shipping` | `add_to_cart` | `shoppers` | `cartValue >= 100` | 1 / session |
| `cmp-vip-only` *(paused)* | `page_view` | `vip` | — | 1 / user |

Segments are derived on every event: `visitors` (everyone), `high_intent` (unless the
`eligible: false` trait is set), `shoppers` (cart value > 0), `vip` (tier trait),
`engaged` (3+ page views).

## Test scenarios

| URL | Behaviour |
|---|---|
| `/` | Eligible user → welcome popup |
| `/?testUser=non-eligible` | Profile gets `eligible: false` → no `high_intent` segment → engine declines |
| `/?testScenario=duplicate-delivery` | Action Sender re-sends the same instruction → SDK renders one popup |
| `/?testUser=vip` | Gets the `vip` segment (activate `cmp-vip-only` in the inspector to see it fire) |
| `/?userId=alice` | Pin a known user id instead of the generated one |

## Running the tests

```bash
npm test              # headless, 25 tests
npm run test:headed   # watch it in a real browser
npm run test:ui       # interactive: step through and inspect the DOM
npm run test:api      # engine tests only (no browser, ~1s)
npm run test:contract # the 3 portable tests only
```

Tests use unique user ids per test, so they are safe under `fullyParallel`. If a server is
already running from `npm start`, Playwright reuses it rather than starting a second one.

The suite is split by how portable it is:

| Spec | Depends on | Portable? |
|---|---|---|
| `popup-delivery.spec.ts` | Two `data-testid`s and the campaign copy | **Yes** |
| `demo-instrumentation.spec.ts` | This demo's page furniture and test hooks | No |
| `campaign-engine.spec.ts` | This demo's REST API shape | No |

## Running against a real platform

Set `BASE_URL` and the mock is not started; only the portable spec runs.

```bash
# bash
BASE_URL=https://staging.example.com npm test

# PowerShell
$env:BASE_URL='https://staging.example.com'; npm test
```

Everything the portable spec assumes is an env var in [`tests/contract.ts`](tests/contract.ts):

| Var | Default | Meaning |
|---|---|---|
| `BASE_URL` | local mock | Target environment; switches the suite into remote mode |
| `URL_ELIGIBLE` | `/` | Path for a user the engine should trigger for |
| `URL_NON_ELIGIBLE` | `/?testUser=non-eligible` | How that environment addresses an out-of-audience user |
| `POPUP_TEXT` | `Special Offer` | Copy that must appear in the popup |
| `DELIVERY_TIMEOUT_MS` | `10000` | Budget for the full REST → decision → WS → render chain |
| `NO_DELIVERY_TIMEOUT_MS` | `5000` | How long before concluding nothing was delivered |

What each portable test needs from the real environment:

1. **Eligible user sees the popup** — works as soon as the popup carries
   `data-testid="campaign-popup"` and `data-testid="popup-close"`, and a campaign is live
   for the test account. If the real markup has no test ids, switch the locators to whatever
   stable attribute exists, or ask the frontend team to add them.
2. **Non-eligible user sees nothing** — needs a real way to address a user outside the
   audience. Real platforms rarely have `?testUser=` query params, so point
   `URL_NON_ELIGIBLE` at a seeded account, an excluded segment, or a staging harness flag.
   This is the one test that needs environment support.
3. **Duplicate delivery renders one popup** — needs **nothing** from the backend. It uses
   `page.routeWebSocket()` to intercept the socket, forward it to the real server, and
   re-send every campaign frame a second time. The de-duplication requirement is therefore
   testable against any environment, with no server-side test hook.

The mock-only suites do not transfer: `campaign-engine.spec.ts` asserts against this demo's
invented REST contract, and `demo-instrumentation.spec.ts` reads this page's SDK panel. To
get equivalent API coverage on the real platform, rewrite that spec against the real API,
keeping the same shape — assert on the engine's *reason*, not just the outcome.

Also expect to handle, on a real target: authentication or an SDK key, seeded test accounts,
campaign state that other people are editing while you test, and rate limits. Run the
contract suite against a dedicated staging campaign rather than a live production one.

## REST API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/sdk/init` | Identify user, create session |
| `POST` | `/api/v1/events` | Send event(s); ack includes engine decisions |
| `GET` | `/api/v1/campaigns` | List campaigns |
| `POST` | `/api/v1/campaigns` | Define a campaign at runtime |
| `PATCH` | `/api/v1/campaigns/:id/status` | Activate / pause |
| `DELETE` | `/api/v1/campaigns/:id` | Remove |
| `GET` | `/api/v1/profiles[/:userId]` | Inspect profiles and segments |
| `GET` | `/api/v1/analytics?limit=` | Analytics rows + summary |
| `GET` | `/api/v1/trace?limit=` | Recent internal trace entries |
| `GET` | `/api/v1/health` | Status |
| `POST` | `/api/v1/admin/reset` | Wipe profiles/analytics/sessions, re-seed campaigns |

Define a campaign without touching code:

```bash
curl -X POST localhost:4173/api/v1/campaigns -H "Content-Type: application/json" -d '{
  "id": "cmp-newsletter",
  "name": "Newsletter nudge",
  "trigger": { "event": "page_view" },
  "audience": { "segments": ["engaged"] },
  "conditions": [{ "field": "profile.counters.pageViews", "op": "gte", "value": 3 }],
  "frequency": { "perUser": 1 },
  "action": { "type": "popup",
    "payload": { "title": "Stay in touch", "message": "Get 10% off", "cta": "Close" } }
}'
```

Rule operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, `exists`.
Fields resolve against `profile.*`, `event.*` and `session.*`.

## Notes and limits

- All three data stores are in-memory: restarting the server resets state. Swapping one for
  a real database is a change inside `src/db/index.js` only.
- The trace bus and inspector are observability, never part of the delivery path.
- `testUser` / `testScenario` are test harness inputs, translated into ordinary profile
  traits at the API edge so the rest of the pipeline has no test-only branches — except the
  deliberate `duplicate-delivery` re-send hook in the Action Sender.
