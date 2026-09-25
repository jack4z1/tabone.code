// Silknet — Ollama client (local model backend).
//
// Auto-discovers the local Ollama server at http://localhost:11434 on startup
// and surfaces ready/not-ready state. Everything runs on the loopback
// interface; no credential or telemetry data leaves the machine here.
//
// The model's output is UNTRUSTED DATA: it can influence the content of the
// grounding report and nothing else. It is never interpreted as a control
// instruction, never given filesystem access, never allowed to trigger writes.

const OLLAMA_TIMEOUT_MS = 3_000;

export interface OllamaModelInfo {
  name: string;
}

export interface OllamaStatus {
  ready: boolean;
  /** Discovered models (tag names), when ready. */
  models: string[];
  /** Human-readable reason when not ready. */
  reason?: string;
}

/** Probes the Ollama root endpoint and lists installed models. */
export async function probeOllama(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OllamaStatus> {
  const base = normalizeBaseUrl(baseUrl);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/api/tags`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      return { ready: false, models: [], reason: `Ollama answered HTTP ${response.status}` };
    }
    const body: unknown = await response.json();
    return { ready: true, models: parseModelNames(body) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ready: false,
      models: [],
      reason: `no Ollama server at ${base} (${detail}) — start Ollama, or check the silknet.ollamaUrl setting`,
    };
  }
}

/** True when the configured model is installed locally. */
export function hasModel(status: OllamaStatus, model: string): boolean {
  return status.models.some((m) => m === model || m.split(':')[0] === model.split(':')[0]);
}

export interface GenerateOptions {
  model: string;
  prompt: string;
  /** Backend may stream; we always want the complete text. */
  system?: string;
  timeoutMs?: number;
}

export interface GenerateResult {
  ok: boolean;
  text: string;
  reason?: string;
}

/** Runs a one-shot generation against /api/generate (non-streaming). */
export async function generate(
  baseUrl: string,
  options: GenerateOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<GenerateResult> {
  const base = normalizeBaseUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  try {
    const response = await fetchImpl(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        prompt: options.prompt,
        ...(options.system !== undefined ? { system: options.system } : {}),
        stream: false,
        options: { temperature: 0.2 },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, text: '', reason: `Ollama answered HTTP ${response.status}` };
    }
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      typeof (body as Record<string, unknown>)['response'] === 'string'
    ) {
      return { ok: true, text: (body as Record<string, unknown>)['response'] as string };
    }
    return { ok: false, text: '', reason: 'unexpected Ollama response shape' };
  } catch (err) {
    return {
      ok: false,
      text: '',
      reason: `generation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function parseModelNames(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const models = (body as Record<string, unknown>)['models'];
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  for (const entry of models) {
    if (typeof entry === 'object' && entry !== null) {
      const name = (entry as Record<string, unknown>)['name'];
      if (typeof name === 'string' && name.length > 0) names.push(name);
    }
  }
  return names;
}
