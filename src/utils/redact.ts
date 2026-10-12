import type { ServerResult } from '../types.js';

/**
 * Whether the privacy redaction layer is enabled for this process.
 * It is deliberately opt-in so the upstream-compatible default is unchanged.
 */
export function isSecretRedactionEnabled(): boolean {
  const value = process.env.DESKTOP_COMMANDER_REDACT_SECRETS;
  return !!value && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

// These patterns intentionally target credential-shaped values rather than
// arbitrary long strings.  The generic assignment patterns cover .env files
// and JSON/config output; provider-specific patterns catch tokens that do not
// have a key name next to them.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\bAuthorization\s*:\s*Bearer\s+[^\s"'`<>]+/gi, 'Authorization: Bearer [REDACTED:bearer-token]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [REDACTED:bearer-token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, '[REDACTED:github-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-access-key]'],
  [/\b(?:xox[baprs]-)[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED:google-api-key]'],
  [/\b(?:npm|pypi)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:package-token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:jwt]'],
  [/(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp):\/\/[^\s"'<>]+/gi, '[REDACTED:connection-string]'],
  [/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd|pwd|token)\b\s*[:=]\s*)(["'`]?)([^\s,;}'"`]+)\2/gi, '$1[REDACTED:secret]'],
  [/("(?:apiKey|accessToken|refreshToken|authToken|clientSecret|secretKey|password|passwd|token)"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)(")/gi, '$1[REDACTED:secret]$3'],
  [/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|token)=)[^&\s]+/gi, '$1[REDACTED:secret]'],
];

export function redactText(value: string): string {
  if (!isSecretRedactionEnabled() || value.length === 0) return value;

  return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

/** Redact strings recursively while preserving the shape of tool arguments/results. */
export function redactValue<T>(value: T): T {
  if (!isSecretRedactionEnabled()) return value;
  return redactValueInternal(value, undefined) as T;
}

function redactValueInternal(value: unknown, key: string | undefined): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValueInternal(item, undefined));
  if (!value || typeof value !== 'object') return value;

  // Do not rewrite binary/image payloads.  Textual fields are handled below,
  // and keeping data buffers intact prevents corrupting previews.
  if (key === 'data') return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([entryKey, entryValue]) => [
      entryKey,
      redactValueInternal(entryValue, entryKey),
    ])
  );
}

/**
 * Redact the parts of an MCP result that can contain text.  Image data is
 * deliberately left byte-for-byte unchanged.
 */
export function redactServerResult(result: ServerResult): ServerResult {
  if (!isSecretRedactionEnabled()) return result;

  const content = Array.isArray(result.content)
    ? result.content.map((block: any) => {
        if (!block || typeof block !== 'object') return block;
        const copy = { ...block };
        if (typeof copy.text === 'string') copy.text = redactText(copy.text);
        if (copy.type === 'resource' && copy.resource && typeof copy.resource === 'object') {
          copy.resource = redactValue(copy.resource);
        }
        return copy;
      })
    : result.content;

  return {
    ...result,
    content,
    structuredContent: redactValue(result.structuredContent),
    _meta: redactValue(result._meta),
  };
}
