# Interview Prep — QA Manager, Solitics

**Interviewer profile:** R&D Director. 15+ yrs. Java/Spring microservices on AWS EKS. ~1B events/day real-time. MongoDB + Redshift. Hires and mentors. He is interviewing you for **QA Manager**, so he will probe testability, observability and failure modes harder than features.

**What this document is:** the questions he is likely to ask, grounded in *this* codebase, and the answer you should give to each. Every answer here is defensible against the actual source. Where your written assignment (`public/qa-assignment.html`) contradicts the code, the contradiction is called out with the reconciling line.

**How to use it:** read section 6 last, out loud. Then re-read section 1 and 3. Those three carry most of the value.

---

## 0. The one thing that decides this interview

He is not buying the demo. A Director who runs 1B events/day knows a single-process Node demo is a toy — he built the real one. He is buying **how you talk about the toy's defects**.

So the frame for the whole hour is: *I built this, I broke it, here is the list, here is what each one becomes in production.* You volunteer the defect before he finds it. Every time he finds one first, you lose a point. Every time you hand him one he hadn't seen, you gain two.

You have a real list. Use it.

---

## 1. Opening 5 minutes

### 1.1 What he does first

He will not read your README. He will:

1. Open `http://localhost:3000/`, watch the popup fire, close it.
2. Add two items to the cart, watch the second popup fire.
3. Open `/dashboard.html` and look at the numbers.
4. **Click "Reset state" in the dashboard** — because that is what an engineer does when he wants a clean run.
5. Ask "can I add a campaign?" or "what happens if I send it garbage?"

Steps 4 and 5 are both landmines. Both are in your own findings list. Both are survivable *if you get there first*.

### 1.2 The demo sequence that survives

Run it in exactly this order and it holds:

| Step | Do | Why |
|---|---|---|
| 0 | Restart the server yourself before he arrives. Fresh process. | `campaignManager.seed()` runs at boot (`server.js:101`). Clean, known config, ~5 profiles not 30. |
| 1 | Open the **dashboard first**, on a second monitor if you have one. | The trace bus holds 500 entries ≈ 50 events (`src/bus.js:28`). Open it late and the interesting history is already evicted. |
| 2 | Open the storefront. Narrate the handshake from the Demo controls panel: userId → sessionId → `ws: open` → segments. | You are showing the *contract*, not the popup. `data-testid` attributes are on screen: `sdk-user`, `sdk-session`, `sdk-segments`, `sdk-ws`. |
| 3 | Popup fires. **Point at the dashboard** — the reason-code strip lit up `ELIGIBLE` and `TRIGGER_MISMATCH`, not just the popup. | This is your strongest design decision. Lead with it, do not save it. |
| 4 | Open a second tab with `?testUser=non-eligible`. No popup, and the dashboard shows `AUDIENCE_MISMATCH` with the human-readable reason. | Proves the negative path is observable, not just absent. |
| 5 | Click **"Run against this app"** in the Demo controls. | It spawns real Playwright (`src/backend/contract-runner.js`) against the live instance via `BASE_URL`. 3/3 green on screen. Nobody else's demo does this. |
| 6 | Only now offer reset — and say the line in 1.4. | |

### 1.3 The 30-second framing to open with

> "This is a single-process Node implementation of the architecture in the brief — SDK, API layer, ingestion, profile and segmentation, campaign engine, action sender, real-time server, three stores. It runs the whole delivery path for real, including the WebSocket. It is deliberately in-memory, so everything you'd worry about at your scale — sharding, cross-pod socket routing, durable profiles — is a `Map` here and I'll tell you exactly where each one breaks. What I actually want to show you is the decision engine returning a *reason code* for every non-delivery, because that's the part I'd argue for on a real platform."

That sentence does four things: sets scope, pre-empts the scale question, signals you know the gaps, and steers him to your best work.

### 1.4 The reset landmine — say it before he clicks

`POST /api/v1/admin/reset` calls `sessions.clear()` but `realtime.reset()` only clears the `pending` map — it never closes the sockets (`src/backend/realtime.js:90-92`). So every open customer tab keeps a socket that looks connected, while every event it sends now 404s with *"Unknown sessionId"*. The SDK's `track()` swallows it into a log line (`public/solitics-sdk.js:182-185`) and never re-handshakes. The tab looks alive and is dead.

Say, before touching it:

> "One thing before you use that reset button — it's a bug and it's mine. It clears sessions but doesn't close the sockets, so any tab that's already open goes into a state where it *looks* connected and every event 404s. The SDK swallows the error and never re-handshakes. In production that's the whole class of bug I care most about: a client that is confidently wrong. The fix is two lines — close the sockets in `realtime.reset()` and have the SDK re-init on a 404 from `/events`. Use 'Start with a new customer' in the storefront instead; that one's clean."

You have just turned the thing that would have killed your demo into the single most senior thing you say in the first five minutes.

### 1.5 If he clicks it anyway

Don't fight it. Reload the storefront tab (that re-runs `init()` and mints a new session), say "that's the workaround, and the fact that the workaround is 'reload the page' is the bug," and carry on. Do not restart the server mid-demo — restart re-seeds campaigns and you lose any runtime state you were mid-way through explaining.

---

## 2. Questions by theme

Format for each: **Q** (his voice) · *why he asks* · **A** (yours) · **Follow-up** · **A2**.

---

### 2A. Architecture & scale

---

**Q1.** "You hold profiles in a `Map`. At a billion events a day, where does this become Mongo, and what is the write path?"

*Why:* He runs exactly this. He wants to know if you understand that the profile is a read-modify-write on a hot key, not a row.

**A.** "`profilesDb` in `src/db/index.js` is a `Map<userId, profile>` and `profiles.applyEvent` does read → mutate counters → re-derive segments → save. That's fine in one process because it's synchronous. In production the profile is a Mongo document keyed by `userId` — traits, counters, segments, and the `deliveries` subdocument that holds the frequency counters. The write path is not read-then-write from the app: it's a single `findOneAndUpdate` with `$inc` on the counters, so the increment is atomic server-side, and segments are re-derived from the returned document. Sharded on `userId` — hashed, not ranged, because our access is point-lookup by user and we have no range queries on it. The hot part — the frequency counters — I'd keep in Redis with a TTL equal to the session, and treat Mongo as the durable copy."

**Follow-up.** "Segments are recomputed on every event. At 11,000 events a second that's 11,000 recomputes a second."

**A2.** "`computeSegments` is a pure function of traits plus counters — that's deliberate, it's the one thing in the engine I'd keep exactly as it is, because it's reproducible and testable in isolation. But recomputing it inline on the write path only works because it's four `if` statements. Real segmentation has hundreds of rules and windowed aggregates, so it splits: cheap derived segments stay inline on the event path, expensive ones move to a batch job writing back into the profile, and the decision engine reads a snapshot with a stated freshness budget. The QA consequence is the interesting bit — once segmentation is eventually consistent, 'did this user get the popup' stops being a yes/no and becomes 'was the profile fresh enough at decision time', and that needs a test that asserts on staleness, not on outcome."

