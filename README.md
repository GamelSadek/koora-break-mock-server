# Mock StatsPerform Server

A mock of the **StatsPerform** live-football feed for Koora Break's real-time
pipeline. It behaves like the real provider: 10–20 simultaneous matches, each
streaming realistically paced events (mostly offside/yellow chatter, the odd
goal) over a **raw WebSocket**, with tunable real-world messiness — duplicates,
reordering, corruption, and derby-moment bursts — layered onto the **delivery
path only**.

It is deliberately *only* a provider. It does **no** consumer-side work (no
dedup, no reorder-buffering, no state projection). That belongs to the separate
backend this feed exists to be built against.

---

## Quick start

```bash
npm install
npm run start:dev        # starts on :3001 (chaos OFF by default — a clean feed)
```

In another terminal, watch a match:

```bash
npm run demo -- match_001        # print frames for one match, flag seq gaps
# or the full firehose:
npm run demo
```

Or connect any raw WebSocket client:

```bash
npx wscat -c "ws://localhost:3001/?matchId=match_001"    # one match
npx wscat -c "ws://localhost:3001/?matchId=all"          # firehose (default)
```

To see the pipeline's messiness (and prove a consumer's defences), turn chaos on
— either at boot via env, or live via the control endpoint:

```bash
# live, no restart — crank malformed + reorder + duplicates
curl -X POST http://localhost:3001/control/chaos \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"malformedRate":0.1,"reorderRate":0.15,"dupRate":0.2}'
```

---

## What it produces

### Event schema

```jsonc
{
  "eventId": "a3f9d21c-…",   // UUID v4 — IDENTITY (a duplicate reuses it) → dedup key
  "matchId": "match_001",
  "seq": 47,                  // per-match monotonic, from 1 → ORDER / catch-up key
  "type": "GOAL",             // see 11 types below
  "team": "home",             // omitted for match-status events
  "minute": 34,
  "player": "Mohammed Al-Dawsari",   // omitted for match-status events
  "timestamp": "2025-07-01T20:34:00Z",

  // reversal-only (GOAL_CANCELLED / RED_CARD_RESCINDED):
  "refEventId": "…",          // the real prior event being reversed
  "refSeq": 31,
  "reason": "OFFSIDE"         // GOAL_CANCELLED only
}
```

`eventId` and `seq` are **separate on purpose**: `eventId` is identity, `seq` is
position. Chaos on the wire can reorder, duplicate, or corrupt frames, but `seq`
is assigned once at commit time and is **never** altered — so a consumer can
always reconstruct true order and detect gaps.

### The 11 event types

| Group | Types |
|---|---|
| Lifecycle (once each, in order) | `KICK_OFF` (0'), `HALF_TIME` (45'), `SECOND_HALF_KICK_OFF` (46'), `FULL_TIME` (90') |
| In-play | `GOAL`, `YELLOW_CARD`, `RED_CARD`, `SUBSTITUTION`, `OFFSIDE` |
| Reversals (rare) | `GOAL_CANCELLED`, `RED_CARD_RESCINDED` |

Pacing is Poisson-distributed per match around realistic averages (goals ~2.7,
offsides ~5, yellows ~3.5, reds ~0.25, subs ~10 clustered in the second half),
so no two matches are alike — some finish 0–0, some are goal-fests. Reversals
always reference a **real** earlier event from that match.

---

## Architecture

```
MatchSimulator ──canonical MatchEvent──▶ ChaosEngine ──frame string(s)──▶ EventsGateway ──▶ ws clients
  clean generation,                       delivery-path                 raw fan-out,
  assigns seq,                            distortions only              per-match subscriptions
  canonical log                                 │
       │                                        │
       └──────────── read directly ────────────┴──▶ CatchupController (REST, always clean)
```

- **`MatchSimulator`** — runs each match's sim clock, generates the clean
  canonical events, assigns `seq`, and keeps the in-memory **canonical log** (the
  source of truth). Knows nothing about chaos.
