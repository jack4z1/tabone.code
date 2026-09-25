# Silknet Part B — Build & Security Audit Report

**Scope:** `silknet-vscode` (new) + the Chrome-side bridge addition to
`silknet-chrome` (additive), per the Part B build brief.
**Date:** 2026-09-25
**Auditor:** Buffy (automated build-time audit: code walkthrough, grep-based
invariant checks, and the automated conformance suites described below)

---

## 1. Verdict at a glance

| Area | Status |
| --- | --- |
| Phase B0.1 — bridge connect/auth/heartbeat | ✅ Built, 20 automated tests |
| Phase B0.2 — Ollama + read-only file pipeline | ✅ Built, 15 automated tests |
| Phase B0.5 — end-to-end grounding + egress gate | ✅ Built, both halves tested; live debate run is a manual step |
| Phase B1.0 — hardening | ✅ Multi-root designation, limits, schema-at-every-hop, threat model docs |
| File Write Pipeline (v1.1) | ✅ Not implemented (spec scaffold only, as required) |
| Chrome core debate logic untouched | ✅ 45/45 pre-existing tests still pass |
| Security checklist (12 items) | ✅ 12/12 pass — see §3 |
| Out-of-scope items | ✅ None implemented |

**Final gate results:**

```
silknet-vscode    tsc --noEmit: clean    tests: 53 pass / 0 fail
silknet-chrome    tsc --noEmit: clean    tests: 54 pass / 0 fail  (45 original + 9 new)
```

---

## 2. What was built

### 2.1 silknet-vscode (new extension)

```
src/
├── extension.ts                  activation, status bar, commands, SecretStorage pattern,
│                                 multi-root primary-folder designation (never guesses)
├── bridge/
│   ├── broker-server.ts          WS broker, host '127.0.0.1', upgrade-time auth,
│   │                             HELLO/AUTH state machine, version gate, limits, per-instance
│   │                             single-debate slot
│   ├── auth.ts                   256-bit token (node:crypto), constant-time compare,
│   │                             upgrade URL/Authorization parsing, Origin as cheap extra layer
│   ├── heartbeat.ts              bidirectional 22s PING/PONG, 2× grace ⇒ disconnect,
│   │                             first-beat-immediately (suppressed pre-handshake)
│   └── message-schema.ts         the brief's full BridgeMessage union + parse-layer validators
├── grounding/
│   ├── ollama-client.ts          localhost:11434 discovery, tags/generate, timeout-bounded
│   ├── file-read-pipeline.ts     realpathSync confinement, filename sanitization, binary sniff,
│   │                             per-file/total caps, depth limit, denylist, text allowlist
│   ├── report-builder.ts         bounded digest (4–6 files, ~150 lines/file, 2,000 lines,
│   │                             12,000 chars), visible truncation markers, symbol extraction,
│   │                             best-effort model narrative
│   └── redaction.ts              7 pattern categories + redact-and-continue application
├── egress/egress-gate.ts         holds the report until the human's decision; report-only /
│                                 selected-files semantics; redact ships a cleaned report
└── write-pipeline/README.md      v1.1 spec pointer ONLY (no code, per brief)
```

### 2.2 silknet-chrome (additive only)

```
src/background/
├── bridge-protocol.ts    Chrome mirror of the BridgeMessage schema (hand-synced,
│                         protocol-version lockstep asserted by a test)
├── bridge-client.ts      WS client: HELLO/AUTH, heartbeat, exponential backoff,
│                         AUTH_FAILED/protocol-mismatch hard stops
├── bridge-internal.ts    THIRD messaging namespace (panel ⇄ worker), validated
├── bridge-state.ts       session-scoped bridge/grounding state
├── bridge-grounding.ts   pure Round 0 prompt construction (formatGroundingBlock,
│                         buildOpeningPrompt) — testable without DOM
├── event-log.ts          +5 append-only event types (bridge connect/disconnect,
│                         context requested, egress decided, context injected)
└── service-worker.ts     bridge client instance + BRIDGE_UI op handler
                          (connect/disconnect/requestContext/egressDecision/getReport)

src/sidepanel/            Local Grounding card (state dot, token entry, grounding checkbox),
                          egress manifest dialog (checkboxes over report paths, all pre-ticked;
                          redaction warnings), Round 0 injection via buildOpeningPrompt
```

The existing debate/adapter/tamper/orchestration code paths are untouched; the
side panel's opening prompt is produced by `buildOpeningPrompt`, which returns
a byte-identical prompt when no grounding is used (asserted by test).

---

## 3. Security checklist walk (brief §SECURITY CHECKLIST)

| # | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Bridge bound to `127.0.0.1` only, never `0.0.0.0` | ✅ | `broker-server.ts` — `new WebSocketServer({ host: '127.0.0.1', … })`; repo-wide grep finds no `0.0.0.0` |
| 2 | Token checked AT the upgrade, not after acceptance | ✅ | `verifyClient` → `authenticateUpgrade` runs before any `connection` event; tests assert HTTP 401/no-open for missing and wrong tokens; no socket is ever accepted unauthenticated |
| 3 | Token: high-entropy, never logged/echoed, single-session, rotated | ✅ | 32 `randomBytes`, hex; `timingSafeEqual` (with empty-token hard reject); new token per `startBroker`; `AUTH_FAILED.reason` is a fixed generic string; grep for token-logging patterns: 0 matches; token surfaced once via UI, never persisted |
| 4 | HELLO/AUTH handshake with version checking, tested for mismatch | ✅ | Major-version gate on both ends; clear human-readable refusal surfaced to both UIs; mismatch tests on both sides assert `ERROR/protocol-version-mismatch` |
| 5 | Heartbeat both directions, 20–25s, grace before disconnect | ✅ | 22s negotiated via HELLO on both ends, 2× grace; broker drops + client reconnects on a missed beat; tests: PING/PONG exchange, quiet-window survival, reconnect + token rotation. *The 10-minute idle soak is a manual live test (§6)* |
| 6 | Full `BridgeMessage` schema validated at every hop, both directions | ✅ | `parseBridgeMessage` gates all inbound traffic on both ends (broker rejects with `schema-rejected`; client silently drops malformed frames); Chrome mirror kept in lockstep (version-equality test) |
| 7 | Limits: 10 msg/s, 1 debate, 512 KB, 0 pre-auth messages | ✅ | All four enforced in the broker and asserted by tests (`rate-limited`, `debate-slot-busy`, payload cap → in-band error or close 1009, `pre-auth-rejected` + close) |
| 8 | Reads confined to root via resolved-path checks; filename sanitization | ✅ | `checkPathInsideRoot` uses `realpathSync` on both root and target before every open (TOCTOU-guarded re-check at open time); control chars U+0000–001F/U+007F/U+0080–009F and separators rejected; symlink-escape test passes |
| 9 | Egress gate before ANY crossing, conservative default, redaction first | ✅ | Report is held in the gate; the Chrome dialog renders manifest + per-file checkboxes + redaction findings; nothing crosses until a decision; "report only" is the recommended/default action; deny/cancel ⇒ nothing crosses; decision timeout ⇒ debate proceeds without grounding (fail-closed) |
| 10 | No shell/command execution anywhere | ✅ | `src/` grep: no `child_process`, `exec`, `spawn` (only regex `.exec`); the model has no execution surface; v1.1 scaffold re-states the prohibition |
| 11 | No credential/telemetry leaves the machine except via the gate | ✅ | Outbound traffic is loopback-only: manifest/redaction/report; browser egress happens solely after an `EGRESS_APPROVED`; no telemetry code exists in either extension |
| 12 | Threat-model statement in the extension's own docs | ✅ | `silknet-vscode/README.md` §Threat Model (in-scope: malicious repo contents, hallucinating model, malicious local process; out-of-scope: compromised OS/account) + ToS/risk posture consistent with Part A's README |

**Additional invariants verified by walkthrough (beyond the checklist):**

- **Three messaging systems kept distinct** as the brief demands:
  `silknet/v0.1` (Chrome-internal), `silknet/bridge/v0.1` (panel ⇄ worker), and
  the WebSocket `BridgeMessage` union. No type reuse across boundaries.
- **Untrusted-data rule:** model output, page text, and file contents only ever
  influence prompt/report *content*. Every control-flow decision (file
  selection, budget, egress, connection) is made by typed code or explicit
  human action.
- **Debate slot is per-broker-instance** (found and fixed during the build:
  module-global state would have leaked claims across broker restarts).
- **Empty-token authentication is impossible** (hardened during the build).
- **MV3 lifetime:** the client-side heartbeat sends an immediate PING after
  AUTH_OK and every 22s thereafter, keeping active WebSocket traffic flowing
  during silent generation waits.

---

## 4. Spec deviations (both approved with the user before implementation)

| Deviation | Rationale |
| --- | --- |
| `CONTEXT_REQUEST.targetProviders?: string[]` | The brief requires `EGRESS_MANIFEST.targetProviders` but gives the VS Code side no way to learn the providers; the requester now echoes them. |
| `EGRESS_MANIFEST.paths?: string[]` | `'selected-files'` mode needs something to render checkboxes for; paths come from the report builder's already-selected files (a refinement of the report, not a free-browse picker — that is v1.1). All pre-ticked; deselect to withhold. |
| `selected-files` with empty selection is schema-invalid | An empty selection would silently smuggle an unspecified set across the gate; the schema rejects it and the UI guards it. |

Both new fields are optional, so a client/server pair without them
interoperates.

---

## 5. Test coverage summary

