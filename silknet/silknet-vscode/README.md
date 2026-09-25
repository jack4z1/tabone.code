# Silknet VS Code Extension — Local Grounding Bridge (v0.1.0)

The VS Code half of **Silknet**: a local **Grounding Agent** that reads your
currently open workspace (read-only), produces a bounded context report via a
local Ollama model, and serves it to the Silknet Chrome debate extension over
an authenticated WebSocket bridge bound to `127.0.0.1` only.

The local model is **not** an equal debate peer — by deliberate, reviewed
design. It reads the codebase and produces a bounded report that becomes part
of Round 0's shared context. It is not asked to independently propose, critique,
or revise abstract architecture the way the browser AIs do.

---

## ⚠️ Threat Model

Stated plainly: what this extension defends against, and what it does not.

### In scope

- **A malicious or corrupted repository's contents.** Everything read from the
  workspace is untrusted DATA. It can influence the *content* of the grounding
  report and the next prompt — nothing else. It can never trigger a file write
  (no write capability exists in v1.0), never change a permission, and is never
  interpreted as a control instruction.
- **A manipulated or hallucinating model proposal.** Ollama output is untrusted
  data folded into report prose. It never selects files, never changes the
  context budget, never triggers actions. The deterministic parts of the report
  (path confinement, budgets, symbol extraction) run with zero model
  involvement.
- **A malicious local process attempting to connect to the bridge without a
  valid token.** The session token is checked AT the WebSocket upgrade
  handshake — an unauthenticated socket is never accepted, so it cannot be
  flooded before rejection. Comparison is constant-time. Tokens are 256-bit
  cryptographically random, rotated on every bridge start, never logged, never
  echoed in errors, never persisted in plaintext.

### Out of scope

- **A fully compromised operating system or user account.** This extension
  does not attempt to defend against an attacker who already has arbitrary code
  execution on your machine outside this extension's own process. Such an
  attacker does not need to attack the bridge.

### Explicit non-capabilities (v1.0)

- **No file write/edit capability whatsoever.** The v1.1 write pipeline is
  specified but deliberately not implemented; see
  `src/write-pipeline/README.md`.
- **No shell/command execution exposed to any model, anywhere.**
- **No telemetry, no cloud component.** Everything runs on `127.0.0.1`.

---

## ⚠️ Terms of Service / Risk Posture

Carried over from the Chrome extension's README, consistent with it:

- This extension and its bridge run **entirely locally** — no cloud component,
  no telemetry — so it carries none of the browser-automation ToS risk on its
  own.
- The **combined system** (this extension feeding context into the Chrome
  debate) inherits the Chrome side's existing posture: **GitHub-sideload
  distribution only**, SEMI mode as the primary supported mode on the Chrome
  side, and no attempt anywhere to bypass rate limits or anti-bot measures.
- **What data leaves the machine, and under what condition:** nothing leaves
  the machine except what you explicitly approve through the **cloud-egress
  gate** in the Chrome side panel. Before any local file content crosses into
  a browser AI tab, you see a specific manifest (which providers, how many
  files, approx. how many lines, and a checkbox list of exactly which files),
  plus a redaction warning for any credential-shaped strings found. You choose:
  no local context / report only (recommended default) / selected files. A
  redaction pass with warn-and-let-the-user-decide UX runs before anything
  crosses. This is a factual statement of the data flow, not a compliance
  claim: what you approve is sent to the browser AI providers you are already
  using, under their terms.

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  VS Code extension (this repo)                             │
│                                                            │
│  extension.ts ── status bar, commands, folder designation  │
│      │                                                     │
│      ├── bridge/broker-server.ts   WS server, 127.0.0.1    │
│      │      ├── auth.ts            upgrade-time token      │
│      │      ├── heartbeat.ts        22s ping/pong, 2× grace│
│      │      └── message-schema.ts   typed BridgeMessage     │
│      │                                                     │
│      ├── grounding/                                        │
│      │      ├── ollama-client.ts    localhost:11434 only   │
│      │      ├── file-read-pipeline.ts  path-safe reads     │
│      │      ├── report-builder.ts   bounded digest         │
│      │      └── redaction.ts        secret detection       │
│      │                                                     │
│      └── egress/egress-gate.ts      holds report until the │
│                                     human's decision       │
└──────────────────────────────┬─────────────────────────────┘
                               │ WebSocket (token-authed upgrade)
                               │ CONTEXT_REQUEST ↓  ↑ CONTEXT_REPORT
                               │ EGRESS_APPROVED ↓  ↑ EGRESS_MANIFEST
                               │ REDACTION_DECISION ↓ ↑ REDACTION_FOUND
