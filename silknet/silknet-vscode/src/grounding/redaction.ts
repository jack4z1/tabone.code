// Silknet — cloud-egress redaction pass (v1.0 starting set).
//
// Runs on anything about to cross the egress boundary. The UX is
// warn-and-let-the-user-decide: show exactly what matched and where (NEVER the
// raw secret), then approve-as-is / redact-and-continue / cancel. Never
// silently block, never silently redact.
//
// These are v1.0 starting patterns, to be expanded over time.

import type { RedactionMatch } from '../bridge/message-schema';

interface RedactionRule {
  /** Category name surfaced in REDACTION_FOUND and to the user. */
  pattern: string;
  regex: RegExp;
  /** Replacement label used in redact-and-continue mode. */
  label: string;
}

const RULES: RedactionRule[] = [
  {
    pattern: 'aws-key',
    // AKIA + 16 uppercase alphanumeric characters, word-bounded.
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    label: '[REDACTED:AWS_KEY]',
  },
  {
    pattern: 'github-token',
    regex: /\b(?:ghp_|gho_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{16,}\b/g,
    label: '[REDACTED:GITHUB_TOKEN]',
  },
  {
    pattern: 'private-key-header',
    regex: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY(?: BLOCK)?-----/g,
    label: '[REDACTED:PRIVATE_KEY]',
  },
  {
    pattern: 'jwt',
    // header.payload.signature — the first two segments are base64url JSON.
    regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    label: '[REDACTED:JWT]',
  },
  {
    pattern: 'db-connection-string',
    // scheme://user:password@host — only flags embedded credentials.
    regex: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s/:]+:[^\s/@]+@[^\s]+/g,
    label: '[REDACTED:DB_CONNECTION_STRING]',
  },
  {
    pattern: 'env-style-credential',
    // VAR=value where the name mentions key/secret/token/password and the value
    // looks like a high-entropy credential (24+ chars, no spaces).
    regex: /\b[A-Z_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z_]*\s*=\s*["']?([A-Za-z0-9_\-/+=]{24,})["']?/g,
    label: '[REDACTED:CREDENTIAL]',
  },
  {
    pattern: 'generic-api-key',
    // Generic API-key-shaped string adjacent to key/secret/token/password. The
    // lookbehind (not \b) lets snake_case names like `api_key` match while
    // still excluding ordinary words that merely contain these substrings.
    regex: /(?<![A-Za-z])(?:key|secret|token|password)["']?\s*[:=]\s*["']?([a-zA-Z0-9_-]{32,})["']?/gi,
    label: '[REDACTED:API_KEY]',
  },
];

export interface RedactionScanResult {
  matches: RedactionMatch[];
  /** Rule labels by pattern, for redact-and-continue. */
  labels: Map<string, string>;
}

/**
 * Scans text for credential-shaped content. Matches carry the category and a
 * coarse location — never the raw secret.
 */
export function scanForSecrets(text: string, contextLabel: string): RedactionScanResult {
  const matches: RedactionMatch[] = [];
  const labels = new Map<string, string>();
  for (const rule of RULES) {
    // Reset lastIndex in case a global regex is reused across calls.
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(text)) !== null) {
      matches.push({
        pattern: rule.pattern,
        location: `${contextLabel} @ offset ${m.index} (${rule.pattern})`,
      });
      labels.set(rule.pattern, rule.label);
      if (m.index === rule.regex.lastIndex) rule.regex.lastIndex += 1; // zero-width guard
    }
  }
  return { matches, labels };
}

/**
 * Applies redact-and-continue: replaces every match with its category label.
 * `matched` is the raw text; the replacement is content-only.
 */
export function applyRedactions(
  text: string,
  contextLabel: string,
  labels?: Map<string, string>,
): string {
  let output = text;
  const { labels: discovered } = scanForSecrets(text, contextLabel);
  const effective = labels ?? discovered;
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    output = output.replace(rule.regex, (match) => {
      // Preserve the matched prefix for env-style rules so the assignment
      // stays readable; the credential value becomes the label.
      const label = effective.get(rule.pattern) ?? rule.label;
      const eq = match.match(/^([A-Za-z0-9_]+\s*[:=]\s*["']?)/);
      return eq?.[1] !== undefined ? `${eq[1]}${label}` : label;
    });
  }
  return output;
}

/** True when the report content can cross the boundary as-is. */
export function isClean(matches: RedactionMatch[]): boolean {
  return matches.length === 0;
}
