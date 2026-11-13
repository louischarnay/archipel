import type { McpTool } from '@archipel/manifest-schema';

export type Input = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CHECKS: Record<string, (value: unknown) => boolean> = {
  uuid: (value) => typeof value === 'string' && UUID.test(value),
  string: (value) => typeof value === 'string' && value.length > 0,
  integer: Number.isInteger,
  number: Number.isFinite,
  boolean: (value) => typeof value === 'boolean',
};

const parseCall = (calls: string) => {
  const [method = '', path = ''] = calls.split(' ');
  return { method, path };
};

// `input` gives each field's type. An undeclared route parameter stays a string: the call needs it.
export function fieldsOf(tool: McpTool) {
  const { path } = parseCall(tool.calls);
  const fields = new Map<string, string>();
  for (const segment of path.split('/')) {
    if (segment.startsWith(':')) fields.set(segment.slice(1), 'string');
  }
  for (const [name, declared] of Object.entries<unknown>(tool.input ?? {})) {
    const type = typeof declared === 'object' ? (declared as { type?: string } | null)?.type : declared;
    fields.set(name, typeof type === 'string' && CHECKS[type] ? type : 'string');
  }
  return [...fields].map(([name, type]) => ({ name, type }));
}

// Returns what is wrong with the input, or null.
export function checkInput(tool: McpTool, input: Input) {
  const fields = fieldsOf(tool);
  const known = new Set(fields.map((field) => field.name));
  const unknown = Object.keys(input).find((name) => !known.has(name));
  if (unknown) return `Unknown field: ${unknown}`;
  const invalid = fields.find((field) => !CHECKS[field.type]!(input[field.name]));
  return invalid ? `Field ${invalid.name}: ${invalid.type} expected` : null;
}

// The app request a tool stands for: route parameters go in the path, the rest in the query or the body.
export function toRequest(tool: McpTool, input: Input) {
  const { method, path } = parseCall(tool.calls);
  const fromPath = new Set<string>();
  const resolved = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      fromPath.add(segment.slice(1));
      return encodeURIComponent(input[segment.slice(1)] as string);
    })
    .join('/');
  const rest = Object.fromEntries(Object.entries(input).filter(([name]) => !fromPath.has(name)));
  return method === 'GET'
    ? { method, path: resolved, query: Object.fromEntries(Object.entries(rest).map(([name, value]) => [name, String(value)])) }
    : { method, path: resolved, body: rest };
}
