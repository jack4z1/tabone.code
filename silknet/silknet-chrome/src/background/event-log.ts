// Silknet — event log (source of truth).
//
// Storage is IndexedDB, not chrome.storage.session: session storage has a 10MB
// quota and is cleared when Chrome closes, whereas a debate log must survive
// restarts and accumulate across many debates.
//
// The log is APPEND-ONLY and is the SOURCE OF TRUTH for run state. UI state is
// derived from it — never held as primary truth in a transient in-memory async
// chain. Every operation should be restartable from persisted state.
//
// Nothing is written to or read from this log without passing the schema
// validator first.

const DB_NAME = 'silknet';
const DB_VERSION = 1;
const STORE = 'events';

export type DebateEvent =
  | { type: 'RUN_CREATED'; id: string; objective: string; providers: string[]; timestamp: number }
  | { type: 'ROUND_STARTED'; runId: string; round: number; timestamp: number }
  | {
      type: 'SUBMISSION_REQUESTED';
      runId: string;
      round: number;
      provider: string;
      opId: string;
      text: string;
      timestamp: number;
    }
  | { type: 'SUBMISSION_ACKNOWLEDGED'; runId: string; opId: string; timestamp: number }
  | { type: 'REPLY_DETECTED'; runId: string; opId: string; text: string; reason: string[]; timestamp: number }
  | { type: 'PROVIDER_FAILED'; runId: string; provider: string; reason: string; timestamp: number }
  | { type: 'ROUND_COMPLETED'; runId: string; round: number; timestamp: number }
  | { type: 'USER_INTERJECTED'; runId: string; text: string; timestamp: number }
  | { type: 'RUN_STOPPED'; runId: string; reason: string; timestamp: number }
  | { type: 'TAMPER_DETECTED'; runId: string; provider: string; opId: string; timestamp: number }
  // Bridge + grounding events (Phase B0.x). The bridge is the WebSocket link to
  // the VS Code extension; grounding context is the local report it provides.
  | { type: 'BRIDGE_CONNECTED'; transport: 'websocket-127.0.0.1'; timestamp: number }
  | { type: 'BRIDGE_DISCONNECTED'; reason: string; timestamp: number }
  | { type: 'GROUNDING_CONTEXT_REQUESTED'; runId: string; debateId: string; round: number; timestamp: number }
  | { type: 'EGRESS_DECIDED'; runId: string; debateId: string; decision: string; timestamp: number }
  | { type: 'GROUNDING_CONTEXT_INJECTED'; runId: string; debateId: string; approxLines: number; truncated: boolean; timestamp: number };

export type DebateEventType = DebateEvent['type'];

export type StoredEvent = DebateEvent & { seq: number };

const EVENT_TYPES: readonly DebateEventType[] = [
  'RUN_CREATED',
  'ROUND_STARTED',
  'SUBMISSION_REQUESTED',
  'SUBMISSION_ACKNOWLEDGED',
  'REPLY_DETECTED',
  'PROVIDER_FAILED',
  'ROUND_COMPLETED',
  'USER_INTERJECTED',
  'RUN_STOPPED',
  'TAMPER_DETECTED',
  'BRIDGE_CONNECTED',
  'BRIDGE_DISCONNECTED',
  'GROUNDING_CONTEXT_REQUESTED',
  'EGRESS_DECIDED',
  'GROUNDING_CONTEXT_INJECTED',
];

export type EventValidation =
  | { ok: true; event: DebateEvent }
  | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const nonEmptyStr = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const strArray = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  return v.every((x) => typeof x === 'string') ? (v as string[]) : null;
};

/**
 * Validates an untrusted value against the DebateEvent schema and returns a
 * normalised copy (known fields only), so nothing unvalidated is ever persisted
 * or derived from.
 */
