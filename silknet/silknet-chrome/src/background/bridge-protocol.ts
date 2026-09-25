// Silknet — BRIDGE protocol schema (Chrome side).
//
// ⚠️ KEPT IN SYNC, BY HAND, with `silknet-vscode/src/bridge/message-schema.ts`.
// The two extensions build independently, so the schema is deliberately
// duplicated rather than shared; any change here MUST be mirrored there (and
// vice versa). The `protocolVersion` major is the compatibility gate.
//
// This is the WebSocket bridge's own typed schema. It is deliberately SEPARATE
// from this extension's internal `ns: "silknet/v0.1"` messaging: different
// transport, different trust boundary, different validators. Do not unify them.
//
// SECURITY RULE: every message arriving over the bridge is validated against
// this schema AT THE PARSE LAYER, before any processing logic runs. Anything
// that does not conform is rejected outright.

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface FileExcerpt {
  path: string;
  /** The excerpt content. */
  lines: string;
  /** Present when the file was cut off at a line boundary. */
  truncatedAt?: number;
}

export interface RedactionMatch {
  /** Which category matched, e.g. "aws-key", "github-token". */
  pattern: string;
  /** File + approximate position — NEVER the raw secret itself. */
  location: string;
}

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

export type BridgeMessage =
  | { type: 'HELLO'; protocolVersion: string; sessionId: string; heartbeatIntervalMs: number }
  | { type: 'AUTH'; token: string }
  | { type: 'AUTH_OK' }
  | { type: 'AUTH_FAILED'; reason: string }
  | { type: 'PING' }
  | { type: 'PONG' }
  | {
      type: 'CONTEXT_REQUEST';
      debateId: string;
      round: number;
      workspaceHint?: string;
      /** Providers the requesting debate targets (optional; used for the manifest). */
      targetProviders?: string[];
    }
  | {
      type: 'CONTEXT_REPORT';
      debateId: string;
      files: FileExcerpt[];
      approxLines: number;
      truncated: boolean;
    }
  | {
      type: 'EGRESS_MANIFEST';
      debateId: string;
      targetProviders: string[];
      fileCount: number;
      approxLines: number;
      /** Paths of the files behind the report, for the selected-files dialog. */
      paths?: string[];
    }
  | {
      type: 'EGRESS_APPROVED';
      debateId: string;
      mode: 'none' | 'report-only' | 'selected-files';
      selectedFiles?: string[];
    }
  | { type: 'EGRESS_DENIED'; debateId: string }
  | { type: 'REDACTION_FOUND'; debateId: string; matches: RedactionMatch[] }
  | { type: 'REDACTION_DECISION'; debateId: string; decision: 'approve' | 'redact' | 'cancel' }
  | { type: 'ERROR'; code: string; message: string }
  // v1.1 additions (schema reserved; nothing sends or acts on these in v1.0).
  | {
      type: 'FILE_PROPOSAL';
      debateId: string;
      proposalId: string;
      path: string;
      baseHash: string;
      diff: string;
      provenance: string;
    }
  | { type: 'FILE_APPROVAL'; proposalId: string; decision: 'approve' | 'reject' };

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => isNonEmptyStr(item));

const isOptionalStr = (v: unknown): boolean => v === undefined || isStr(v);
const isOptionalStrArray = (v: unknown): boolean => v === undefined || isStrArray(v);
const isFiniteInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

const EGRESS_MODES = ['none', 'report-only', 'selected-files'] as const;
const REDACTION_DECISIONS = ['approve', 'redact', 'cancel'] as const;

const isFileExcerpt = (v: unknown): v is FileExcerpt => {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyStr(v['path']) &&
    isStr(v['lines']) &&
    (v['truncatedAt'] === undefined || isFiniteInt(v['truncatedAt']))
  );
};

const isRedactionMatch = (v: unknown): v is RedactionMatch => {
  if (!isRecord(v)) return false;
  return isNonEmptyStr(v['pattern']) && isNonEmptyStr(v['location']);
};

/**
 * Validates one parsed JSON value against the BridgeMessage union. Returns the
 * narrowed message on success, null on any mismatch.
 */
