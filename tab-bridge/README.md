# 🌉 Tab Bridge — Browser AI to Local IDE

**Tab Bridge** connects your local IDE (VS Code, Cursor) and local AI (Ollama, Cline, Continue.dev) directly to your active browser AI tabs (**ChatGPT**, **Claude**, and **Gemini**).

It turns your browser tabs into a **zero-cost, pseudo-API**:
1. You (or your IDE's local AI) issue a prompt.
2. Tab Bridge **auto-injects** the prompt into the browser tab.
3. Tab Bridge **auto-sends** it (clicks Send programmatically).
4. Tab Bridge **auto-waits** for streaming generation to finish.
5. Tab Bridge **auto-reads** the pristine reply and delivers it straight to your IDE.

---

## 🚀 Quick Setup (2 Steps)

### Step 1: Start the Local Bridge Server
Open a terminal in `H:\Projects\tab-bridge` and run:
```bash
npm start
```
You will see:
```text
====================================================
🚀 Tab Bridge Server is running!
📡 Local HTTP & WebSocket: http://127.0.0.1:4040
🤖 OpenAI API Base URL:    http://127.0.0.1:4040/v1
📊 Status Endpoint:        http://127.0.0.1:4040/health
====================================================
```

### Step 2: Load the Extension in Chrome
1. Open Google Chrome and go to `chrome://extensions`.
2. Turn ON **Developer mode** (top right switch).
3. Click **Load unpacked** (top left).
4. Select the folder:
   ```text
   H:\Projects\tab-bridge\extension
   ```
5. Open any tab in Chrome to **ChatGPT**, **Claude**, or **Gemini**.
6. The extension will automatically connect to the local server in the background!

---

## 💡 How to Use It

### Method 1: In VS Code (Direct Hotkeys)
Open VS Code with the extension installed, or run commands from the Command Palette (`Ctrl+Shift+P`):
* `Ctrl+Alt+A`: **Ask Browser AI** — prompts for a question and returns the answer directly in VS Code.
* `Ctrl+Alt+S`: **Send Selected Code** — sends highlighted code to the browser AI for debugging, explanation, or optimization.
* **Status Bar:** Bottom right shows `🌐 Browser AI: ChatGPT` (or Claude / Gemini) showing live connectivity.

### Method 2: From ANY Local AI or Copilot Tool (OpenAI API Mode)
Any local tool that supports custom OpenAI-compatible endpoints (such as **Ollama**, **Continue.dev**, **Cursor**, **Cline**, or custom Python scripts) can now use your browser AI tabs as an LLM provider:
* **API Base URL:** `http://127.0.0.1:4040/v1`
* **API Key:** `dummy` (any text)
* **Model:**
  * `browser-auto`: Automatically uses whatever AI tab is open.
  * `browser-chatgpt`: Explicitly routes to ChatGPT.
  * `browser-claude`: Explicitly routes to Claude.
  * `browser-gemini`: Explicitly routes to Gemini.

### Method 3: Instant CLI Test
To test the whole pipeline without even opening VS Code:
```bash
npm test
```
This runs `test-client.mjs`, which sends a prompt to your browser tab and logs the response in your terminal!

---

## 🧪 Experimental Feature: Multi-Tab Broadcast
Want to ask all three AIs (ChatGPT + Claude + Gemini) the same question and compare their answers side-by-side?
* In VS Code: Run command **`Tab Bridge: Broadcast to All Browser AIs (Multi-Tab)`**.
* Via API: Call `POST http://127.0.0.1:4040/api/multi-prompt` with `{ "prompt": "..." }`.
Tab Bridge will inject into all open tabs concurrently, gather all responses, and return them together.

---

## 🛡️ Why This Is Completely Safe & Ban-Free
1. **Zero Tamper Blockers:** Silknet's old mouse-freezing issue was caused by an overzealous tamper detection script that cancelled mouse clicks. Tab Bridge has **zero tamper guards** and **never cancels your events**. Your physical mouse and keyboard work completely normally at all times.
2. **Standard DOM Events:** Text injection uses standard browser setters, and auto-send uses standard DOM `.click()` events identical to human interaction.
3. **No Credential Access:** The extension does not read passwords, cookies, or authorization tokens. It solely automates the prompt composer and reads the chat reply.
4. **Local-Only Communication:** All communications run strictly over `127.0.0.1` (localhost). Nothing is ever sent to external third-party servers.