---

**Q2.** "The socket registry is a `Map` in one process. Three pods behind an ALB — a decision made on pod A, socket held by pod B. What happens?"

*Why:* The single most important distributed-systems question about this design. He already knows the answer; he wants to hear which of the two options you pick and why.

**A.** "Today it's lost — `sockets` in `src/backend/realtime.js:10` is process-local, so `sendToSession` on pod A finds nothing, queues it in a `pending` map on pod A, and it flushes to nobody. Two ways out. Sticky sessions at the ALB pin a sessionId to a pod, which is the cheap fix and I'd reject it: it makes deploys lossy, breaks on scale-in, and turns a pod restart into a delivery outage for everyone on it. What I'd build is a Redis pub/sub channel per pod — each pod subscribes to its own topic, a Redis hash maps `sessionId → podId`, and the action sender publishes to the owning pod's topic. Registry entry gets a TTL and is refreshed by the socket's heartbeat, so a dead pod's sessions expire instead of black-holing."

**Follow-up.** "And if Redis says pod B owns it but pod B is already gone?"

**A2.** "Then the publish lands nowhere and we've lost a delivery silently — which is the failure mode I'd refuse to ship without a metric on. The `pending` queue has to move out of the process too: queue in Redis keyed by sessionId with a short TTL, and flush on socket *connect* rather than on decide, so whichever pod the client reconnects to picks it up. That also fixes the demo's real gap — here, `pending` is in RAM and a restart drops it with nothing logged."

---

**Q3.** "You measured 330 events a second. We do 11,600. What's the first thing that falls over?"

*Why:* Checking whether you profile or guess.

**A.** "Not the JSON parsing — the decision loop. `decisionEngine.decide` calls `campaignsDb.listActive()` per event, which is a full filter over every campaign, *and* emits a trace line per call. Then it evaluates every active campaign against the event, including the ones whose trigger doesn't match, just to emit a `TRIGGER_MISMATCH` decision. With three campaigns that's free; with ten thousand it's the hot loop and the analytics store fills with mismatch rows — you can see it live, `TRIGGER_MISMATCH` is 52 of 104 decision rows on the instance right now. First fix is an index: `Map<eventName, Campaign[]>`, rebuilt on campaign change, so an event only sees the campaigns that could possibly fire. Second is to stop persisting `TRIGGER_MISMATCH` as an analytics row and make it a counter instead. Those two are maybe an hour and they're the difference between O(campaigns) and O(matching campaigns) per event."

**Follow-up.** "330 a second on one connection. What was the bottleneck in the measurement?"

**A2.** "One connection, one process, one core — so that number is a floor on the code, not a ceiling on the design. It's single-process Node with synchronous ingestion, so it's CPU-bound on a single core with no I/O to overlap. The honest reading is: it tells me the per-event cost is about 3ms of CPU, most of it trace emission and the decision loop, and that's the number worth optimising. It tells me nothing about horizontal scale, because nothing here is horizontal."

---

**Q4.** "Where does Kafka go in this, and what's the partition key?"

*Why:* His stack. Also the sharpest possible test of whether you understand the frequency-cap race.

**A.** "SDK posts to an edge collector, collector writes to Kafka, and **partition by userId** — that one choice is what kills the frequency-cap race without a distributed lock. All events for a user land on one partition, one consumer owns that partition, so the read-modify-write on that user's profile is single-writer by construction. That's the same property that makes my cap correct in the demo today, just earned properly instead of by accident. Decision engine is a consumer group; action sender publishes to the socket layer; analytics forks off the same topic into Redshift via a batch sink, because Redshift hates row-at-a-time. The QA consequence is that ordering is only guaranteed *within* a partition, so any test about sequencing has to be scoped per user, never global."

---

### 2B. Delivery semantics & idempotency

---

**Q5.** "The transport is at-least-once and the SDK dedups in browser memory. What dedups after a page reload?"

*Why:* This is his idempotency question and he will not accept 'the SDK handles it'.

**A.** "Nothing. `state.renderedDeliveries` and `renderedCampaigns` are `Set`s in the SDK closure (`solitics-sdk.js:22-23`), so a reload wipes both, and a reload also mints a brand-new session via `sdk/init`, so the server's `perSession` cap resets too. Refresh the page and `cmp-20-off` fires again — identity persists in localStorage, the session doesn't. That's a real defect, not a demo shortcut, and the demo makes it worse by being honest: the frequency cap you see working in the test is a per-session cap, and sessions are free. The production answer has two halves. Server side, the cap that matters is `perUser` with a time window — `cmp-vip-only` is already defined that way — backed by an atomic counter in Redis. Client side, the delivery ledger has to survive the reload, so `renderedDeliveries` becomes a bounded localStorage set keyed by deliveryId with a TTL."

**Follow-up.** "So the dedup key is the deliveryId. Who issues it, and is it stable across a retry?"

**A2.** "Today the action sender mints a fresh `randomUUID` per send (`action-sender.js:23`), so it is *not* stable — if the platform retried the decision, you'd get a new deliveryId and the SDK's delivery-level dedup would miss. It only works in the demo because the duplicate-delivery hook re-sends the *same* message object. Correct design is a deterministic idempotency key — hash of `(campaignId, userId, sessionId, triggering eventId)` — so a retried decision produces the same key and the dedup is real rather than incidental. That's the one design change I'd make to this code before anything else on this theme."

---

**Q6.** "`campaign_delivered` — delivered where? To the socket, or to the screen?"

*Why:* The gap between 'we sent it' and 'they saw it' is the entire delivery-rate metric his Marketing team argues about.

**A.** "To the socket, and not even that — `analyticsDb.record('campaign_delivered')` fires right after `realtime.sendToSession` returns, and that return only tells us whether a socket was open (`action-sender.js:66-72`). The row carries `queued: true/false`, so you *can* separate 'pushed' from 'parked in a queue', which I'd keep. But it is not a render. The only evidence of a render is the SDK posting `popup_displayed` back over REST, and the real delivery rate a marketer cares about is `popup_displayed / campaign_delivered`, not `campaign_delivered / events`."

**Follow-up.** "Then feed me a `popup_displayed` for a deliveryId I never issued."

**A2.** "It'll take it. `ingestion.ingest` routes anything in `FEEDBACK_EVENTS` straight to analytics and returns before the decision engine — no check that the `deliveryId` in the properties was ever minted, no check that it belongs to that session. So attribution is forgeable by anyone with a session, which on a customer's website is anyone with a browser console. It's the vulnerability I'd fix first of everything on this list, because it corrupts the number the business makes decisions on rather than breaking something visible. Fix is a delivery ledger: the action sender writes `deliveryId → {sessionId, campaignId, issuedAt}`, feedback validates against it, and an unmatched feedback event gets recorded as a separate `orphan_feedback` metric rather than silently dropped — because a spike in orphans is itself a signal."