- **`ChaosEngine`** — subscribes to the canonical stream and decides *how* each
  event reaches the socket: as-is, duplicated, held-back (reordered), or
  delivered only in corrupted form. It never writes to the canonical log.
- **`EventsGateway`** — raw `ws` fan-out. Sends frames as plain strings straight
  to `client.send()` (which is what allows genuinely invalid-JSON frames), and
  routes by per-client subscription.
- **`CatchupController` / `ControlController`** — REST catch-up + observability +
  runtime control. REST responses are read straight from the canonical log, so
  they are **always clean** — this is the consumer's source of truth for healing
  a detected gap.

### Key design decisions

1. **Raw `ws` via NestJS `WsAdapter`, not socket.io.** The task needs frames that
   are sometimes *not valid JSON at all*; only a raw socket with direct
   `client.send(string)` can produce those. It also means any WebSocket client
   (wscat, a browser `WebSocket`) can connect with no client library.
2. **`seq` is assigned at *commit* time, in true order — never precomputed.**
   Bursts inject real events mid-match; assigning `seq` when an event enters the
   log keeps it trivially monotonic and lets a later `GOAL_CANCELLED` reference
   the real `eventId`/`seq` of the goal it reverses.
3. **The canonical log is the single source of truth; chaos is delivery-only.**
   Malformed frames, duplicates, and reordering exist *on the wire*. The log
   stays clean, complete, and gap-free — which is exactly what makes the REST
   catch-up endpoint a reliable healing mechanism. A malformed frame is treated
   as a genuinely *lost* event: the clean version never reaches the socket, so
   the consumer must heal that `seq` gap from REST (realistic — a corrupt frame
   *is* a lost event).
4. **Runtime-mutable chaos config**, separate from static boot config, so every
   knob can be toggled live via `POST /control/chaos` for a demo.

### Correctness guarantees (the subtle bits)

- **Reversals are scheduled strictly *after* the event they reference.** A
  `GOAL_CANCELLED` can only be emitted once its target `GOAL` has a real
  `eventId` — enforced in the scheduler.
- **Lifecycle events are never malformed or reordered.** If a `FULL_TIME` were
  only ever delivered garbled, a consumer's match projection would hang "live"
  forever. Lifecycle frames are always delivered exactly once, cleanly.
- **Reorder only reorders — it never drops.** Any frame held back by the
  out-of-order timer is force-flushed (in `seq` order) *before* that match's
  `FULL_TIME` frame, so a reordered event never arrives after the terminal event
  and is never lost when a match ends/restarts.
- **`seq` assignment is atomic across both commit paths.** Tick-driven and
  burst-driven commits draw from one per-match counter through a single
  synchronous method, so the canonical log can never contain a duplicate or
  out-of-order `seq` (only the wire can, via chaos).

---

## WebSocket subscription protocol

Connect to `ws://localhost:<PORT>/`. Initial subscription comes from the query
param; after connecting, send JSON messages to change it. The server replies to
every subscription change with `{"type":"SUBSCRIPTION_ACK","subscribed":"…"}`.

| Query param | Meaning |
|---|---|
| `?matchId=all` or omitted | **Firehose** (default) — every match |
| `?matchId=match_003` | Only that match |

| Message | Effect |
|---|---|
| `{"action":"subscribe","matchId":"match_003"}` | **Add** `match_003` (you can subscribe to several specific matches) |
| `{"action":"subscribe","matchId":"all"}` | Switch to the firehose (overrides specific subscriptions) |
| `{"action":"unsubscribe","matchId":"match_003"}` | Remove `match_003` |
| `{"action":"unsubscribe","matchId":"all"}` | Turn the firehose off → receive nothing |

Unknown actions or non-JSON inbound frames are ignored gracefully.

---

## REST API

