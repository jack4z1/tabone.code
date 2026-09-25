# Silknet Part B — Manual Smoke-Test Guide

The automated suites (53 VS Code + 54 Chrome tests) prove the machinery. Two
success criteria in the build brief are **deliberately human-in-the-loop** and
cannot be automated: the long-idle bridge soak (B0.1) and a real debate with a
human approving the egress gate (B0.5). This checklist walks both, in order.

Total time: ~45 minutes. If every checkbox passes, Part B's success criteria
are fully met.

---

## 0. Prerequisites

- [ ] Node v20+, Chrome 116+
- [ ] Ollama installed and running, with a model pulled:
      ```powershell
      ollama serve          # if not already running as a service
      ollama pull llama3.2
      ```
- [ ] Both extensions built:
      ```powershell
      cd silknet-vscode ; npm install ; npm run build
      cd ..\silknet-chrome ; npm install ; npm run build
      ```
- [ ] `silknet-chrome/dist/` loaded unpacked via `chrome://extensions` →
      **Load unpacked** → Developer mode on

---

## Part 1 — Bridge soak test (B0.1 success criterion)

> *"The Chrome extension and VS Code extension can connect, authenticate, hold
> the connection open for 10+ minutes with no traffic beyond heartbeats, and
> reconnect cleanly if either side restarts."*

### 1.1 Start the bridge

- [ ] Open any workspace folder in VS Code with the extension running (F5 from
      `silknet-vscode` launches an Extension Development Host)
- [ ] Command palette → **Silknet: Start Bridge**
- [ ] Status bar shows `$(broadcast) Silknet: listening`
- [ ] The **session token** notification appears — click **Copy Token**

### 1.2 Connect from Chrome

- [ ] Open `https://chatgpt.com`, `https://claude.ai`, `https://gemini.google.com`
      in separate tabs (any one is enough for this part)
- [ ] Click the Silknet icon → side panel opens
- [ ] **Local Grounding** card shows a grey dot + `disconnected`
- [ ] Paste the token (64 hex chars) → click **Connect**
- [ ] Dot goes amber `connecting` → green `connected`
- [ ] VS Code status bar flips to `$(check) Silknet: connected`

### 1.3 Negative check (do this once, before the soak)

- [ ] Click **Disconnect** in the panel
- [ ] In VS Code, run **Silknet: Stop Bridge**, then **Silknet: Start Bridge**
      again — confirm the new token notification **differs** from the old one
      (rotation on restart)
- [ ] Try connecting with the OLD token → panel shows `disconnected` with the
      "token rejected" detail and does NOT retry-loop
- [ ] Reconnect with the NEW token → green again

### 1.4 The 10+ minute soak

- [ ] Note the start time; leave both windows untouched. Do **not** interact
      with either UI. (Keep the machine awake — disable sleep for the test.)
- [ ] After 10–15 minutes: Chrome panel still shows green `connected`, VS Code
      still shows `connected`. (The 22s heartbeat traffic is invisible except
      in DevTools → Network → WS frames on the service worker inspector, if
      you want to watch it.)
- [ ] **Reconnect-after-restart check:** in VS Code run **Silknet: Stop
      Bridge** → Chrome dot drops to grey within a few seconds (no hang, no
      crash). Start the bridge again with a fresh token and reconnect.

### 1.5 Worker-eviction check (MV3-specific, worth doing once)

- [ ] With the bridge connected, open `chrome://extensions` → Silknet →
      **service worker** link → DevTools. In the console run:
      `setTimeout(() => 1, 31_000)` and wait ~35s to let the worker idle
- [ ] The panel dot may briefly flicker but should return to/maintain
      `connected` — the heartbeat traffic keeps the worker alive and the
      client reconnects automatically with backoff after any suspension
- [ ] Then confirm a full Chrome **restart** (quit Chrome, reopen) also
      self-heals: reopen the side panel, and after entering the fresh token
      once, the connection re-establishes

