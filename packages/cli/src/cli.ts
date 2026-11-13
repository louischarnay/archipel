#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { AgentError, createClient, EXIT, openApi, validate, writeTypes, type Client } from './client.js';
import { connectionFile, forgetConnection, resolveConnection, saveConnection } from './connection.js';
import { serveMcp } from './mcp.js';

const USAGE = `Usage: archipel <command>

  login <address>                            Saves the connection; the token is read from the keyboard or stdin
  whoami                                     Token in use, allowed apps and where the connection comes from
  logout                                     Forgets the saved connection
  validate [folder]                          Validates the manifest, without a server
  types [folder] [--out app.types.d.ts]      Generates the TS types of tables:, without a server
  openapi [folder]                           The app's OpenAPI contract, without a server
  deploy [folder] --preview [--timeout 300]  Submits the app and returns the pipeline report
  report <version>                           A version's report, with decision_comment
  logs <version|app> [--level error]         A version's logs
  db:schema <app>                            Applied schema and available shared tables
  promote <version> [--wait 600]             Reports or waits for the human decision, without taking it
  rollback <app> [--to <version>] [--reason <text>]
                                             Asks a person to roll back a version
  mcp                                        MCP server over stdio

The connection comes from login, or from ARCHIPEL_URL and ARCHIPEL_TOKEN, which take precedence.
validate, types and openapi do not need it.
Output: JSON on stdout. Codes: 0 success, 1 failure, 2 usage or connection error, 3 human decision pending.`;

const OPTIONS = {
  preview: { type: 'boolean' },
  timeout: { type: 'string' },
  wait: { type: 'string' },
  level: { type: 'string' },
  to: { type: 'string' },
  reason: { type: 'string' },
  out: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Options = ReturnType<typeof parseArgs<{ allowPositionals: true; options: typeof OPTIONS }>>['values'];
type Command = (args: string[], options: Options, client: Client) => Promise<[unknown, number]>;

function seconds(value: string | undefined): number | undefined;
function seconds(value: string | undefined, fallback: number): number;
function seconds(value: string | undefined, fallback?: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!(parsed >= 0)) throw new AgentError(`Invalid duration: ${value}`);
  return parsed;
}

const required = (value: string | undefined, label: string) => {
  if (!value) throw new AgentError(`${label} required.\n\n${USAGE}`);
  return value;
};

// Pasted at the keyboard, the token is not displayed and does not stay in the shell history.
function readHidden(label: string) {
  const { stdin, stderr } = process;
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = () => {
      stdin.off('data', receive);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
    };
    const receive = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0003') {
          finish();
          if (char === '\u0003') reject(new AgentError('Login cancelled.'));
          else resolve(value.trim());
          return;
        }
        value = char === '\u007f' || char === '\b' ? value.slice(0, -1) : value + char;
      }
    };
    stderr.write(label);
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', receive);
  });
}

async function readToken() {
  if (process.env.ARCHIPEL_TOKEN) return process.env.ARCHIPEL_TOKEN;
  if (process.stdin.isTTY) return readHidden('Agent token (Settings > Agents): ');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

function platformUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentError(`Invalid address: ${value}. Example: archipel login https://apps.example.com`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new AgentError(`An http or https address is expected: ${value}`);
  return url.origin;
}

// Each command returns its result and the matching exit code.
const COMMANDS: Record<string, Command> = {
  validate: async ([dir = '.']) => {
    const result = validate(dir);
    return [result, result.valid ? EXIT.ok : EXIT.failed];
  },
  types: async ([dir = '.'], options) => {
    const result = writeTypes(dir, options.out);
    return [result, result.written ? EXIT.ok : EXIT.failed];
  },
  openapi: async ([dir = '.']) => {
    const result = openApi(dir);
    return [result, 'validation' in result ? EXIT.failed : EXIT.ok];
  },
  deploy: async ([dir = '.'], options, client) => {
    const result = await client.deploy(dir, { timeoutSeconds: seconds(options.timeout) });
    return [result, 'previewUrl' in result && result.status === 'in_review' ? EXIT.ok : EXIT.failed];
  },
  report: async ([id], options, client) => [await client.report(required(id, 'Version id')), EXIT.ok],
  logs: async ([target], options, client) => [
    await client.logs(required(target, 'Version or app'), { level: options.level }),
    EXIT.ok,
  ],
  'db:schema': async ([app], options, client) => [await client.schema(required(app, 'App')), EXIT.ok],
  promote: async ([id], options, client) => {
    const result = await client.promote(required(id, 'Version id'), { waitSeconds: seconds(options.wait, 0) });
    if (result.promoted) return [result, EXIT.ok];
    return [result, result.awaiting_human || result.status === 'processing' ? EXIT.awaitingHuman : EXIT.failed];
  },
  rollback: async ([app], options, client) => [
    await client.rollback(required(app, 'App'), { releaseId: options.to, reason: options.reason }),
    EXIT.awaitingHuman,
  ],
};

// No client beforehand: these commands create, read or remove the connection itself.
const CONNECTION_COMMANDS: Record<string, (args: string[]) => Promise<[unknown, number]>> = {
  login: async ([address]) => {
    const url = platformUrl(required(address, 'Platform address'));
    const token = await readToken();
    if (!token) throw new AgentError('Empty token: copy it from Settings > Agents, where it is shown only once.');
    // Checked before being saved: a wrong or revoked token does not replace a working connection.
    const agent = await createClient({ url, token }).me();
    const file = saveConnection({ url, token });
    return [
      {
        connected: true,
        url,
        agent: agent.name,
        apps: agent.apps ?? 'all',
        file,
        next: 'Connection saved. In Claude Code, ask for example "Create an Archipel app to track my expenses".',
      },
      EXIT.ok,
    ];
  },
  whoami: async () => {
    const connection = resolveConnection();
    const agent = await createClient(connection).me();
    const source = connection.source === 'env' ? 'ARCHIPEL_URL and ARCHIPEL_TOKEN' : connectionFile();
    return [{ url: connection.url, agent: agent.name, apps: agent.apps ?? 'all', source }, EXIT.ok];
  },
  logout: async () => [{ connected: false, removed: forgetConnection() }, EXIT.ok],
};

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: OPTIONS });
  const [name, ...args] = positionals;
  if (name === 'mcp') return serveMcp(createClient());
  const connectionCommand = name && !values.help ? CONNECTION_COMMANDS[name] : undefined;
  if (connectionCommand) {
    const [result, code] = await connectionCommand(args);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = code;
    return;
  }
  const command = name ? COMMANDS[name] : undefined;
  if (values.help || !command) {
    console.log(USAGE);
    process.exitCode = values.help ? EXIT.ok : EXIT.error;
    return;
  }
  const [result, code] = await command(args, values, createClient());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = code;
}

main().catch((error) => {
  console.log(JSON.stringify({ error: error.message }, null, 2));
  process.exitCode = EXIT.error;
});
