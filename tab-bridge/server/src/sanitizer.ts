// Tab Bridge Privacy & Redaction Shield
// Strips local file system paths, usernames, IP addresses, and sensitive secrets
// before any prompt reaches the browser AI.

export interface SanitizationResult {
  cleanText: string;
  redactedCount: number;
  redactionsSummary: string[];
}

export class PrivacyShield {
  // Common secret regex patterns (API keys, bearer tokens, private keys)
  private static SECRET_PATTERNS = [
    { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9_-]{20,}/g },
    { name: 'Generic API Key/Secret', regex: /(?:api[_-]?key|secret|token|password|auth|bearer)\s*[:=]\s*["']?([a-zA-Z0-9_\-\.]{12,})["']?/gi },
    { name: 'Private Key Block', regex: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g },
    { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g },
    { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  ];

  // IP Address patterns (IPv4 and internal subnets)
  private static IP_PATTERN = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;

  // Windows & Unix File Path patterns
  // Examples: C:\Users\jack0\Projects\app\index.ts -> [WORKSPACE]/app/index.ts
  private static WINDOWS_USER_PATH_PATTERN = /[a-zA-Z]:\\Users\\[^\\]+\\([^\s"'\n\r]+)/gi;
  private static UNIX_USER_PATH_PATTERN = /\/(?:home|Users)\/[^\/]+\/([^\s"'\n\r]+)/gi;
  private static GENERIC_DRIVE_PATH = /[a-zA-Z]:\\[^\s"'\n\r]+\\([a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+)/gi;

  /**
   * Sanitizes input text, removing personal paths, IP addresses, and secrets.
   */
  public static sanitize(text: string, customUsername?: string): SanitizationResult {
    let clean = text;
    const redactionsSummary: string[] = [];
    let redactedCount = 0;

    // 1. Redact Secrets & API Keys
    for (const pattern of this.SECRET_PATTERNS) {
      if (pattern.regex.test(clean)) {
        clean = clean.replace(pattern.regex, (match) => {
          redactedCount++;
          return `[REDACTED_${pattern.name.toUpperCase().replace(/\s+/g, '_')}]`;
        });
        redactionsSummary.push(pattern.name);
      }
    }

    // 2. Redact IP addresses (except 127.0.0.1 if specifically needed, but safer to mask)
    if (this.IP_PATTERN.test(clean)) {
      clean = clean.replace(this.IP_PATTERN, (ip) => {
        // Keep 0.0.0.0 or 127.0.0.1 generic notation if it's localhost
        if (ip === '127.0.0.1' || ip === '0.0.0.0') return '[LOCALHOST]';
        redactedCount++;
        return '[IP_REDACTED]';
      });
      redactionsSummary.push('IP Addresses');
    }

    // 3. Redact Specific Username if detected or provided
    const userEnv = customUsername || process.env.USERNAME || process.env.USER;
    if (userEnv && userEnv.length > 2) {
      const userRegex = new RegExp(`\\b${escapeRegExp(userEnv)}\\b`, 'gi');
      if (userRegex.test(clean)) {
        clean = clean.replace(userRegex, '[USER]');
        redactedCount++;
        redactionsSummary.push('Local Username');
      }
    }

    // 4. Redact Absolute Windows Paths -> Normalized Relative Project Paths
    clean = clean.replace(this.WINDOWS_USER_PATH_PATTERN, (_match, relativePath) => {
      redactedCount++;
      return `[PROJECT]/${relativePath.replace(/\\/g, '/')}`;
    });

    // 5. Redact Absolute Unix Paths
    clean = clean.replace(this.UNIX_USER_PATH_PATTERN, (_match, relativePath) => {
      redactedCount++;
      return `[PROJECT]/${relativePath}`;
    });

    return {
      cleanText: clean,
      redactedCount,
      redactionsSummary: Array.from(new Set(redactionsSummary)),
    };
  }
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
