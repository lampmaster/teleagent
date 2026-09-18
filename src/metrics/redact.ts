interface Rule {
  pattern: RegExp;
  replacement: string;
}

const REDACTED = "[redacted]";

const RULES: Rule[] = [
  // NAME=value / NAME: value where NAME looks like a credential holder.
  {
    pattern:
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
    replacement: `$1=${REDACTED}`,
  },
  // Authorization headers, with or without a scheme.
  {
    pattern: /\b(authorization|proxy-authorization)\s*:\s*\S+(?:[ \t]+\S+)?/gi,
    replacement: `$1: ${REDACTED}`,
  },
  { pattern: /\b(bearer|basic)[ \t]+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED}` },
  // Telegram bot tokens: <digits>:<35 base64url chars>, also inside an API URL.
  { pattern: /\d{6,12}:[A-Za-z0-9_-]{30,}/g, replacement: REDACTED },
  // Common hosted-API key shapes.
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, replacement: REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replacement: REDACTED },
  // user:password@host inside URLs.
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replacement: `$1${REDACTED}@`,
  },
];

/**
 * Metrics rows and the dashboard show raw tool arguments and output previews,
 * so anything credential-shaped is masked before it is written.
 */
export function redact(text: string): string {
  let output = text;

  for (const { pattern, replacement } of RULES) {
    output = output.replace(pattern, replacement);
  }

  return output;
}

/** Redacts and caps a value so a single huge tool result cannot bloat the database. */
export function redactAndClip(text: string, maxChars: number): string {
  const redacted = redact(text);

  return redacted.length > maxChars
    ? `${redacted.slice(0, maxChars)}\n[… ${redacted.length - maxChars} more characters]`
    : redacted;
}