export function validateEvent(v: unknown): EventValidation {
  if (!isRecord(v)) return { ok: false, reason: 'event is not an object' };

  const type = str(v['type']);
  if (type === null || !EVENT_TYPES.includes(type as DebateEventType)) {
    return { ok: false, reason: `unknown event type ${JSON.stringify(v['type'])}` };
  }
  // Narrowed once, then switched on directly so each branch's literal type is
  // preserved in the constructed object.
  const eventType = type as DebateEventType;
  const timestamp = num(v['timestamp']);
  if (timestamp === null) return { ok: false, reason: `${type}: timestamp must be a finite number` };

  switch (eventType) {
    case 'RUN_CREATED': {
      const id = nonEmptyStr(v['id']);
      const objective = str(v['objective']);
      const providers = strArray(v['providers']);
      if (!id) return { ok: false, reason: 'RUN_CREATED: id required' };
      if (objective === null) return { ok: false, reason: 'RUN_CREATED: objective required' };
      if (!providers) return { ok: false, reason: 'RUN_CREATED: providers must be string[]' };
      return { ok: true, event: { type: eventType, id, objective, providers, timestamp } };
    }
    case 'ROUND_STARTED':
    case 'ROUND_COMPLETED': {
      const runId = nonEmptyStr(v['runId']);
      const round = num(v['round']);
      if (!runId) return { ok: false, reason: `${type}: runId required` };
      if (round === null || round < 1) return { ok: false, reason: `${type}: round must be a positive integer` };
      return { ok: true, event: { type: eventType, runId, round, timestamp } };
    }
    case 'SUBMISSION_REQUESTED': {
      const runId = nonEmptyStr(v['runId']);
      const round = num(v['round']);
      const provider = nonEmptyStr(v['provider']);
      const opId = nonEmptyStr(v['opId']);
      const text = str(v['text']);
      if (!runId) return { ok: false, reason: 'SUBMISSION_REQUESTED: runId required' };
      if (round === null || round < 1) return { ok: false, reason: 'SUBMISSION_REQUESTED: round required' };
      if (!provider) return { ok: false, reason: 'SUBMISSION_REQUESTED: provider required' };
      if (!opId) return { ok: false, reason: 'SUBMISSION_REQUESTED: opId required' };
      if (text === null) return { ok: false, reason: 'SUBMISSION_REQUESTED: text required' };
      return { ok: true, event: { type: eventType, runId, round, provider, opId, text, timestamp } };
    }
    case 'SUBMISSION_ACKNOWLEDGED': {
      const runId = nonEmptyStr(v['runId']);
      const opId = nonEmptyStr(v['opId']);
      if (!runId) return { ok: false, reason: 'SUBMISSION_ACKNOWLEDGED: runId required' };
      if (!opId) return { ok: false, reason: 'SUBMISSION_ACKNOWLEDGED: opId required' };
      return { ok: true, event: { type: eventType, runId, opId, timestamp } };
    }
    case 'REPLY_DETECTED': {
      const runId = nonEmptyStr(v['runId']);
      const opId = nonEmptyStr(v['opId']);
      const text = str(v['text']);
      const reason = strArray(v['reason']);
      if (!runId) return { ok: false, reason: 'REPLY_DETECTED: runId required' };
      if (!opId) return { ok: false, reason: 'REPLY_DETECTED: opId required' };
      if (text === null) return { ok: false, reason: 'REPLY_DETECTED: text required' };
      if (!reason) return { ok: false, reason: 'REPLY_DETECTED: reason must be string[]' };
      return { ok: true, event: { type: eventType, runId, opId, text, reason, timestamp } };
    }
    case 'PROVIDER_FAILED': {
      const runId = nonEmptyStr(v['runId']);
      const provider = nonEmptyStr(v['provider']);
      const reason = str(v['reason']);
      if (!runId) return { ok: false, reason: 'PROVIDER_FAILED: runId required' };
      if (!provider) return { ok: false, reason: 'PROVIDER_FAILED: provider required' };
      if (reason === null) return { ok: false, reason: 'PROVIDER_FAILED: reason required' };
      return { ok: true, event: { type: eventType, runId, provider, reason, timestamp } };
    }
    case 'USER_INTERJECTED': {
      const runId = nonEmptyStr(v['runId']);
      const text = str(v['text']);
      if (!runId) return { ok: false, reason: 'USER_INTERJECTED: runId required' };
      if (text === null) return { ok: false, reason: 'USER_INTERJECTED: text required' };
      return { ok: true, event: { type: eventType, runId, text, timestamp } };
    }
    case 'RUN_STOPPED': {
      const runId = nonEmptyStr(v['runId']);
      const reason = str(v['reason']);
      if (!runId) return { ok: false, reason: 'RUN_STOPPED: runId required' };
      if (reason === null) return { ok: false, reason: 'RUN_STOPPED: reason required' };
      return { ok: true, event: { type: eventType, runId, reason, timestamp } };
    }
    case 'TAMPER_DETECTED': {
      const runId = nonEmptyStr(v['runId']);
      const provider = nonEmptyStr(v['provider']);
      const opId = nonEmptyStr(v['opId']);
      if (!runId) return { ok: false, reason: 'TAMPER_DETECTED: runId required' };
      if (!provider) return { ok: false, reason: 'TAMPER_DETECTED: provider required' };
      if (!opId) return { ok: false, reason: 'TAMPER_DETECTED: opId required' };
      return { ok: true, event: { type: eventType, runId, provider, opId, timestamp } };
    }
    case 'BRIDGE_CONNECTED':
      return { ok: true, event: { type: eventType, transport: 'websocket-127.0.0.1', timestamp } };
    case 'BRIDGE_DISCONNECTED': {
      const reason = str(v['reason']);
      if (reason === null) return { ok: false, reason: 'BRIDGE_DISCONNECTED: reason required' };
      return { ok: true, event: { type: eventType, reason, timestamp } };
    }
    case 'GROUNDING_CONTEXT_REQUESTED': {
      const runId = nonEmptyStr(v['runId']);
      const debateId = nonEmptyStr(v['debateId']);
      const round = num(v['round']);
      if (!runId) return { ok: false, reason: 'GROUNDING_CONTEXT_REQUESTED: runId required' };
      if (!debateId) return { ok: false, reason: 'GROUNDING_CONTEXT_REQUESTED: debateId required' };
      if (round === null || round < 0) return { ok: false, reason: 'GROUNDING_CONTEXT_REQUESTED: round required' };
      return { ok: true, event: { type: eventType, runId, debateId, round, timestamp } };
    }
    case 'EGRESS_DECIDED': {
      const runId = nonEmptyStr(v['runId']);
      const debateId = nonEmptyStr(v['debateId']);
      const decision = nonEmptyStr(v['decision']);
      if (!runId) return { ok: false, reason: 'EGRESS_DECIDED: runId required' };
      if (!debateId) return { ok: false, reason: 'EGRESS_DECIDED: debateId required' };
      if (!decision) return { ok: false, reason: 'EGRESS_DECIDED: decision required' };
      return { ok: true, event: { type: eventType, runId, debateId, decision, timestamp } };
    }
    case 'GROUNDING_CONTEXT_INJECTED': {
      const runId = nonEmptyStr(v['runId']);
      const debateId = nonEmptyStr(v['debateId']);
      const approxLines = num(v['approxLines']);
      if (!runId) return { ok: false, reason: 'GROUNDING_CONTEXT_INJECTED: runId required' };
      if (!debateId) return { ok: false, reason: 'GROUNDING_CONTEXT_INJECTED: debateId required' };
      if (approxLines === null || approxLines < 0) {
        return { ok: false, reason: 'GROUNDING_CONTEXT_INJECTED: approxLines required' };
      }
      const truncated = v['truncated'];
      if (typeof truncated !== 'boolean') {
        return { ok: false, reason: 'GROUNDING_CONTEXT_INJECTED: truncated must be boolean' };
      }
      return { ok: true, event: { type: eventType, runId, debateId, approxLines, truncated, timestamp } };
    }
    default:
      return { ok: false, reason: `unhandled event type ${type}` };
  }
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { autoIncrement: true });
        // Sparse indexes: not every event carries runId/opId, and records
        // lacking the key simply do not appear in that index.
        store.createIndex('runId', 'runId', { unique: false });
        store.createIndex('opId', 'opId', { unique: false });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = fn(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
      }),
  );
}

