import http from 'node:http';
import { WebSocketServer } from 'ws';
import { TabManager } from './tab-manager.js';
import { PrivacyShield } from './sanitizer.js';
import { AdvisorEngine } from './advisor.js';
const PORT = Number(process.env.PORT || 4040);
const HOST = '127.0.0.1';
const tabManager = new TabManager();
// Create HTTP server
const server = http.createServer(async (req, res) => {
    // Global CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    // 1. Health & Status
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/status')) {
        const tabs = tabManager.getConnectedTabs();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            server: 'Tab Bridge Server v1.0',
            connectedTabsCount: tabs.length,
            connectedTabs: tabs,
            activeProviders: tabManager.getActiveProviders(),
        }));
        return;
    }
    // 2. Direct Simple API: POST /api/prompt
    if (req.method === 'POST' && url.pathname === '/api/prompt') {
        try {
            const body = await parseJsonBody(req);
            const prompt = body.prompt;
            const provider = body.provider || 'auto';
            if (!prompt || typeof prompt !== 'string') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required string field: "prompt"' }));
                return;
            }
            // Auto-scrub through Privacy Shield before dispatching
            const sanitized = PrivacyShield.sanitize(prompt);
            if (sanitized.redactedCount > 0) {
                console.log(`[PrivacyShield] 🛡️ Scrubbed ${sanitized.redactedCount} items (${sanitized.redactionsSummary.join(', ')}) from prompt`);
            }
            const isManualUi = req.headers['x-tab-bridge-source'] === 'manual-ui';
            // Human-in-the-Loop Barrier: Block any automated script/caller unless user approves
            if (!isManualUi && tabManager.isApprovalRequired()) {
                const approved = await tabManager.requestApproval({
                    caller: 'Terminal / Automated Tool',
                    task: prompt.slice(0, 120) + (prompt.length > 120 ? '...' : ''),
                    prompt: sanitized.cleanText,
                    provider,
                });
                if (!approved) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Blocked: Human user denied permission to consult the browser AI.' }));
                    return;
                }
            }
            if (provider === 'all') {
                // Multi-tab broadcast
                const results = await tabManager.broadcastMultiPrompt(sanitized.cleanText);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, multi: true, results, redacted: sanitized.redactionsSummary }));
                return;
            }
            const result = await tabManager.executePrompt(sanitized.cleanText, provider);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...result, redacted: sanitized.redactionsSummary }));
        }
        catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
        }
        return;
    }
    // 3. Advisor Handoff API: POST /api/advisor
    // Bridges Local AI (stuck / error) to Frontier Browser AI with problem structuring & security
    if (req.method === 'POST' && url.pathname === '/api/advisor') {
        try {
            const body = await parseJsonBody(req);
            if (!body.task) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required "task" description' }));
                return;
            }
            const isManualUi = req.headers['x-tab-bridge-source'] === 'manual-ui';
            if (!isManualUi && tabManager.isApprovalRequired()) {
                const approved = await tabManager.requestApproval({
                    caller: 'Local AI / Automated Advisor Client',
                    task: body.task.slice(0, 120),
                    prompt: body.task,
                    provider: body.provider || 'auto',
                });
                if (!approved) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Blocked: Human user denied permission to consult the browser AI.' }));
                    return;
                }
            }
            const response = await AdvisorEngine.consultAdvisor(tabManager, {
                task: body.task,
                code: body.code,
                error: body.error,
                language: body.language,
                provider: body.provider,
                mode: body.mode,
                guardrails: body.guardrails,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
        }
        catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
        }
        return;
    }
    // 4. Emergency Killswitch API: POST /api/killswitch
    if (req.method === 'POST' && url.pathname === '/api/killswitch') {
        const abortedCount = tabManager.abortAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Emergency Killswitch executed. Aborted ${abortedCount} active request(s).` }));
        return;
    }
    // 5. Human Approval Gate APIs
    if (req.method === 'GET' && url.pathname === '/api/approvals') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            requireApproval: tabManager.isApprovalRequired(),
            pendingApprovals: tabManager.getPendingApprovals(),
        }));
        return;
    }
    if (req.method === 'POST' && url.pathname === '/api/approvals/decide') {
        try {
            const body = await parseJsonBody(req);
            const { id, approved } = body;
            const success = tabManager.resolveApproval(id, Boolean(approved));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success, id, approved }));
        }
        catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }
    if (req.method === 'POST' && url.pathname === '/api/gate/toggle') {
        try {
            const body = await parseJsonBody(req);
            if (typeof body.requireApproval === 'boolean') {
                tabManager.setRequireApproval(body.requireApproval);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ requireApproval: tabManager.isApprovalRequired() }));
        }
        catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }
    // 6. OpenAI-Compatible: GET /v1/models
    if (req.method === 'GET' && url.pathname === '/v1/models') {
        const providers = tabManager.getActiveProviders();
        const models = [
            { id: 'browser-auto', object: 'model', owned_by: 'tab-bridge' },
            ...providers.map((p) => ({ id: `browser-${p}`, object: 'model', owned_by: 'tab-bridge' })),
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models }));
        return;
    }
    // 5. OpenAI-Compatible: POST /v1/chat/completions
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        try {
            const body = await parseJsonBody(req);
            const messages = body.messages || [];
            const model = body.model || 'browser-auto';
            // Format conversation into prompt
            let prompt = '';
            if (Array.isArray(messages) && messages.length > 0) {
                const lastMsg = messages[messages.length - 1];
                if (messages.length === 1) {
                    prompt = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
                }
                else {
                    prompt = messages
                        .map((m) => `${(m.role || 'user').toUpperCase()}:\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
                        .join('\n\n---\n\n');
                }
            }
            else if (body.prompt) {
                prompt = String(body.prompt);
            }
            if (!prompt) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No prompt or messages provided' } }));
                return;
            }
            const requestedProvider = model.replace(/^browser-/, '');
            const sanitized = PrivacyShield.sanitize(prompt);
            // Human-in-the-Loop Barrier: Require explicit permission before automated callers can consult browser AI
            if (tabManager.isApprovalRequired()) {
                const approved = await tabManager.requestApproval({
                    caller: 'Local AI / IDE Tool',
                    task: prompt.slice(0, 120) + (prompt.length > 120 ? '...' : ''),
                    prompt: sanitized.cleanText,
                    provider: requestedProvider,
                });
                if (!approved) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Blocked: Human user denied permission to consult the browser AI.' } }));
                    return;
                }
            }
            const result = await tabManager.executePrompt(sanitized.cleanText, requestedProvider);
            if (!result.success) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: result.error || 'Failed to get browser AI response' } }));
                return;
            }
            const openAiResponse = {
                id: `chatcmpl-${Date.now().toString(36)}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: `browser-${result.provider}`,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: result.reply,
                        },
                        finish_reason: 'stop',
                    },
                ],
                usage: {
                    prompt_tokens: Math.ceil(prompt.length / 4),
                    completion_tokens: Math.ceil(result.reply.length / 4),
                    total_tokens: Math.ceil((prompt.length + result.reply.length) / 4),
                },
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(openAiResponse));
        }
        catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: err.message || String(err) } }));
        }
        return;
    }
    // Not Found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
});
// WebSocket Server attached to HTTP server
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.type === 'HELLO') {
                const tabId = data.id || `tab_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                tabManager.registerTab(ws, {
                    id: tabId,
                    provider: data.provider || 'unknown',
                    title: data.title,
                    url: data.url,
                });
                // Acknowledge registration
                ws.send(JSON.stringify({ type: 'WELCOME', id: tabId, status: 'connected' }));
            }
            else if (data.type === 'SYNC_ALL_TABS') {
                if (Array.isArray(data.tabs)) {
                    tabManager.syncTabsForSocket(ws, data.tabs);
                }
            }
            else if (data.type === 'PROMPT_RESULT') {
                tabManager.handleMessageFromTab(data);
            }
            else if (data.type === 'TAB_ACTIVATED') {
                tabManager.markTabActive(data.id);
            }
            else if (data.type === 'TAB_CLOSED') {
                tabManager.unregisterTab(data.id);
            }
            else if (data.type === 'PING') {
                ws.isAlive = true;
                ws.send(JSON.stringify({ type: 'PONG' }));
            }
        }
        catch (err) {
            console.error('[WSS] Error parsing tab message:', err);
        }
    });
    const cleanup = () => {
        tabManager.unregisterTabsForSocket(ws);
    };
    ws.on('close', () => {
        cleanup();
    });
    ws.on('error', (err) => {
        console.error('[WSS] Socket error:', err);
        cleanup();
    });
});
// Periodic heartbeat to actively detect dead sockets (e.g. closed/killed browser process)
const heartbeat = setInterval(() => {
    wss.clients.forEach((client) => {
        const tracked = client;
        if (tracked.isAlive === false) {
            console.log('[WSS] Client failed heartbeat ping. Terminating dead socket...');
            tabManager.unregisterTabsForSocket(tracked);
            return tracked.terminate();
        }
        tracked.isAlive = false;
        tracked.ping();
    });
}, 5000);
heartbeat.unref();
async function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 10 * 1024 * 1024) {
                // 10MB limit
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            }
            catch (e) {
                reject(new Error('Invalid JSON format'));
            }
        });
        req.on('error', reject);
    });
}
// Start Server
server.listen(PORT, HOST, () => {
    console.log(`====================================================`);
    console.log(`🚀 Tab Bridge Server is running!`);
    console.log(`📡 Local HTTP & WebSocket: http://${HOST}:${PORT}`);
    console.log(`🤖 OpenAI API Base URL:    http://${HOST}:${PORT}/v1`);
    console.log(`📊 Status Endpoint:        http://${HOST}:${PORT}/health`);
    console.log(`====================================================`);
});
