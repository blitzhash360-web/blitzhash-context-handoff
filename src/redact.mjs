// Patterns for values that must never land in HANDOFF.md or an agent rules file.
export const SECRET_PATTERNS = [
  ['JWT / Supabase key', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g],
  ['Stripe key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{16,}/g],
  ['GitHub token', /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['OpenAI / Anthropic key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['URL with password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi],
];

export function redact(text) {
  let out = String(text);
  for (const [, re] of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

export function findSecrets(text) {
  const hits = [];
  for (const [label, re] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(String(text))) hits.push(label);
    re.lastIndex = 0;
  }
  return hits;
}
