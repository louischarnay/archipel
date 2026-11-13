// Runs in the sandbox, without network or access to the host: everything goes through the protocol on stdin and stdout.
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const pending = new Map();
let nextCall = 0;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const postLog = (level, parts) =>
  send({ type: 'log', level, message: parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ') });

console.log = console.info = (...parts) => postLog('info', parts);
console.warn = (...parts) => postLog('warn', parts);
console.error = (...parts) => postLog('error', parts);

function callHost(method, args) {
  const id = ++nextCall;
  return new Promise((done, fail) => {
    pending.set(id, { done, fail });
    send({ type: 'host', id, method, args });
  });
}

class ControllerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function bodyOf(input, init) {
  const body = init?.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : null);
  if (body === null || body === undefined) return null;
  const bytes = await new Response(body).arrayBuffer();
  return Buffer.from(bytes).toString('base64');
}

// There is no network here: `fetch` asks the host, which applies permissions.network.
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = request ? request.url : String(input);
  const headers = Object.fromEntries(new Headers(init?.headers ?? request?.headers).entries());
  const answer = await callHost('fetch', [{
    url,
    method: init?.method ?? request?.method ?? 'GET',
    headers,
    body: await bodyOf(input, init),
  }]);
  const empty = [101, 204, 205, 304].includes(answer.status);
  const response = new Response(empty ? null : Buffer.from(answer.body, 'base64'), {
    status: answer.status,
    statusText: answer.statusText,
    headers: answer.headers,
  });
  Object.defineProperties(response, { url: { value: answer.url }, redirected: { value: answer.redirected } });
  return response;
};
delete globalThis.WebSocket;
delete globalThis.EventSource;

const tableClient = (table) => ({
  list: (options) => callHost('list', [table, options]),
  get: (id) => callHost('get', [table, id]),
  insert: (row) => callHost('insert', [table, row]),
  update: (id, patch) => callHost('update', [table, id, patch]),
  remove: (id) => callHost('remove', [table, id]),
});

function buildContext({ params, query, body, user }) {
  return {
    params,
    query,
    body,
    user,
    db: { table: tableClient },
    fetch: globalThis.fetch,
    log: {
      info: (...parts) => postLog('info', parts),
      warn: (...parts) => postLog('warn', parts),
      error: (...parts) => postLog('error', parts),
    },
    error: (status, message) => new ControllerError(status, message),
  };
}

async function loadHandler(relative) {
  const file = resolve(root, relative);
  if (!file.startsWith(root + sep)) throw new Error(`Controller outside the app: ${relative}`);
  const module = await import(pathToFileURL(file).href);
  if (typeof module.default !== 'function') {
    throw new Error(`${relative} must export a default function`);
  }
  return module.default;
}

async function invoke({ id, handler, request }) {
  try {
    const run = await loadHandler(handler);
    const value = await run(buildContext(request));
    send({ type: 'result', id, value: value ?? null });
  } catch (error) {
    send({ type: 'result', id, error: { status: error.status, message: error.message, stack: error.status ? undefined : error.stack } });
  }
}

function receive(line) {
  const message = JSON.parse(line);
  if (message.type === 'invoke') {
    invoke(message);
  } else if (message.type === 'host-result') {
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call.fail(new ControllerError(message.error.status ?? 500, message.error.message));
    else call.done(message.value);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    receive(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
  }
});
// The host is gone: nothing must outlive it.
process.stdin.on('end', () => process.exit(0));