---

**Q7.** "Same user, two tabs. What do they each get?"

*Why:* Identity vs session scoping, and he can do this in four seconds while you talk.

**A.** "Same `userId` — it's in localStorage under `solitics_user_id` and shared across tabs. Different sessionId, because `init()` runs per page load and `sessions.create()` mints a fresh UUID. So both tabs get the popup, because the cap is `perSession: 1`. Worse: both tabs open a socket with different sessionIds, so both are live and both render. If they *shared* a sessionId, the second socket would silently replace the first in the registry — `sockets.set(sessionId, ws)` overwrites without closing the old one (`realtime.js:31`), and the orphaned socket stays open receiving nothing forever. Neither behaviour is what you'd want. In production the session is server-issued, stored in a cookie so tabs share it, has a TTL, and the registry holds a list of sockets per session with an explicit takeover policy — close the old one, or fan out to all of them, but decided rather than accidental."

---

### 2C. State, persistence & failure

---

**Q8.** "Restart the server mid-session. What did I just lose?"

*Why:* In-memory everything. He'll do it if you let him.

**A.** "Profiles, sessions, analytics, the trace bus, the pending delivery queue — all of it, they're module-level `Map`s and arrays. And one thing worse that people miss: **campaign configuration reverts to the seed**. `server.js` calls `campaignManager.seed()` on boot, so any campaign defined at runtime is gone, and any campaign an operator *paused* at runtime comes back active. Think about what that means on EKS: an operator pauses a misfiring campaign during an incident, an HPA event recycles a pod, and that pod comes up serving the campaign again. Only the recycled pods misbehave — which reads in the dashboard as 'only some customers affected, no deployment occurred'. That's Part 5's scenario, and this code can actually produce it."

**Follow-up.** "So how do you test for that?"

**A2.** "You can't test it from outside a single process, which is exactly why it's dangerous. The test that catches it is a startup-invariant test: on boot, assert that the campaign set loaded from the store matches the store, and that seeding is idempotent-and-only-when-empty rather than unconditional. Then a synthetic check in production that reads the effective campaign config from every pod — not from the load balancer — and alerts on divergence. Config drift between pods is the kind of thing you only find if you deliberately go looking per-instance."

---

**Q9.** "Define a campaign with a bad shape. Does your validation hold?"

*Why:* Data-driven campaign models are his production reality — campaigns change without a deploy.

**A. Volunteer this one rather than waiting for it.** "No, and this is the most serious bug in the system, so let me just show you. `campaignManager.define` checks three things: that there's an `id`, a `trigger.event`, and an `action.type` (`campaign-manager.js:77-79`). Nothing else. The defaults are spread *before* the incoming object, so if I POST `conditions: {}` — an object where the engine expects an array — the object wins. It's accepted with a 201. Then the first event matching that trigger hits `for (const condition of conditions)` in `audience-rules.js:45`, throws `conditions is not iterable`, and that propagates out of `decide()`, out of `ingest()`, and the API returns a 500. Every event of that type, for every user, on every pod running that config. One malformed campaign definition takes down a trigger platform-wide."

**Follow-up.** "How do you get out of it at 2am?"

**A2.** "Two ways, both fast: `PATCH /api/v1/campaigns/{id}/status` to paused, or `DELETE` the campaign — `listActive()` stops returning it and the pipeline recovers immediately. Restarting also works, because it re-seeds, but it takes the config drift with it so I wouldn't. The real fixes are in layers. One, schema-validate the definition on write — JSON Schema, ajv, rejecting on shape not just presence. Two, dry-run every campaign against a synthetic profile before it's allowed to go active. Three, and this is the one I'd insist on, a per-campaign circuit breaker in the decision loop: wrap each campaign's evaluation in try/catch, return `reasonCode: 'EVALUATION_ERROR'` instead of throwing, and auto-quarantine a campaign after N consecutive throws. That's about six lines in `decision-engine.js` and it converts a platform outage into one broken campaign and an alert. Blast radius is the thing, not the bug."

---

**Q10.** "Sessions and profiles are `Map`s with no eviction. What's your memory story?"

*Why:* He's run out of heap in production before.

**A.** "There isn't one, and you can see it — the instance running now has 43 sessions and 30 profiles after an hour of nothing but me clicking. Nothing expires. Analytics is the only bounded store, capped at 2000 rows with a `shift()` (`db/index.js:90`), which is also O(n) on every write past the cap and `summary()` is a full scan on every dashboard poll. In production sessions live in Redis with a TTL, profiles live in Mongo with the working set cached, and analytics never lives in the service at all — it goes to Kafka and lands in Redshift. The part I'd carry forward from the demo is the *shape* of the analytics rows: typed rows with `campaignId`, `userId`, `sessionId`, `deliveryId`, `reasonCode`. That shape is what makes the incident query in Part 5 a single group-by."

---

**Q11.** "I drop the WebSocket before the action is pushed. Lost or delivered?"

*Why:* This one your code actually gets right. Let him find it — then take the credit precisely.

**A.** "Delivered. `sendToSession` checks `readyState`, and if there's no live socket it pushes onto a per-session `pending` queue; the `connection` handler drains that queue on connect before anything else (`realtime.js:38-43`). So a campaign decided during the REST handshake, before the socket finishes, still lands. That's the case the SDK's connect-before-first-event ordering is designed around. Where it's honest rather than impressive: the queue is in RAM with no TTL and no bound, so it survives a socket drop but not a process restart, and a session that never reconnects leaks its queued messages forever. Redis list with a TTL, flushed on connect, is the production version — same semantics, durable."

---

### 2D. Observability & on-call

---

**Q12.** "Your trace bus keeps 500 entries in RAM. What does the on-call engineer read at 3am?"

*Why:* He wants metrics, not logs, and he wants to hear you say the word cardinality.

**A.** "Not the trace bus — it's a demo instrument. 500 entries at roughly ten trace lines per event is about fifty events of history, and under a 600-event burst the action-sender and realtime lines are the first evicted, which is precisely the window you'd want. It's the right tool for showing a Director a request walking through the architecture, and the wrong tool for 3am. At 3am the on-call reads three metrics. Delivery latency as a histogram from decision to socket ack, p99 not mean. WebSocket connection and reconnect rate per pod. And the one that actually matters here — the **decision reason-code distribution**, `decisions_total{campaign, reasonCode}`, as a rate. Logs are for after you know which campaign; the reason-code distribution is what tells you which campaign."

**Follow-up.** "Why is the reason-code distribution better than a delivery-rate alert?"

