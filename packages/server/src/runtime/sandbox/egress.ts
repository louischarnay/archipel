import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { ruleFor, type NetworkRule } from '@archipel/manifest-schema';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../../types.js';

type Lookup = (
  host: string,
  options: LookupAllOptions,
  done: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

interface Policy {
  forbidden: BlockList;
  private: BlockList;
}

export interface EgressOptions {
  network?: string[];
  ruleOf?: (url: URL) => NetworkRule | null;
  limits: Pick<Config['limits'], 'controllerTimeoutMs' | 'fetchBytes'>;
  lookup?: Lookup;
  policy?: Policy;
}

interface HopRequest {
  method: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
}

export interface FetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
]);

function subnets(list: string[]) {
  const blocked = new BlockList();
  for (const entry of list) {
    const [network = '', prefix] = entry.split('/');
    blocked.addSubnet(network, Number(prefix), network.includes(':') ? 'ipv6' : 'ipv4');
  }
  return blocked;
}

// Never reachable, even by an `http://` rule: the machine itself and metadata services.
const FORBIDDEN = subnets([
  '0.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  'fe80::/10',
  'ff00::/8',
]);
const PRIVATE = subnets([
  '10.0.0.0/8',
  '100.64.0.0/10',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  'fc00::/7',
]);

const family = (address: string) => (isIP(address) === 6 ? 'ipv6' : 'ipv4');

function checkAddress(address: string, rule: NetworkRule, policy: Policy) {
  if (policy.forbidden.check(address, family(address))) return `forbidden address (${address})`;
  if (!rule.internal && policy.private.check(address, family(address))) return `private address (${address})`;
  return null;
}

export class EgressError extends Error {}

type LookupOptions = { all?: boolean };
type LookupDone = (error: Error | null, address: string | LookupAddress[], family?: number) => void;

// Controllers have no network: their `fetch` runs here, under these rules.
// The check happens at connection time, on the address actually used, which rules out DNS rebinding.
export function createEgress({
  network = [],
  ruleOf = (url) => ruleFor(url, network),
  limits,
  lookup = dnsLookup as Lookup,
  policy = { forbidden: FORBIDDEN, private: PRIVATE },
}: EgressOptions) {
  const authorize = (url: URL) => {
    const rule = ruleOf(url);
    if (!rule) throw new EgressError(`Network refused: ${url.protocol}//${url.host} is not in permissions.network`);
    if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
      const problem = checkAddress(url.hostname.replace(/^\[|\]$/g, ''), rule, policy);
      if (problem) throw new EgressError(`Network refused: ${problem}`);
    }
    return rule;
  };

  const guardedLookup = (rule: NetworkRule) => (host: string, options: LookupOptions, done: LookupDone) => {
    lookup(host, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) return done(error, '');
      const problem = addresses.map(({ address }) => checkAddress(address, rule, policy)).find(Boolean);
      if (problem) return done(new EgressError(`Network refused: ${problem}`), '');
      if (options.all) return done(null, addresses);
      return done(null, addresses[0]!.address, addresses[0]!.family);
    });
  };

  const once = (url: URL, rule: NetworkRule, { method, headers, body }: HopRequest) =>
    new Promise<{ response: IncomingMessage; bytes: Buffer }>((resolve, reject) => {
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = send(
        url,
        { method, headers, lookup: guardedLookup(rule), timeout: limits.controllerTimeoutMs },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limits.fetchBytes) {
              response.destroy();
              reject(new EgressError(`Response too large (limit ${limits.fetchBytes} bytes)`));
            } else {
              chunks.push(chunk);
            }
          });
          response.on('error', reject);
          response.on('end', () => resolve({ response, bytes: Buffer.concat(chunks) }));
        },
      );
      request.on('timeout', () => request.destroy(new EgressError('Timeout exceeded for the network request')));
      request.on('error', reject);
      request.end(body);
    });

  return async function egressFetch({ url: target, method = 'GET', headers = {}, body = null }: FetchRequest) {
    const clean = Object.fromEntries(
      Object.entries(headers).filter(([name]) => !DROPPED_REQUEST_HEADERS.has(name.toLowerCase())),
    );
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new EgressError('Invalid URL');
    }
    const payload = body === null ? undefined : Buffer.from(body, 'base64');
    let request: HopRequest = { method: method.toUpperCase(), headers: clean, body: payload };

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const rule = authorize(url);
      const { response, bytes } = await once(url, rule, request);
      const location = response.headers.location;
      const statusCode = response.statusCode!;
      if (!REDIRECTS.has(statusCode) || !location) {
        return {
          url: url.href,
          status: statusCode,
          statusText: response.statusMessage,
          headers: Object.fromEntries(Object.entries(response.headers).filter(([, value]) => typeof value === 'string')),
          body: bytes.toString('base64'),
          redirected: hop > 0,
        };
      }
      const next = new URL(location, url);
      // Credentials do not follow a redirect to another host.
      if (next.host !== url.host) {
        request = {
          ...request,
          headers: Object.fromEntries(
            Object.entries(request.headers).filter(([name]) => !['authorization', 'cookie'].includes(name.toLowerCase())),
          ),
        };
      }
      if (statusCode === 303 || ([301, 302].includes(statusCode) && request.method === 'POST')) {
        request = { ...request, method: 'GET', body: undefined };
      }
      url = next;
    }
    throw new EgressError(`Too many redirects (limit ${MAX_REDIRECTS})`);
  };
}
