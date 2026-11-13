import { createInterface } from 'node:readline';
import { openApi, validate, writeTypes, type Client } from './client.js';
import { VERSION as version } from './version.js';

// MCP server over stdio: it reads the agent's folder and talks to the platform with its token.
// The protocol comes down to three methods here, hence no dependency on the SDK.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const PARSE_ERROR = -32700;

interface ToolArgs {
  dir: string;
  release: string;
  app: string;
  target: string;
  level?: string;
  reason?: string;
  timeout_seconds?: number;
  wait_seconds?: number;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: (keyof ToolArgs)[] };
  run(client: Client, args: ToolArgs): unknown;
}

interface RpcMessage {
  id?: string | number | null;
  method: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Partial<ToolArgs> };
}

const text = (description: string) => ({ type: 'string', description });
const dir = text("Absolute path of the app's folder");
const release = text('Version id (rel…)');
const app = text('App id');

const schema = (
  properties: Tool['inputSchema']['properties'],
  required: Tool['inputSchema']['required'],
): Tool['inputSchema'] => ({
  type: 'object',
  properties,
  required,
});

const TOOLS: Tool[] = [
  {
    name: 'validate',
    description: 'Validates app.manifest.yaml locally, without a server. Rules involving other apps are checked at deployment.',
    inputSchema: schema({ dir }, ['dir']),
    run: (client, args) => validate(args.dir),
  },
  {
    name: 'generate_types',
    description: 'Writes the TS types of tables: to app.types.d.ts, without a server. Run again when the manifest changes.',
    inputSchema: schema({ dir }, ['dir']),
    run: (client, args) => writeTypes(args.dir),
  },
  {
    name: 'app_openapi',
    description: "The app's OpenAPI contract, computed from the manifest, without a server: generated CRUD and controllers.",
    inputSchema: schema({ dir }, ['dir']),
    run: (client, args) => openApi(args.dir),
  },
  {
    name: 'deploy_preview',
    description:
      'Packs the folder, submits it and waits for the pipeline to finish. Returns the full report. The version runs in preview on empty tables; nothing goes live without a human decision.',
    inputSchema: schema({ dir, timeout_seconds: { type: 'number', description: 'Maximum wait for the pipeline' } }, ['dir']),
    run: (client, args) => client.deploy(args.dir, { timeoutSeconds: args.timeout_seconds }),
  },
  {
    name: 'get_report',
    description: "A version's report: status, stages, tests, logs and the reviewer's decision_comment.",
    inputSchema: schema({ release }, ['release']),
    run: (client, args) => client.report(args.release),
  },
  {
    name: 'logs',
    description: "A version's logs, or those of the latest version submitted for an app.",
    inputSchema: schema({ target: text('Version (rel…) or app'), level: { type: 'string', enum: ['info', 'warn', 'error'] } }, [
      'target',
    ]),
    run: (client, args) => client.logs(args.target, { level: args.level }),
  },
  {
    name: 'db_schema',
    description: 'Schema applied in the database for an app, and available shared.* tables.',
    inputSchema: schema({ app }, ['app']),
    run: (client, args) => client.schema(args.app),
  },
  {
    name: 'promote',
    description:
      'Reports or waits for the human decision on a version, without ever taking it: approval happens in Review. Returns promoted, awaiting_human and decision_comment.',
    inputSchema: schema(
      { release, wait_seconds: { type: 'number', description: 'How long to wait for the decision, 0 by default' } },
      ['release'],
    ),
    run: (client, args) => client.promote(args.release, { waitSeconds: args.wait_seconds }),
  },
  {
    name: 'rollback',
    description:
      'Asks a person to put an already approved version back online. The request is shown to the admin; nothing changes until that person acts.',
    inputSchema: schema(
      { app, release: text('Target version, the latest approved one by default'), reason: text('Reason shown to the admin') },
      ['app'],
    ),
    run: (client, args) => client.rollback(args.app, { releaseId: args.release, reason: args.reason }),
  },
];

const listed = TOOLS.map(({ run, ...tool }) => tool);

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function callTool(client: Client, { name, arguments: args = {} }: NonNullable<RpcMessage['params']> = {}) {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
  const asResult = (value: unknown, isError: boolean) => ({
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    isError,
  });
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined);
  if (missing.length) return asResult({ error: `Missing parameter: ${missing.join(', ')}` }, true);
  try {
    return asResult(await tool.run(client, args as ToolArgs), false);
  } catch (error) {
    return asResult({ error: (error as Error).message }, true);
  }
}

function handle(client: Client, { method, params }: RpcMessage) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion:
          params?.protocolVersion && PROTOCOL_VERSIONS.includes(params.protocolVersion)
            ? params.protocolVersion
            : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'archipel', version },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listed };
    case 'tools/call':
      return callTool(client, params);
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

export function serveMcp(client: Client, { input = process.stdin, output = process.stdout } = {}) {
  const send = (message: object) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

  // No await: a waiting promote must not block the other messages.
  const receive = async (line: string) => {
    if (!line.trim()) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return send({ id: null, error: { code: PARSE_ERROR, message: 'Unreadable JSON' } });
    }
    if (message.id === undefined) return; // notification
    try {
      send({ id: message.id, result: await handle(client, message) });
    } catch (failure) {
      const error = failure as Error & { code?: number };
      send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
    }
  };

  createInterface({ input }).on('line', receive);
}