**A2.** "Because a delivery-rate alert tells you something is wrong and a reason-code shift tells you *what*. Delivery rate dropping from 98% to 67% is the Part 5 scenario and it's un-actionable on its own. The same drop with `AUDIENCE_MISMATCH` going from 2% of decisions to 35%, concentrated on one campaign, is a segmentation or config problem and you know who to wake. The same drop with `FREQUENCY_CAP` spiking is a session-identity problem. The same drop with reason codes *unchanged* means decisions are fine and the loss is in transport — go look at the sockets. Three different on-call paths, distinguished by one dimension. The engine already emits it; it's in the analytics summary as `byDecisionReason` and it's on the dashboard as the reason strip. That's the design decision from this whole exercise I'd bring to a real platform and argue for."

---

**Q13.** "Your dashboard says delivery rate. Rate of what over what?"

*Why:* It is wrong, he will do the arithmetic, and it is the number Marketing would quote.

**A. Get there first.** "It's `campaign_delivered / byType.event` (`dashboard.js:392-395`) and it's misleading — I'd call it broken. `popup_displayed` and `popup_closed` are ingested as ordinary events, so they're counted in the denominator. A perfect journey is three events and one delivery, so the metric caps at 33% no matter how well the system works. It reads 39% on the instance right now, and that's only above 33% because duplicate-delivery test runs inflate the numerator. The correct metric is per-campaign: eligible decisions as the denominator, deliveries as the numerator, with a separate render rate of `popup_displayed / campaign_delivered`. Two numbers, both meaningful, neither one a ratio of unlike things."

**Follow-up.** "How did that ship?"

**A2.** "Because it's the one number in the system with no test on it. Everything behind it — decisions, reason codes, caps, delivery — is asserted in the API suite. The dashboard's arithmetic isn't, because it's a display and I treated it as chrome. That's the wrong instinct and it's general: **the numbers a business reads are a contract and need tests like one**. If I'd written a test that seeds a known journey and asserts the displayed rate, the bug would have been obvious in thirty seconds. That's the test I'd add first if you gave me another hour."

---

**Q14.** "You have no correlation id. How do I follow one delivery across services?"

*Why:* Standard, but the answer here is better than usual because the ids already exist.

**A.** "Partly wrong — the ids exist, they're just not propagated as a header. Every event gets an `eventId` at normalisation and every delivery gets a `deliveryId` at send, and both appear in the trace payloads, so within the process you can already follow one delivery end to end. What's missing is that they're not on the wire. In production the SDK generates a request id, the collector carries it, and `eventId → decisionId → deliveryId` are logged as a causal chain with the request id on every hop. Then the `popup_displayed` callback echoes the deliveryId, which closes the loop client-side. That's what makes 'this specific customer says they saw two popups' a query rather than an investigation."

---

### 2E. QA strategy and the test suite  ← *heaviest weight, he is hiring for this*

---

**Q15.** "Walk me through what you actually test, and what you decided not to."

*Why:* The core question. He is listening for a *decision*, not a list.

**A.** "Twenty-seven Playwright tests in three files, split by portability, which is the split I'd defend. Seventeen are API-level against the backend with no browser — they pin the decision engine's *reasons*, not just outcomes, so `AUDIENCE_MISMATCH` versus `FREQUENCY_CAP` versus `CONDITION_FAILED` are separate assertions. Three are the portable contract: they depend on nothing but two `data-testid`s, the campaign copy and a way to address a non-eligible user, all env-overridable in `tests/contract.ts`, so the same file runs against staging with `BASE_URL`. Seven are mock-only and test this demo's instrumentation. What I chose not to test: anything about visual appearance, and anything about the demo storefront's own shop logic beyond the one cart-drawer test, because neither is the product. What I'd cut if I had to: the cart drawer test and the dashboard probe test. They assert on demo furniture."

**Follow-up.** "Ninety seconds on every commit. Which survive?"

**A2.** "All seventeen API tests — they're sub-second each, no browser, and they cover the logic that's actually risky. All three contract tests, because they're the only proof that a decision reaches a DOM node, and if I cut those the suite stops testing the product. From the mock-only seven I keep the server-side duplicate-delivery test, because idempotency is the requirement most likely to regress silently, and I drop the other six to a nightly. That's twenty-one tests, and the cut is by *what regression it catches*, not by runtime — the two browser suites are the slow ones and I'm keeping four of them, because speed is not the criterion, blast radius is."

---

**Q16.** "Which of your tests are flaky, and why?"

*Why:* The honest-engineer test. Claiming zero flake is the wrong answer even if true.

**A.** "Three risks, in order. First, two `waitForTimeout` calls remain — `popup-delivery.spec.ts:69` and `demo-instrumentation.spec.ts:38` — both waiting for a duplicate to *not* produce a second popup. Those are time-based by construction, and on a loaded CI box a slow duplicate arrives after the assertion and the test passes for the wrong reason. Second, `playwright.config.ts` sets `reuseExistingServer: !CI` and `fullyParallel: true` against one shared in-memory backend, so parallel workers share campaign state; every API test uses a unique userId, which is what saves it, but the campaign-manager tests mutate global campaign config and only clean up on the happy path. If one fails mid-test it leaks a campaign. Third, `DELIVERY_TIMEOUT` is 10s and retries are zero locally — a cold CI container doing a browser launch plus a WebSocket handshake can genuinely exceed that, and it'll look like a product bug."

**Follow-up.** "You told me in your written answer that a production-ready suite has no `waitForTimeout` anywhere. You have two."

**A2. — this is the contradiction he is most likely to find, have this ready verbatim.** "Correct, and I should have caught that before submitting. Here's the reconciliation and here's the fix. Both remaining sleeps are waiting on the *absence* of something — a second popup that must not render — and you can't state-wait on a non-event. That's the reason, not an excuse, because there is a correct version: both tests already have a positive signal available. The contract test counts intercepted duplicate frames and asserts `duplicated > 0`, and the instrumentation test polls the SDK log for the 'Ignored duplicate' line. So the right shape is `expect.poll` until the *ignore* is observed — which is a real state change — and only then assert `toHaveCount(1)`. Zero sleeps, strictly stronger, and it fails fast instead of after 600ms. That's a ten-minute change I'd make before this went near a CI pipeline, and the general rule behind it is that an absence assertion needs a paired presence assertion or it's untrustworthy."

---

**Q17.** "Your suite is green. Prove it isn't green because it can't fail."

*Why:* The single best QA question there is, and your own Part 3 answer names mutation as the check — so he's testing whether you actually did it.

**A.** "Three ways, and I'd want all three in a real pipeline. Cheapest: pause `cmp-20-off` via the API and re-run — the contract test's positive case must fail, and the `AUDIENCE_MISMATCH` test must keep passing, because they test different things. Second: rename the `data-testid` on the popup and confirm the contract tests fail while the API tests stay green — that proves the layers are actually independent rather than both passing for the same reason. Third, the real one: mutate the engine. Invert the comparison in `withinFrequencyCap`, flip `match: 'any'` to `'all'` in `matchesAudience`, change `gte` to `gt` in the operator table. Each of those should kill exactly one named test. If a mutation kills nothing, I have a coverage hole; if it kills everything, my tests are coupled. In this suite the operators in `audience-rules.js` are the honest gap — only `gte` is exercised by a test, the other eight are covered by nothing."

