# Silknet Chrome Extension (v0.5)

Silknet is a Manifest V3 Chrome extension designed for cross-model AI debate orchestration across consumer web interfaces (OpenAI ChatGPT, Anthropic Claude, and Google Gemini).

Silknet coordinates multi-turn debates between AI models running in separate browser tabs, systematically surfacing genuine disagreements, critiques, and syntheses into a structured **Disagreement Ledger**.

---

## ⚠️ Terms of Service & Automated-Access Risk Disclosure

> **IMPORTANT NOTICE:**  
> Silknet interacts with the web interfaces of ChatGPT (`chatgpt.com`), Claude (`claude.ai`), and Gemini (`gemini.google.com`) through browser DOM automation and script injection.
> 
> * **Provider Terms of Service:** Web AI providers maintain Terms of Service that restrict or prohibit unauthorized automated access, scraping, or bot-driven interaction with their consumer web frontends.
> * **No "Safe Workaround":** Silknet does not claim or provide any "safe workaround" or immunity against provider rate limits, account restrictions, CAPTCHAs, or suspensions resulting from automated interactions. Use of this extension is entirely at your own discretion and risk.
> * **Distribution Model:** Silknet is distributed **strictly via GitHub source / sideloading**. It will **not** be published to the Google Chrome Web Store.

---

## Architecture Overview

Silknet is engineered to provide reliable, secure, and observable multi-model orchestration within modern Manifest V3 constraints:

```
┌─────────────────────────────────────────────────────────────┐
│                       Side Panel UI                         │
│  - Tab Binding & Health Diagnostics (.status-dot)           │
│  - Anonymized Prompt Pipeline (Model A / B / C)             │
│  - Live Disagreement Ledger Table (CLAIM-XX)                │
│  - User Interjection Control & Markdown/JSON Export         │
└──────────────────────────────┬──────────────────────────────┘
                               │ chrome.runtime messages
┌──────────────────────────────▼──────────────────────────────┐
│                  MV3 Background Service Worker              │
│  - Tab binding registry & TOCTOU-safe document tracking     │
│  - Multi-round orchestrator with graceful provider dropout  │
│  - Chrome alarms watchdog (~2-3m timeout per turn)          │
│  - IndexedDB Event Log (100 debate / 30 day retention)      │
└──────────────────────────────┬──────────────────────────────┘
                               │ chrome.scripting.executeScript
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
      ┌───────────┐      ┌───────────┐      ┌───────────┐
      │  ChatGPT  │      │  Claude   │      │  Gemini   │
      │  Adapter  │      │  Adapter  │      │  Adapter  │
      └───────────┘      └───────────┘      └───────────┘
```

### 1. Two-Phase Script Injection
* **Phase 1 (Lightweight Probes):** Tiny content scripts (<1 KB) declared in `manifest.json` inject on page load. They perform passive presence checks (`probe()`) and report `isClean` state (verifying if a chat is fresh or contains prior history) without loading heavy automation machinery.
* **Phase 2 (Dynamic Adapters):** When a debate run starts, the background service worker dynamically injects the full adapter bundle via `chrome.scripting.executeScript`.

### 2. Semi-Automated (SEMI) Primary Mode & Tamper Detection
* Silknet defaults to **SEMI Mode**: the extension injects the debate prompt into the provider's input composer, and the human user reviews and clicks **Send**.
* **Tamper Detection Guard:** A capture-phase event listener locks the send button. If the user edits or modifies the injected prompt before sending, the click is intercepted, prevented, and flagged to the sidepanel with a `TAMPER_BLOCKED` warning to protect debate integrity.
* **AUTO Mode Warning:** AUTO mode is present in codebase capabilities for offline testing, but remains disabled by default. Synthetic event dispatches carry `isTrusted === false`, making them trivial for provider anti-bot systems to detect.

### 3. Anti-Sycophancy & Disagreement Ledger
* **Anonymization:** Prompts are stripped of provider names and anonymized as `Model A`, `Model B`, and `Model C` to prevent cross-model bias or deference.
* **Anti-Sycophancy Instructions:** Critique prompts enforce finding objections, edge-case failures, and missing evidence, with explicit instructions that total agreement constitutes failure.
* **Disagreement Ledger:** The system parses output markers (`AGREE:`, `DISAGREE:`, `UNRESOLVED:`) into structured `LedgerClaim` objects (`CLAIM-01`, `CLAIM-02`, etc.) and renders an interactive dispute table in the side panel.