┌──────────────────────────────▼─────────────────────────────┐
│  Silknet Chrome extension (sibling repo, unchanged core)   │
│  bridge-client.ts in the service worker + side panel UI    │
└────────────────────────────────────────────────────────────┘
```

### Security properties

| Property | Implementation |
| --- | --- |
| Loopback only | `WebSocketServer({ host: '127.0.0.1' })` — never `0.0.0.0` |
| Auth at the boundary | Token verified in the upgrade handshake; zero bytes accepted pre-auth |
| Token hygiene | 256-bit random, constant-time compare, rotated per start, never logged/echoed/persisted |
| Origin checks | Cheap extra layer only — never the boundary (native processes can spoof Origin) |
| Schema at every hop | `parseBridgeMessage` validates before any logic runs, both directions |
| Rate/size limits | 10 msg/s, 512 KB payload cap, 0 pre-auth messages, 1 concurrent debate |
| Heartbeat | 22 s both directions, 2× grace, missed beat == disconnect |
| Read confinement | `fs.realpathSync` resolution; verified inside the root's REAL path before any open |
| Filename sanitization | Control chars (U+0000–001F, U+007F, U+0080–009F) and path separators rejected |
| Budgets | 4–6 files, ~150 lines/file, ~2,000 lines, ~12,000 chars; overflow is a visible marker, never silent |
| Egress gate | Human decision required before ANY local content crosses; report-only is the default |
| Redaction | AWS keys, GitHub tokens, private keys, JWTs, DB URLs, env credentials, generic API keys |
| Protocol versioning | Major-version mismatch refuses the connection with a clear error in both UIs |

---

## Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v20+
- [Ollama](https://ollama.com/) installed and running (`ollama serve`), with a
  model pulled, e.g. `ollama pull llama3.2`
- The sibling `silknet-chrome` extension loaded into Chrome (see its README)

### 2. Build

```powershell
cd silknet-vscode
npm install
npm run build
npm test
```

### 3. Run inside VS Code

1. Open this project (or any workspace) in VS Code with the extension loaded
   (F5 launches an Extension Development Host).
2. Run **Silknet: Start Bridge** from the command palette. The status bar shows
   `Silknet: listening`.
3. A **session token** is displayed once — copy it (there's a Copy button).
4. In Chrome, open the Silknet side panel, paste the token into **Local
   Grounding**, and click **Connect**. The dot turns green in both UIs.
5. Optional checks: **Silknet: Check Ollama Availability**,
   **Silknet: Generate Grounding Report** (preview the bounded report locally,
   without any bridge involvement).

### 4. Use grounding in a debate

1. In the Chrome side panel, tick **"Include local grounding context in Round
   0"** (only enabled while the bridge is connected).
2. Start the debate. The extension requests context, you get the **egress
   manifest dialog**, you decide what crosses, and the approved report is
   injected into every participant's Round 0 prompt.
3. Without the bridge, everything works exactly as before — the Chrome
   extension is fully standalone.

### Multi-root workspaces

If more than one folder is open, Silknet will **ask** you to designate a single
primary folder for the run's scope. It never silently guesses. Re-designate any
time via **Silknet: Designate Primary Workspace Folder**.

---

## Commands

| Command | What it does |
| --- | --- |
| `Silknet: Start Bridge` | Starts the token-authenticated WebSocket broker on 127.0.0.1 |
| `Silknet: Stop Bridge` | Stops the broker and clears pending gate state |
| `Silknet: Check Ollama Availability` | Probes `http://localhost:11434` and lists models |
| `Silknet: Generate Grounding Report` | Builds the bounded report locally and opens it as markdown |
| `Silknet: Designate Primary Workspace Folder` | Explicitly scopes file reads in multi-root workspaces |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `silknet.bridgePort` | `8712` | Bridge port (always loopback-bound) |
| `silknet.ollamaUrl` | `http://localhost:11434` | Ollama base URL |
| `silknet.ollamaModel` | `llama3.2` | Model used for the report's narrative summary |

---

## Development

```
npm run build      # bundle dist/extension.js
npm run typecheck  # tsc --noEmit
npm test           # bridge + grounding + egress conformance suites
```

Test layout:

- `tests/bridge.test.mjs` — real broker over real loopback sockets: upgrade
  auth, handshake, version mismatch, pre-auth discipline, rate/size limits,
  debate slot, heartbeat, reconnect + token rotation
- `tests/schema-auth.test.mjs` — schema union, protocol versioning, token auth
- `tests/grounding.test.mjs` — sanitization, symlink-safe confinement, binary
  rejection, budget enforcement, report building
- `tests/egress.test.mjs` — redaction patterns + gate decision semantics

## License

[MIT](LICENSE)