**Follow-up.** "So you'd run mutation testing in CI?"

**A2.** "Not on every commit — it's too slow and the signal is too noisy at that cadence. Nightly on the decision engine only, because that's the module where a silent logic inversion has real business cost and where the code is pure functions with no I/O, so it's cheap to mutate. Everywhere else I'd rather spend the budget on the deliberate-break checklist as a release gate: a short list of 'break this, this test must fail', run by hand before a release, owned by QA. Less rigorous, ten times more likely to actually happen."

---

**Q18.** "You have a button that runs your own tests against the running app. Why?"

*Why:* He noticed. It's unusual. He wants to know if it's a gimmick.

**A.** "Because 'the tests pass' is a claim and I'd rather show the thing than assert it. The button POSTs `/api/v1/qa/run-contract`, which spawns the real Playwright CLI on `tests/popup-delivery.spec.ts` — the same file CI runs — with `BASE_URL` pointed at the instance you're looking at. With `BASE_URL` set, `playwright.config.ts` skips the mock-only suites and starts no server of its own, so it genuinely exercises what's on screen. The point it's making is the one I care about: those three tests are portable. Change two environment variables and they run against your staging environment instead. Where I'd be careful: it's an unauthenticated endpoint that spawns a browser process, which is a denial-of-service surface — guarded by an in-flight lock and a 120-second kill, but it's a local demo tool and I would not expose it beyond localhost. And it writes real analytics rows, so the dashboard numbers move when you press it."

---

**Q19.** "Two QA engineers, five backend, four frontend, one DevOps. Who writes the tests?"

*Why:* The management question inside the QA question.

**A.** "Developers write unit and integration tests and they own them — QA writing unit tests for other people's code is how you get a QA team that's permanently behind. QA owns three things nobody else can: the API contract, the browser contract, and production signal. The split I used here maps to that exactly — `campaign-engine.spec.ts` is the API contract, `popup-delivery.spec.ts` is the browser contract and it's deliberately portable so it can point at any environment, and the reason-code distribution is the production signal. With two QA against nine engineers the only sustainable model is that QA builds the harness and the gates, and engineers fill them. If QA is the bottleneck on merge, the ratio has already failed."

**Follow-up.** "And when a developer's test is bad?"

**A2.** "It gets reviewed like code, by the same standard, and the review comment names the failure mode rather than the style — 'this passes if the popup renders empty' is actionable, 'use a better assertion' isn't. The pattern I'd automate is the cheap one: a lint rule that fails a PR on `waitForTimeout` in a test file, with an escape hatch that requires a comment justifying it. Rules that a machine enforces don't cost me relationship capital; rules I have to enforce in review do, and I want to spend that capital on the judgment calls."

---

### 2F. AI-assisted engineering (Parts 2 and 4)

---

**Q20.** "How much of this did the AI write?"

*Why:* He will ask. Directly. Your assignment says 'AI-assisted' in the header and 'Claude Code throughout' in the summary, so evasion is not available and is not the right answer anyway — the assignment *invited* it.

**A.** "Most of the code, and I directed all of it. Concretely: I specified the architecture and the module boundaries — the eight components in the brief map one-to-one onto files, and that was my call because it makes the demo legible to someone reading the diagram. I specified that every non-delivery must carry a machine-readable reason code, which is the one design decision I'd defend hardest and which the model did not suggest. I specified the portable-versus-mock test split. The model wrote the implementation faster than I could and I reviewed it the way I'd review a strong contractor's work. Where I'd score myself down: I reviewed for 'does it work' harder than 'how does it fail', which is why the findings list I'm about to hand you exists — I found the reset bug and the campaign-validation bug by going back and attacking my own system afterwards, not during the build."

**Follow-up.** "Give me one thing it got wrong that you caught."

**A2.** "The delivery-rate metric on the dashboard — `delivered / events`, where feedback events are in the denominator, so it can't exceed 33%. It's plausible-looking code and it passed every test because no test covered it. That's exactly the AI risk I wrote about in Part 4 as 'false confidence': the failure isn't code that doesn't compile, it's code that's coherent and wrong in a place nothing asserts. The generalisable lesson for a QA org is that AI shifts the risk from *implementation* defects, which tests catch, to *specification* defects, which they don't — so the human review budget moves from reading diffs to questioning whether the assertion is measuring the right thing."

---

**Q21.** "Somebody on your team ships an AI-written test that passes for a year and never could have failed. How do you find it?"

*Why:* Part 4's central claim, stress-tested.

**A.** "Systematically, not by reading. Three mechanisms. One, coverage of the *assertion*, not the line — a test that executes a branch and asserts nothing is invisible to line coverage and obvious to mutation testing, so the nightly mutation run on the core engine is the detector. Two, a flake-and-triviality report: any test that has never failed in its lifetime, in any run, on any branch, gets flagged for review — a test that has never been red is either testing something extremely stable or nothing at all, and it's cheap to look. Three, the deliberate-break checklist as a release ritual, which catches the class the machines miss. And one policy, which is in my Part 4 answer and which I'd actually enforce: at least one human-authored acceptance test per feature, written before or independently of whatever the AI drafted, so there's always one assertion that came from someone who understood the requirement rather than the code."

---

**Q22.** "Your submission ends with a note telling *you* to review it before submitting. You left the model's instructions to you in the document."

*Why:* He reads carefully. The last callout in `qa-assignment.html` reads *"This document is a strong first draft produced with heavy AI assistance... Before submitting, review every section, adjust anything that doesn't match how you'd actually reason about it, and be ready to defend each decision."* That is the assistant talking to the candidate, shipped to the customer. **This is the single most damaging line in the submission.** If he reads it and you haven't addressed it, it reframes the entire document.

**A. — pre-empt this. Raise it yourself, early, ideally in the first ten minutes.** "One thing I want to flag before you find it, because you will. The last callout on the assignment page is the model's note *to me* about reviewing before submission, and I left it in. It's a proofreading failure and it's a slightly embarrassing one for a QA candidate. I'm not going to pretend it was intentional. What I'd say about it: it's the exact class of defect I'd want my process to catch — output that is fine in isolation and wrong in context, invisible to any automated check, and only caught by a human reading the artifact as its audience would. Which is why the human gate in my Part 4 model sits on interpretation and release decisions and not on syntax. I'd rather have shown you the process working than named it, and I didn't."

**Follow-up.** "And the rest — how much of it do you actually stand behind?"

**A2.** "All of it, and I can tell you which parts I've since found are wrong against my own code, which is a better answer than 'all of it'. Three: I wrote that a production-ready suite has no `waitForTimeout` and mine has two — I explained the reconciliation and the fix. I wrote '25-test suite' and it's 27, a counting error from before I added the contract file. And in Part 1 I listed concurrent profile mutation as a top-three risk, and when I actually load-tested it with 200 concurrent events, the cap held perfectly — one delivered, 199 `FREQUENCY_CAP` — because `ingest()` is synchronous with no `await` between the read and the write. So the risk I named is real in a three-pod deployment and not real in this demo. I'd rather correct that in the room than have you find it."