**silknet-vscode (53 tests)**
- Bridge (real broker, real loopback sockets): upgrade auth (missing/wrong/Bearer), pre-auth rejection + close, schema rejection, version mismatch refusal, HELLO→AUTH ordering, 10 msg/s rate limit, 512 KB payload rejection, single debate slot (claim, block, release-on-disconnect), PING/PONG, quiet-window survival, restart reconnect with token rotation
- Schema/auth: full union acceptance, malformed rejection (incl. `selected-files` without selection, out-of-range heartbeat), major-version compatibility, token entropy/shape/constant-time/URL+header auth
- Grounding (real temp workspaces): sanitization (control chars, separators, dot-trickery, traversal), root confinement incl. symlink escape, per-file/line truncation, binary rejection, byte-cap rejection, denylist/depth scan, 4–6-file report with visible truncation markers and budget compliance, symbol extraction, Ollama probe (dead port + parsed tags)
- Egress: all 7 redaction categories (incl. negative cases), no raw secret in locations, redact-preserves-assignment, gate deny/report-only/selected-files/empty-selection/no-pending semantics

**silknet-chrome (54 tests = 45 pre-existing + 9 new)**
- Pre-existing 45: adapter conformance (20 clean SEMI cycles, completion detection, TOCTOU, tamper block, recovery) — all still green, proving the core is untouched
- New: mirror-schema union acceptance/rejection (incl. v1.1 types being non-consumable in v1.0), protocol-version lockstep with the sibling, Round 0 prompt construction (byte-identical without grounding; grounding block injected with the data-not-instructions framing; truncation marker), **live interop**: the real Chrome handshake (token upgrade → HELLO → AUTH → AUTH_OK) against the real VS Code broker, and upgrade-time rejection of a stale token

---

## 6. What automated tests cannot prove (manual/live items)

1. **The B0.1 success criterion's full duration** — "hold the connection open
   for 10+ minutes with no traffic beyond heartbeats." The machinery is tested
   (22s beats, 2× grace, reconnect), but a 10-minute soak on real Chrome +
   real VS Code is a human step. A step-by-step walkthrough — including the
   negative checks (stale token, restart recovery) and the MV3
   worker-eviction check — is in **`SMOKE-TEST.md`, Part 1**.
2. **A real debate end-to-end** (B0.5 success criterion): real provider tabs,
   real Ollama model, human approving the egress gate, and verifying the
   Round 0 answers visibly reference the actual workspace. All components are
   individually tested; the composition on live providers requires a human
   run by design (SEMI mode). **`SMOKE-TEST.md`, Part 2** walks it, including
   a standalone-regression pass to prove the Chrome extension still works
   fully standalone without the bridge.
3. **Selector drift on live provider pages** — unchanged from Part A's
   existing posture.

## 7. Residual risks / recommendations

| Risk | Assessment | Recommendation |
| --- | --- | --- |
| Token in upgrade URL (`?token=`) | Brief-sanctioned alternative (Authorization header also supported). Assessment of the URL-specific exposure: the browser WebSocket API offers **no header control** — `new WebSocket(url)` cannot carry an `Authorization` header — so a browser client's only choices are a subprotocol field or the URL query. The Chrome client therefore sends the URL form; the header path exists for future non-browser clients. Exposure surface is limited by four facts: the socket is loopback-only (the URL never traverses a network), the token rotates on every bridge start, it is never persisted, and the broker does not log upgrade URLs. A local process reading Chrome's memory or a local proxy already implies OS-level compromise, which the threat model explicitly places out of scope. | Keep the URL path for browser clients; keep preferring the header path for non-browser clients. If a future Chrome version allows WebSocket headers, migrate the browser client to the header form. |
| Redaction regexes are heuristic | The brief's v1.0 starting set is inherently best-effort; novel secret formats can slip through — which is exactly why the default UX is warn-and-let-the-user-decide rather than auto-approve. | Expand the set over time, as the brief plans. |
| Heartbeat lower clamp (5s) in tests | The validator accepts 1s–120s negotiated intervals; the runtime clamps to 5s–120s. Production uses 22s. | None needed; documented. |
| Manifest round-trip dependency | If the side panel is closed at manifest time, the report simply does not cross (fail-closed); the debate proceeds without grounding. | None needed. |
| `silknet.ollamaModel` default (`llama3.2`) | A model that isn't pulled degrades gracefully to the deterministic summary (visible note in the report). | Document in user setup (done in README). |

## 8. Out-of-scope confirmations

- File Write Pipeline: **not implemented** — `src/write-pipeline/README.md` is
  a spec pointer only; `FILE_PROPOSAL`/`FILE_APPROVAL` exist solely as
  reserved types and are explicitly non-consumable by the v1.0 parsers
  (asserted by test).
- No hybrid task-routing, no auto-fix-diagnostics loop, no vector-indexed file
  selection, no swarm/compute pooling, no cloud component, no remote
  telemetry.
- Distribution posture unchanged: GitHub-sideload only; SEMI remains the
  primary Chrome-side mode; `isTrusted`/AUTO-experimental rationale untouched.

---

**Conclusion:** the Part B build conforms to the brief's phases, schemas,
limits, and security checklist, with the Chrome core demonstrably untouched
(45/45 original tests) and the two extensions proven to interoperate live at
the protocol level. The remaining verification items (§6) are the deliberate,
human-in-the-loop steps that cannot be automated by design.