### 4. Resilience & Diagnostics
* **Per-Provider Watchdogs:** Built on `chrome.alarms` rather than volatile in-memory timers, surviving service worker suspend/wake cycles.
* **Graceful Dropout:** If one provider fails, times out, or hits a rate limit, the debate logs a `PROVIDER_FAILED` event and continues seamlessly with the remaining active models.
* **Session Recovery:** Sidepanel state is mirrored to `chrome.storage.session`. Reopening the sidepanel displays a Recovery Banner allowing immediate reattachment to in-flight runs.

---

## Gemini Light-DOM Architectural Note

During early architectural planning, Google Gemini was deferred due to the hypothesis that its web interface made heavy use of nested Shadow DOM boundaries requiring recursive shadow-root piercing.

During implementation and DOM inspection of `gemini.google.com`:
* **Finding:** While Gemini utilizes Google Web Components (`<rich-textarea>`, `<model-response>`), the interactive elements (the contenteditable composer and message response text blocks) are situated directly in the standard **Light DOM** or accessible through standard descendant queries.
* **Outcome:** Gemini was implemented cleanly using standard query selectors and `document.execCommand('insertText')`, conforming to the exact same `ProviderAdapter` interface and offline test coverage (20 clean SEMI cycles) as ChatGPT and Claude.

---

## Installation & Sideloading Guide

Silknet must be compiled from source and loaded unpacked into Google Chrome:

### 1. Build the Extension
Ensure you have [Node.js](https://nodejs.org/) (v20+) installed.

```powershell
# Navigate to extension directory
cd silknet-chrome

# Install dependencies
npm install

# Compile TypeScript and bundle assets to dist/
npm run build

# Verify test suite (45 offline conformance and security tests)
npm test
```

### 2. Load into Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** on in the upper-right corner.
3. Click the **Load unpacked** button in the top-left toolbar.
4. Select the `dist/` directory located inside `silknet-chrome`.
5. The **Silknet** extension icon will now appear in your browser extensions bar.

---

## Operating Silknet

1. Open separate browser tabs for your chosen providers:
   * `https://chatgpt.com`
   * `https://claude.ai`
   * `https://gemini.google.com`
2. Start a **New Chat** on each provider tab.
3. Click the Silknet icon in your browser toolbar to open the **Side Panel**.
4. Check the **Model Status Chips**:
   * Each provider shows a green status dot when ready.
   * A **Fresh Chat** badge verifies that the tab has no prior history (Round 0 peer blindness).
5. Enter your topic or question into the **Debate Objective** input.
6. Click **Start Multi-Model Debate**:
   * Silknet stages Round 1 prompts across your open tabs.
   * Switch to each tab and click **Send** (SEMI mode).
   * As models complete their replies, Silknet collects outputs, anonymizes them, stages critiques (Round 2), and extracts claims into the **Disagreement Ledger**.
7. Use the **Interject** box to inject user feedback or guidance into subsequent rounds.
8. Click **Export Ledger (JSON)** or **Copy Transcript (Markdown)** to save your results.

---

## Selector Maintenance & Updates

Web interfaces evolve frequently. Silknet decouples UI selectors from the core automation logic into clean JSON configuration files:

* ChatGPT: `src/selectors/chatgpt.json`
* Claude: `src/selectors/claude.json`
* Gemini: `src/selectors/gemini.json`

### Fixing Broken Selectors
If a provider changes their class names or DOM structure:
1. Open DevTools (`F12`) on the provider's page to inspect the new elements.
2. Update the fallback selector list in the corresponding `src/selectors/<provider>.json` file. Each selector supports an array of fallbacks evaluated in order:
   ```json
   "composer": [
     { "by": "css", "value": "#prompt-textarea" },
     { "by": "css", "value": "div[contenteditable='true']" }
   ]
   ```
3. Run `npm test` to verify your changes against offline mocks.
4. Rebuild with `npm run build` and click the reload icon on `chrome://extensions/`.

---

## Development & Test Commands

* `npm run build` — Bundles background worker, content scripts, and side panel to `dist/`.
* `npm run typecheck` — Runs `tsc --noEmit` to verify type safety.
* `npm test` — Executes the full test suite (Node test runner with JSDOM mocks).

---

## License

This project is licensed under the [MIT License](LICENSE).