**Part 1 passes when:** connected ≥10 min idle, disconnect/restart on either
side recovers cleanly, stale tokens are rejected without retry-loops.

---

## Part 2 — First live grounded debate (B0.5 success criterion)

> *"A real debate run in the Chrome extension includes a local-grounding report
> from a real workspace, the user explicitly approves what crosses the egress
> gate before it's sent, and the browser AIs' Round 0 answers visibly reference
> the actual local project."*

### 2.1 Pick a real workspace

- [ ] In the VS Code window hosting the bridge, open a **small** real project
      (the Silknet repo itself works well) — single folder to keep the
      primary-folder flow out of the way for the first run

### 2.2 Preview the report locally (optional but recommended)

- [ ] **Silknet: Check Ollama Availability** → reports ready + your model
- [ ] **Silknet: Generate Grounding Report** → a markdown tab opens with the
      bounded report: 4–6 files, key symbols, truncation markers if any.
      Sanity-check it *says what you expect about your project* before any of
      it can leave the machine

### 2.3 Run the debate

- [ ] Chrome: fresh **New Chat** on each provider tab you'll use (≥2)
- [ ] Side panel: bridge green + tick **"Include local grounding context in
      Round 0"** (checkbox is disabled unless connected)
- [ ] Enter a topic that forces references to the codebase, e.g.:
      *"Review the authentication architecture of this project and debate
      whether it should be restructured."*
- [ ] **Start Multi-Round Debate**

### 2.4 The egress gate — the critical human decision point

- [ ] The **egress dialog** appears BEFORE any Round 0 text is staged:
      `"Local project context will be sent to: CHATGPT, CLAUDE, GEMINI. Files
      referenced: N. Approx. size: N lines."`
- [ ] The file list shows exactly the report's files, **all pre-ticked**
- [ ] Verify the negative path first: **Cancel** → the feed shows "Continuing
      without local grounding context", Round 0 prompts contain NO
      `LOCAL PROJECT CONTEXT` block (you can re-run; cancelling is safe)
- [ ] Start again and this time choose **Send generated report only**
- [ ] If the redaction box appeared (only when credential-shaped strings were
      detected): verify matches show category + location, never the raw secret

### 2.5 Verify grounding actually landed

- [ ] In SEMI mode, when the first prompt is staged in a provider tab, the
      composer contains `LOCAL PROJECT CONTEXT` with real paths from your
      workspace, followed by the standard opening instruction
- [ ] After Round 0 replies: at least two participants reference **actual**
      artifacts (file names, functions, structure) from your workspace — not
      generic advice
- [ ] The debate feed shows the grounding notice
      `✅ Local grounding context included (~N lines)`

### 2.6 Standalone regression

- [ ] **Disconnect** the bridge (or just untick the grounding checkbox) and run
      one more short debate → behaves exactly as before Part B: no grounding
      requests, no dialog, identical Round 0 prompt shape

**Part 2 passes when:** a real debate included your real workspace context,
you explicitly approved what crossed before it was sent, and Round 0 answers
visibly reference the actual local project.

---

## Quick triage

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Panel stuck on `connecting` | Bridge not started, or token stale | Restart bridge in VS Code, copy the fresh token |
| "token rejected" immediately | VS Code restarted since you copied | Tokens rotate per start — copy the new one |
| Checkbox greyed out | Bridge not in `connected` state | Connect first; the control enables automatically |
| No egress dialog | Report came back empty or gate timed out (3 min) | Check VS Code output channel: "Silknet" |
| Report has no model summary | Ollama not running / model missing | Report still ships (deterministic); run `Silknet: Check Ollama Availability` |
| Round 0 staged but no context block | Checkbox unticked at start time, or report denied in the dialog | Re-tick + approve `report-only` |

## Multi-root note

With 2+ folders open, the first grounding request triggers a
**Designate Primary Folder** quick-pick. Silknet never guesses the scope.
Change it anytime via **Silknet: Designate Primary Workspace Folder**.