export function parseBridgeMessage(v: unknown): BridgeMessage | null {
  if (!isRecord(v)) return null;
  const type = v['type'];
  if (!isNonEmptyStr(type)) return null;

  switch (type) {
    case 'HELLO':
      return isNonEmptyStr(v['protocolVersion']) &&
        isNonEmptyStr(v['sessionId']) &&
        isFiniteInt(v['heartbeatIntervalMs']) &&
        (v['heartbeatIntervalMs'] as number) >= 1000 &&
        (v['heartbeatIntervalMs'] as number) <= 120_000
        ? {
            type,
            protocolVersion: v['protocolVersion'] as string,
            sessionId: v['sessionId'] as string,
            heartbeatIntervalMs: v['heartbeatIntervalMs'] as number,
          }
        : null;

    case 'AUTH':
      return isNonEmptyStr(v['token']) ? { type, token: v['token'] as string } : null;

    case 'AUTH_OK':
      return { type };

    case 'AUTH_FAILED':
      return isNonEmptyStr(v['reason']) ? { type, reason: v['reason'] as string } : null;

    case 'PING':
    case 'PONG':
      return { type };

    case 'CONTEXT_REQUEST':
      return isNonEmptyStr(v['debateId']) &&
        isFiniteInt(v['round']) &&
        (v['round'] as number) >= 0 &&
        isOptionalStr(v['workspaceHint']) &&
        isOptionalStrArray(v['targetProviders'])
        ? {
            type,
            debateId: v['debateId'] as string,
            round: v['round'] as number,
            ...(v['workspaceHint'] !== undefined ? { workspaceHint: v['workspaceHint'] as string } : {}),
            ...(v['targetProviders'] !== undefined ? { targetProviders: v['targetProviders'] as string[] } : {}),
          }
        : null;

    case 'CONTEXT_REPORT': {
      if (!isNonEmptyStr(v['debateId']) || !Array.isArray(v['files'])) return null;
      if (!(v['files'] as unknown[]).every(isFileExcerpt)) return null;
      if (!isFiniteInt(v['approxLines']) || !isBool(v['truncated'])) return null;
      return {
        type,
        debateId: v['debateId'] as string,
        files: v['files'] as FileExcerpt[],
        approxLines: v['approxLines'] as number,
        truncated: v['truncated'] as boolean,
      };
    }

    case 'EGRESS_MANIFEST':
      return isNonEmptyStr(v['debateId']) &&
        isStrArray(v['targetProviders']) &&
        isFiniteInt(v['fileCount']) &&
        isFiniteInt(v['approxLines']) &&
        isOptionalStrArray(v['paths'])
        ? {
            type,
            debateId: v['debateId'] as string,
            targetProviders: v['targetProviders'] as string[],
            fileCount: v['fileCount'] as number,
            approxLines: v['approxLines'] as number,
            ...(v['paths'] !== undefined ? { paths: v['paths'] as string[] } : {}),
          }
        : null;

    case 'EGRESS_APPROVED': {
      if (!isNonEmptyStr(v['debateId'])) return null;
      const mode = v['mode'];
      if (typeof mode !== 'string' || !(EGRESS_MODES as readonly string[]).includes(mode)) return null;
      if (mode === 'selected-files') {
        if (!isStrArray(v['selectedFiles']) || (v['selectedFiles'] as string[]).length === 0) return null;
        return {
          type,
          debateId: v['debateId'] as string,
          mode,
          selectedFiles: v['selectedFiles'] as string[],
        };
      }
      return { type, debateId: v['debateId'] as string, mode: mode as 'none' | 'report-only' };
    }

    case 'EGRESS_DENIED':
      return isNonEmptyStr(v['debateId']) ? { type, debateId: v['debateId'] as string } : null;

    case 'REDACTION_FOUND': {
      if (!isNonEmptyStr(v['debateId']) || !Array.isArray(v['matches'])) return null;
      if (!(v['matches'] as unknown[]).every(isRedactionMatch)) return null;
      return { type, debateId: v['debateId'] as string, matches: v['matches'] as RedactionMatch[] };
    }

    case 'REDACTION_DECISION': {
      if (!isNonEmptyStr(v['debateId'])) return null;
      const decision = v['decision'];
      if (typeof decision !== 'string' || !(REDACTION_DECISIONS as readonly string[]).includes(decision)) {
        return null;
      }
      return {
        type,
        debateId: v['debateId'] as string,
        decision: decision as 'approve' | 'redact' | 'cancel',
      };
    }

    case 'ERROR':
      return isNonEmptyStr(v['code']) && isNonEmptyStr(v['message'])
        ? { type, code: v['code'] as string, message: v['message'] as string }
        : null;

    case 'FILE_PROPOSAL':
    case 'FILE_APPROVAL':
      // Schema is reserved for v1.1; v1.0 has no code path that consumes these.
      return null;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Convenience aliases for the message shapes the side panel renders.
// ---------------------------------------------------------------------------

export type EgressManifestMessage = Extract<BridgeMessage, { type: 'EGRESS_MANIFEST' }>;
export type RedactionFoundMessage = Extract<BridgeMessage, { type: 'REDACTION_FOUND' }>;
export type ContextReportMessage = Extract<BridgeMessage, { type: 'CONTEXT_REPORT' }>;

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

export const BRIDGE_PROTOCOL_VERSION = '1.0.0';

/** Major-version equality is the compatibility rule (mirrors the VS Code side). */
export function protocolVersionsCompatible(a: string, b: string): boolean {
  const majorA = Number.parseInt(a.split('.')[0] ?? '', 10);
  const majorB = Number.parseInt(b.split('.')[0] ?? '', 10);
  if (Number.isNaN(majorA) || Number.isNaN(majorB)) return false;
  return majorA === majorB;
}
