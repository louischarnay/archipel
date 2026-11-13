// permissions.network rules: `host`, `host:port`, or `http://host[:port]` for an internal service.
// Without a prefix: https only, and only to a public address.
const RULE = /^(http:\/\/)?([^:]+)(?::(\d+))?$/;

export interface NetworkRule {
  host: string;
  internal: boolean;
  port: number | null;
}

export function parseRule(rule: string): NetworkRule {
  const match = RULE.exec(rule);
  if (!match) throw new Error(`Invalid network rule: ${rule}`);
  const [, internal, host, port] = match;
  return { host: host!, internal: Boolean(internal), port: port ? Number(port) : null };
}

const matchesHost = (host: string, pattern: string): boolean =>
  pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;

export const isAllowed = (host: string, rules: readonly string[]): boolean =>
  rules.some((rule) => matchesHost(host, parseRule(rule).host));

// Rule that allows this exact URL: host, protocol and port. null if none.
export function ruleFor(url: URL, rules: readonly string[]): NetworkRule | null {
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  for (const rule of rules.map(parseRule)) {
    if (!matchesHost(url.hostname, rule.host)) continue;
    if (url.protocol === 'http:' && !rule.internal) continue;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (port === (rule.port ?? (url.protocol === 'https:' ? 443 : 80))) return rule;
  }
  return null;
}

export const browserSource = (rule: string): string => {
  const { host, internal, port } = parseRule(rule);
  return `${internal ? 'http' : 'https'}://${host}${port ? `:${port}` : ''}`;
};