---

### 2G. Leadership & process

---

**Q23.** "Your first ninety days. Two QA, nine engineers, an existing suite you didn't write."

*Why:* He is hiring a manager, not a test author.

**A.** "First two weeks I don't change anything, I measure. Three numbers: wall-clock time of the suite per commit, flake rate per test over the last hundred runs, and the last ten production incidents mapped against whether a test could have caught them. That last one is the only honest prioritisation input — it tells me whether the gap is coverage, environment, or observability, and those need completely different fixes. Weeks three to six, whatever that says. If it's flake, I quarantine the flaky tests out of the blocking gate immediately rather than letting the team learn to ignore red, and fix them on a schedule. If it's coverage, I find the module where a silent logic error costs the most and start there — here that would be the decision engine. By ninety days I want one thing to be different and visible: a gate people trust. A suite everyone ignores is worse than no suite, because it costs the same and provides confidence it hasn't earned."

**Follow-up.** "What if the answer is 'we have no observability' rather than a test gap?"

**A2.** "Then that's the job and I'd say so on day fifteen rather than building tests to look busy. In a real-time delivery platform the production signal is the higher-leverage investment — the reason-code distribution in this demo is worth more than any five tests I wrote, because it's the difference between 'delivery dropped' and 'this campaign's audience rule broke for this customer'. If I found a team with decent tests and no production signal, I'd spend the first quarter on metrics and synthetic checks, and I'd expect the incident count to move more than it would from a test-coverage push."

---

**Q24.** "A release is due, and the only failing test is one you think is wrong. What do you do?"

*Why:* Judgment under pressure, and whether you'll be a blocker or a rubber stamp.

**A.** "I don't overrule it quietly, and I don't block the release on principle. I do three things in order: determine whether the test is wrong or the *requirement changed under it*, because those look identical and mean opposite things. If the requirement changed, the test gets updated, the PR names the change explicitly, and someone who owns the feature approves it — a weakened assertion never merges on QA's signature alone, that's in my Part 4 answer and I'd hold to it. If it's genuinely a bad test, the release goes, and the test gets a ticket with an owner and a date, not a `.skip` that lives forever. What I won't do is declare a test wrong under time pressure without writing down *why*, because that's the decision that erodes a gate — do it three times and nobody believes the suite."

---

**Q25.** "How do you know your QA team is doing a good job?"

*Why:* Metric literacy. Most candidates answer with coverage.

**A.** "Not coverage and not test count — both go up when the team is doing badly. Escaped defect rate, weighted by severity, is the outcome metric. Two leading indicators I'd actually watch day to day: time-to-diagnosis on incidents, because that measures whether the observability work is paying off, and the fraction of defects found before the merge gate versus after. And one qualitative signal that's better than any of them — when an engineer is about to ship something risky, do they come to QA first? If they do, the team is a resource. If they route around it, the team is a tax, and the numbers won't tell you which one you have."

---

## 3. Questions where the honest answer is "this demo doesn't do that"

Being straight about a cut corner *and naming the production design* reads as senior. Bluffing does not, and he will detect it because he has built the real version.

**The template, use it every time:**
> "It doesn't. [What it does instead, in one clause.] In production that's [specific mechanism]. I cut it because [scope reason, not 'I ran out of time'] — and the thing it costs me is [the specific consequence]."

That last clause is what separates a good answer from a deflection. Naming the cost proves you understand the gap rather than having memorised a fix.

| If he asks | Say |
|---|---|
| **"Where's authentication?"** | "There isn't any. `sessionId` in the WebSocket query string is the only credential and it's a bearer token in a URL, which means it's in access logs and Referer headers. Anyone with a sessionId can impersonate that session and post feedback events for it. Production: signed short-lived token in the handshake, per-customer API key on the collector, sessionId never in a URL. What it costs me here is that I cannot demo tenant isolation at all, and on a multi-tenant platform that's the security property that matters most." |
| **"Multi-tenancy?"** | "None. One campaign namespace, one profile namespace. Every campaign is global. Production: `tenantId` as the leading component of every key and the shard key on the profile collection, with the decision engine reading a tenant-scoped campaign index. The cost is that the blast radius bug I showed you — one malformed campaign killing a trigger — is *unbounded* here; with tenancy it's at least bounded to one customer, which is the difference between an incident and an outage." |
| **"Retries and DLQ?"** | "No retry anywhere. A failed push is queued in memory or lost, and there's no dead-letter path. Production: Kafka consumer with bounded retry and a DLQ topic, plus the idempotency key I described so a retry is safe to deliver. The cost is that I have no way to distinguish 'never sent' from 'sent and dropped', which is exactly the ambiguity that makes Part 5 hard." |
| **"Rate limiting / backpressure?"** | "None. `POST /api/v1/events` will accept whatever you send until the process falls over — 256KB per body is the only limit. Production: per-key rate limit at the edge, and the collector shedding load by dropping *low-value* events first rather than uniformly, because dropping a `page_view` costs a decision and dropping a `purchase` costs money. The cost is I can't show you graceful degradation, only the cliff." |
| **"Schema evolution on events?"** | "`event.properties` is an untyped bag — `properties && typeof properties === 'object'` is the whole validation. Production: a schema registry with compatibility checks in CI, so adding a field is safe and changing one is a build failure. The cost here is that a customer renaming a property silently breaks every campaign condition that reads it, with no error — it resolves to `undefined` and the condition just fails. That's a silent-wrong, and it's the failure mode I'd be most afraid of at your scale." |
| **"GDPR / right to erasure?"** | "Not modelled. A profile is keyed by a localStorage id and never expires or deletes. Production: deletion by userId propagating to the profile store, the analytics store and the Redshift warehouse, with a documented completion SLA — and the warehouse is the hard part, not the service. The cost is that I'm storing a behavioural profile with no lifecycle, which on a real platform isn't a gap, it's a legal exposure." |
| **"Canary or blue-green for campaigns?"** | "No. A campaign is active or paused, full traffic either way. Production: a `rollout` field on the campaign — percentage of eligible users, hashed on userId so it's stable per user — and a per-campaign kill switch separate from status. That's also the QA lever I'd want most: it lets me ship a campaign to 1% and watch its reason-code distribution before it goes wide. The cost is that every campaign change here is a full-blast-radius change." |
| **"Load test results?"** | "One measurement: ~330 events/sec on a single connection, single process, and a 200-concurrent burst against the frequency cap that came out correct — 1 delivered, 199 `FREQUENCY_CAP`. That's not a load test, it's two data points, and I'd rather call it that than dress it up. A real one needs sustained multi-connection load with latency percentiles and a defined SLO to fail against, and I don't have an SLO here to fail against." |

---