/**
 * Appends one event after validating it. Rejects invalid events loudly rather
 * than persisting something the rest of the system cannot trust.
 */
export async function appendEvent(event: unknown): Promise<StoredEvent> {
  const validation = validateEvent(event);
  if (!validation.ok) throw new Error(`appendEvent: invalid event — ${validation.reason}`);
  const key = await tx<IDBValidKey>('readwrite', (store) => store.add(validation.event));
  return { ...validation.event, seq: typeof key === 'number' ? key : Number(key) };
}

/** Reads the whole log in append order, dropping any record that fails validation. */
export async function readAll(): Promise<StoredEvent[]> {
  const db = await openDb();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  const out: StoredEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      const validation = validateEvent(cursor.value);
      // A record that no longer validates is skipped, never trusted.
      if (validation.ok && typeof cursor.key === 'number') {
        out.push({ ...validation.event, seq: cursor.key });
      }
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('cursor failed'));
  });
  return out;
}

/** Every event belonging to one run (RUN_CREATED carries `id`, not `runId`). */
export async function readRun(runId: string): Promise<StoredEvent[]> {
  const all = await readAll();
  return all.filter((e) => {
    if (e.type === 'RUN_CREATED') return e.id === runId;
    // Bridge events without a runId simply never match a run filter.
    return 'runId' in e ? e.runId === runId : false;
  });
}