| Method & path | Purpose |
|---|---|
| `GET /health` | `{status, matches, uptimeSeconds}` |
| `GET /matches` | Active matches with current minute + `seqHighWater` + score. Add `?includeFinished=true` to include ended matches. |
| `GET /matches/:matchId/events?since=<seq>` | **Catch-up.** All clean canonical events with `seq > since` (default 0), sorted by `seq`. The consumer's gap-healing / late-join source of truth. |
| `POST /control/burst/:matchId` | Trigger a derby burst now. Optional body `{"size":30}`. |
| `GET /control/chaos` | Current chaos config. |
| `POST /control/chaos` | Patch any subset of `{enabled,dupRate,reorderRate,reorderMaxDelayMs,malformedRate,burstEnabled}` at runtime. |

Examples:

```bash
curl http://localhost:3001/matches
curl "http://localhost:3001/matches/match_001/events?since=40"
curl -X POST http://localhost:3001/control/burst/match_001 -H 'content-type: application/json' -d '{"size":30}'
```

---

## Configuration

All configuration is via environment variables (a `.env` file is optional — every
var has a default). See [`.env.example`](./.env.example) for the fully-commented
list. The most useful:

| Var | Default | What it does |
|---|---|---|
| `PORT` | `3001` | HTTP + WS port |
| `MATCH_COUNT` | `15` | Simultaneous matches |
| `SIM_MINUTE_MS` | `1000` | Real ms per sim-minute (`1000` → ~90s/match; lower for a fast demo) |
| `RESTART_ON_FULLTIME` | `true` | Replace a finished match with a fresh one (new matchId) so the feed runs forever |
| `CHAOS_ENABLED` | `false` | Master switch — off means a perfectly clean feed |
| `DUP_RATE` | `0.02` | Duplicate rate (crank to 0.15–0.30 to demo dedup) |
| `REORDER_RATE` | `0.02` | Out-of-order rate (crank to ~0.15) |
| `REORDER_MAX_DELAY_MS` | `800` | Max hold-back for a reordered frame |
| `MALFORMED_RATE` | `0.005` | Corruption rate (crank to 0.05–0.10 to demo validation + gap recovery) |
| `BURST_ENABLED` / `BURST_RANDOM_PROBABILITY` | `true` / `0.02` | Random derby bursts |
| `BURST_SIZE_MIN` / `BURST_SIZE_MAX` / `BURST_WINDOW_MS` | `20` / `40` / `1000` | Burst shape |
| `GOAL_CANCEL_PROBABILITY` / `RED_RESCIND_PROBABILITY` | `0.06` / `0.10` | Reversal likelihoods |

When chaos fires it is logged so you can correlate against what the consumer
sees, e.g. `[CHAOS] malformed seq=52 (match_001)`,
`[CHAOS] reordered seq=6 +285ms (match_003)`.

---

## Trade-offs I accepted

- **In-memory only, no persistence.** The canonical log lives in memory. With
  `RESTART_ON_FULLTIME=true` the set of retained finished
  matches grows unbounded over a long run — fine for a demo; a real provider
  would add a retention window / eviction. I kept finished matches queryable so
  REST catch-up keeps working after a match ends.
- **A restarted match gets a *new* matchId** rather than resetting `match_003`'s
  `seq` to 1. This keeps `seq` a clean 1..N per match (a reset counter is exactly
  the kind of thing that breaks a naive consumer). The cost: a client watching a
  finished match must resubscribe to the replacement.
- **Chaos rates are independent per-event coin flips**, not a modelled failure
  process — simple and tunable, but bursts of correlated failure (e.g. a flaky
  connection dropping 10 frames in a row) aren't modelled.
- **Single-process, single sim clock per match via `setInterval`.** Timing is
  best-effort, not hard-real-time; under heavy load minute boundaries can drift
  slightly. Acceptable for a simulator.
- **No auth / TLS / rate-limiting.** Out of scope for a local mock provider.