## 4. Traps — where the obvious answer is wrong

---

**Trap 1 — "Your frequency cap survived 200 concurrent events. Good, right?"**

*Obvious answer:* "Yes, the cap works."
*Why it's wrong:* It works for a reason you didn't design, and he will ask why on the next breath. Claiming the win makes the follow-up a correction instead of a continuation.

**Better:** "It survived, and I want to be precise about why, because the reason doesn't generalise. `ingest()` is fully synchronous — there is no `await` anywhere between `withinFrequencyCap` reading `profile.deliveries` and `recordDelivery` writing it back. Node's event loop can't interleave, so it's atomic by accident. That makes it correct in one process and wrong in three: the instant this is two pods against a shared store, it's a classic lost update and you get two popups. The design that fixes it is partitioning by userId so there's one writer per user, or an atomic conditional increment in the store. The fact that my test passes is not evidence the design is safe, and I'd be uncomfortable if a test like that were the only thing standing between us and a double-delivery."

---

**Trap 2 — "Prototype pollution — you've got a user-supplied path resolver."**

*Obvious answer:* "I sanitise it." (You don't.)
*Why it's wrong:* Overclaiming a security control you didn't implement is the worst possible answer to a security question.

**Better:** "I checked it and it isn't exploitable, but not because I defended against it. `resolve()` in `audience-rules.js:20` is a `reduce` that only ever *reads* — `acc[key]` — so a condition field of `__proto__.x` walks onto the prototype and reads, it never assigns. There's no write anywhere on that path, which is what pollution needs. That's the correct reason it's safe, and it's fragile: the day someone adds a `set` operator to the condition language it becomes exploitable immediately. So the defense I'd actually want is a field allowlist on the condition resolver — conditions can only address `profile.*`, `event.*`, `session.*` with a segment check that rejects `__proto__`, `constructor` and `prototype` — rather than relying on the absence of a write."

---

**Trap 3 — "Path traversal on your static handler."**

*Obvious answer:* "Blocked, I check with `startsWith`."
*Why it's wrong:* It *is* blocked, but `startsWith` is a string test, not a path-boundary test, and he may well know the difference. Claiming it as a correct control when it's a correct *outcome* from a sloppy check is a missed opportunity.

**Better:** "Blocked — I tested it including encoded `%2e%2e`, and the reason is that `decodeURIComponent` runs before `path.join`, and `join` normalises the `..` away, so the `startsWith(root)` check at `server.js:54` catches anything that escapes. But `startsWith` is a *prefix string* comparison, not a path-boundary comparison — if there were ever a sibling directory whose name began with the root's name it would pass, and it only works here because `path.join` always emits `root + separator + rest`. The correct check is `path.relative(root, filePath)` and reject if it starts with `..` or is absolute. It's right by construction rather than by argument, which is what you want in a security check."

---

**Trap 4 — "Send an oversized body. What status do I get?"**

*Obvious answer:* "413."
*Why it's wrong:* Probably not, and he can test it in one curl.

**Better:** "In principle 413 — `MAX_BODY_BYTES` is 256KB and the reader rejects past it (`api.js:23-29`). In practice the code calls `req.destroy()` *before* the rejection propagates to the handler that writes the response, so depending on timing the client can see a connection reset rather than a status code. The response write is even guarded by `if (!res.headersSent)`, which tells you I knew the path was racy. That's a bad failure mode because a reset is indistinguishable from a network problem at the client, so the SDK can't tell 'your payload is too big' from 'the network blipped' and will retry forever. Correct order is: write the 413, *then* destroy."

---

**Trap 5 — "Your SDK dedups by deliveryId. Show me."**

*Obvious answer:* "Yes — same deliveryId, one popup."
*Why it's wrong:* There are three dedup layers and the second one has a business consequence you should name before he finds it.

**Better:** "Three layers, and the middle one is a design decision I'd challenge. Layer one is by `deliveryId` — the same delivery re-sent renders once, which is the at-least-once transport case and it's correct. Layer three is a DOM guard: if a popup element already exists, skip. Layer two is by `campaignId`, and it means that once `cmp-20-off` has rendered in this page load, that campaign can *never* render again in that page load even if the server legitimately decides to send it twice. If Marketing wants a campaign to fire on entry and again at cart abandonment in the same pageview, my SDK silently drops the second one, the server records `campaign_delivered`, and the delivery rate lies. That's the client overriding a server decision, which is the wrong place for that policy. It should be a per-campaign flag from the server, not a hardcoded client rule."

---

**Trap 6 — "Your contract test asserts `toBeVisible` then `toHaveCount(1)`. So a duplicate popup fails the count assertion?"**

*Obvious answer:* "Yes."
*Why it's wrong:* It fails, but not there, and if he knows Playwright he's asking precisely because the order is backwards.

**Better:** "It fails, but the count assertion is never the thing that reports it. Playwright locators are strict — `expect(popup).toBeVisible()` on a locator matching two elements throws a strict-mode violation first, so the failure message is 'resolved to 2 elements' rather than 'expected 1, got 2'. It still catches the bug, it just reports it badly, and a bad failure message costs real triage time at 3am. The order should be `toHaveCount(1)` first, then visibility, then content. Same mistake is in my Part 3 rewrite in the written answer — it's the kind of thing that looks like a style nit and is actually about whether the test tells you what broke."

---

**Trap 7 — "`popup_displayed` is a feedback event, so it doesn't re-enter the engine. Nice."**

*Obvious answer:* Accept the compliment.
*Why it's wrong:* He's baiting you toward the forgery gap. Take the compliment and hand him the gap.

**Better:** "The loop guard is right — without it, showing a popup would trigger another popup, and that's the first thing I'd have broken. But the same code path is where the weakness is: `ingest()` matches on the event *name* and returns early, with no validation that the `deliveryId` in the properties was ever issued or belongs to that session. So the guard is correct and the trust boundary isn't. Feedback is the one event class where the client is asserting something about the server's own state, and it's the one class with no verification."

---

## 5. Questions the candidate should ask him

Ask four or five, not all eight. Pick from his background: scaling teams, 1B events, microservices on EKS, hiring a QA Manager. Each line after the question is what a good answer reveals — listen for it.

1. **"At a billion events a day, what's the partition key on the event stream today — and has it ever had to change?"**
   *A confident answer means per-user ordering is guaranteed and the frequency-cap class of bug is already solved structurally. Hesitation means it isn't, and that's the first thing you'd be testing.*

2. **"When delivery rate drops, who gets paged — QA, or the service owner?"**
   *Tells you whether QA owns production signal or stops at the release gate. If QA isn't on the page rotation, 'QA Manager' here means pre-prod only, and the job is smaller than the title.*

3. **"What fraction of campaign config changes reach production without a deploy, and what validates them on the way in?"**
   *Directly the bug you demonstrated. If the answer is 'most of them' and 'not much', you've just found your first quarter's work and you can say so.*

4. **"Mongo and Redshift — which one does the real-time decision read from, and what's the freshness budget on a profile at decision time?"**
   *Reveals the actual hard constraint of the product. If there's a stated budget, they're mature and testable. If nobody knows, then 'was the popup correct' is currently unanswerable, which is a QA problem, not an architecture problem.*

5. **"What does the regression suite cost per commit in wall-clock right now, and what's the flake rate?"**
   *Tells you whether you're being hired to build or to rescue. Two very different first ninety days, and you want to know which before you accept.*

6. **"Two QA to nine engineers — is the mandate to grow the team, or to change the ratio by pushing testing left?"**
   *Reveals whether this is a headcount role or a systems role. Also tells you how much authority the position actually carries over developer workflow.*

7. **"What's the last incident that testing should have caught and didn't?"**
   *The single most revealing question in the list. The specific answer names the exact gap you're being hired to close, and how he talks about it — blame, or system — tells you how the team handles failure.*

8. **"On EKS, how do you run browser-level tests against production without polluting customer analytics?"**
   *Reveals whether synthetic traffic is tagged end to end. Worth asking because your demo has the same gap and you can say so: the dashboard's own probes create `synthetic-*` profiles that land in the real profile count, and the 'Run against this app' button moves the delivery-rate metric while it runs. If they've solved it, learn how. If they haven't, you have a concrete first deliverable.*

---

## 6. One-page cheat sheet

Read this out loud before you walk in.

### Numbers

| | |
|---|---|
| Tests | **27** — 17 API (`campaign-engine.spec.ts`), 7 mock-only (`demo-instrumentation.spec.ts`), 3 portable contract (`popup-delivery.spec.ts`). *Your written answer says 25 — correct it before he does.* |
| `waitForTimeout` remaining | **2** — `popup-delivery.spec.ts:69` (500ms), `demo-instrumentation.spec.ts:38` (600ms) |
| Reason codes | **6** — `ELIGIBLE`, `AUDIENCE_MISMATCH`, `CONDITION_FAILED`, `FREQUENCY_CAP`, `TRIGGER_MISMATCH`, `INVALID_CONDITION` |
| Seeded campaigns | 3 — `cmp-20-off` (active, `perSession:1`), `cmp-free-shipping` (active, `perSession:1`, cart ≥ $100), `cmp-vip-only` (**paused**, `perUser:1`) |
| Trace bus | 500 entries (`bus.js:28`) ≈ **50 events** of history; evicts action-sender and realtime first under a 600-event burst |
| Analytics store | 2000 rows, FIFO `shift()`; `summary()` is a full scan per request |
| Body limit | 256KB (`api.js:14`) |
| Throughput measured | **~330 events/sec**, single connection, single process (~3ms CPU/event) |
| Target scale | 1B/day = **11,574/sec** average; assume 3× peak ≈ **35k/sec** |
| Concurrency probe | 200 concurrent → 1 delivered, 199 `FREQUENCY_CAP`. Correct in one process, wrong in three. |
| Delivery-rate metric | `campaign_delivered / byType.event` → **caps at 33%** on a perfect journey; reads 39% live only because duplicate-test rows inflate it |
| Test timeouts | `DELIVERY_TIMEOUT` 10s, `NO_DELIVERY_TIMEOUT` 5s, contract-run kill at 120s, `--workers=1` |
| Leak | Sessions and profiles never expire — 43 sessions / 30 profiles after ~1h of clicking |

### One-liners

- **On the reason codes (your best work, say it early):** "Every non-delivery carries a machine-readable reason. That turns 'delivery dropped to 67%' from a mystery into a group-by."
- **On scale:** "Partition by userId. That one choice makes the frequency cap single-writer by construction instead of by accident."
- **On the campaign bug:** "One malformed campaign definition 500s every event of that trigger, platform-wide. The bug is a missing schema check; the *problem* is the blast radius."
- **On in-memory state:** "Restart reverts campaign config to seed. An operator pauses a campaign during an incident, a pod recycles, it comes back live — and only on the pods that recycled."
- **On idempotency:** "The deliveryId isn't deterministic. Client dedup works here by luck, not by design."
- **On the delivery rate:** "The numbers a business reads are a contract and need tests like one. That one had none."
- **On observability:** "The trace bus is a demo instrument. At 3am you read the reason-code distribution."
- **On testing at 90 seconds:** "I cut by blast radius, not by runtime. 17 API + 3 contract + 1 idempotency."
- **On mutation:** "Invert `withinFrequencyCap`, flip `match:'any'` to `'all'`, change `gte` to `gt`. Each should kill exactly one named test."
- **On AI:** "AI moves the risk from implementation defects, which tests catch, to specification defects, which they don't."
- **On the leftover note:** "It's a proofreading failure and it's mine. It's also exactly the class of defect only a human reading the artifact as its audience can catch."
- **The closing frame:** "I built it, I attacked it, here's the list. That's the job I'm applying for."

### Written-answer contradictions to correct *before he finds them*

1. **"25-test suite"** in the AI Usage Summary → it's **27**. Trivial, but a counting error in a QA submission is the wrong kind of trivial.
2. **"No `waitForTimeout` left anywhere"** (Part 2 readiness checklist) → your suite has **two**. Reconciling line is in Q16/A2: both are absence-assertions, both have a positive signal available, the fix is `expect.poll` on the 'Ignored duplicate' log line.
3. **Part 1 risk #2 — "shared mutable profile state can double-deliver past a cap"** → not true in this demo; `ingest()` is synchronous so it's atomic. Reconciling line: real in three pods, not real in one, and the test that passes is not evidence the design is safe.
4. **Part 1 gate — "campaign-engine.spec.ts, mock-only E2E, runs in ~1s"** → it's API-level, not E2E, and 17 tests plus worker startup is nearer 3–6s. Say "API-level, a few seconds."
5. **The trailing callout** telling you to review before submitting → address it directly and early (Q22).
6. **Part 3 rewrite ordering** — `toBeVisible` before `toHaveCount(1)` means a duplicate reports as a strict-mode violation, not as a count failure. Same ordering exists in the real contract spec. Name it as a known nit with a reason.

### The three things to volunteer unprompted

Pick your moment for each, but get all three out before he finds them:

1. **The reset bug** — before he touches the button (section 1.4).
2. **The campaign-validation bug** — offer it as a demo beat: "let me show you the worst bug I found in my own system", with the `PATCH status=paused` recovery rehearsed.
3. **The leftover AI note** — early, briefly, without flinching.

---

*Grounded against: `server.js`, `src/backend/{api,ingestion,profiles,realtime,sessions,inspector,contract-runner}.js`, `src/engine/{campaign-manager,audience-rules,decision-engine,action-sender}.js`, `src/db/index.js`, `src/bus.js`, `public/{index.html,dashboard.js,solitics-sdk.js,qa-assignment.html}`, `tests/*.spec.ts`, `playwright.config.ts`, and read-only probes of the live instance on :3000.*