/**
 * Idempotency check: a retried operation whose acknowledgement is already logged
 * must be detected and ignored, never double-submitted.
 */
export async function isOpAcknowledged(opId: string): Promise<boolean> {
  const all = await readAll();
  return all.some((e) => e.type === 'SUBMISSION_ACKNOWLEDGED' && e.opId === opId);
}

export async function clearLog(): Promise<void> {
  await tx('readwrite', (store) => store.clear());
}

export const RETENTION_MAX_RUNS = 100;
export const RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface RetentionResult {
  deletedRuns: string[];
  deletedEventsCount: number;
  remainingRunsCount: number;
}

/**
 * Enforces the spec's retention policy:
 * Keeps the most recent 100 debates or 30 days, whichever is smaller.
 * Deletes older records to prevent unbounded IndexedDB growth.
 */
export async function applyRetentionPolicy(
  now = Date.now(),
  maxRuns = RETENTION_MAX_RUNS,
  maxAgeMs = RETENTION_MAX_AGE_MS,
): Promise<RetentionResult> {
  const all = await readAll();
  if (all.length === 0) {
    return { deletedRuns: [], deletedEventsCount: 0, remainingRunsCount: 0 };
  }

  // Group events by run
  const runsMap = new Map<string, { latestTimestamp: number; seqs: number[] }>();
  for (const e of all) {
    const runId = e.type === 'RUN_CREATED' ? e.id : ('runId' in e ? e.runId : `${e.type}@${e.timestamp}:${e.seq}`);
    let entry = runsMap.get(runId);
    if (!entry) {
      entry = { latestTimestamp: e.timestamp, seqs: [] };
      runsMap.set(runId, entry);
    }
    if (e.timestamp > entry.latestTimestamp) {
      entry.latestTimestamp = e.timestamp;
    }
    entry.seqs.push(e.seq);
  }

  const cutoffTime = now - maxAgeMs;
  const expiredRunIds = new Set<string>();

  // 1. Expire runs older than 30 days
  for (const [runId, data] of runsMap.entries()) {
    if (data.latestTimestamp < cutoffTime) {
      expiredRunIds.add(runId);
    }
  }

  // 2. Cap at maxRuns (most recent first)
  const sortedRuns = [...runsMap.entries()]
    .filter(([runId]) => !expiredRunIds.has(runId))
    .sort((a, b) => b[1].latestTimestamp - a[1].latestTimestamp);

  const excessRunIds = new Set<string>();
  if (sortedRuns.length > maxRuns) {
    for (let i = maxRuns; i < sortedRuns.length; i++) {
      const run = sortedRuns[i];
      if (run) excessRunIds.add(run[0]);
    }
  }

  const runsToDelete = new Set([...expiredRunIds, ...excessRunIds]);
  if (runsToDelete.size === 0) {
    return { deletedRuns: [], deletedEventsCount: 0, remainingRunsCount: runsMap.size };
  }

  const seqsToDelete: number[] = [];
  for (const runId of runsToDelete) {
    const entry = runsMap.get(runId);
    if (entry) {
      seqsToDelete.push(...entry.seqs);
    }
  }

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    for (const seq of seqsToDelete) {
      store.delete(seq);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('deletion failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
  });

  return {
    deletedRuns: [...runsToDelete],
    deletedEventsCount: seqsToDelete.length,
    remainingRunsCount: runsMap.size - runsToDelete.size,
  };
}

/**
 * Exports the entire event log before purging it from IndexedDB.
 */
export async function exportAndPurgeLog(): Promise<{ count: number; events: StoredEvent[] }> {
  const events = await readAll();
  await clearLog();
  return { count: events.length, events };
}
