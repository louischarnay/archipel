import type { NetworkRule } from '@archipel/manifest-schema';
import { logoType } from '../config/instance.js';
import { createEgress, type EgressOptions } from '../runtime/sandbox/egress.js';

const MAX_ICON_BYTES = 512 * 1024;
const MAX_CANDIDATES = 4;
const DEADLINE_MS = 8000;
const LIMITS = { controllerTimeoutMs: 4000, fetchBytes: 3 * 1024 * 1024 };
const HEADERS = { 'user-agent': 'Archipel', accept: 'text/html,image/*;q=0.9,*/*;q=0.8' };

const LINK_TAG = /<link\b[^>]*>/gi;
const ATTRIBUTE = /\b(rel|href|sizes|type)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SVG_START = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype[^>]*>\s*)?<svg[\s>]/i;

// SVG is accepted here: it is only served with a `sandbox` CSP, like app icons.
export function iconType(bytes: Buffer) {
  const known = logoType(bytes);
  if (known) return known;
  if (bytes.subarray(0, 4).toString('hex') === '00000100') return 'image/x-icon';
  if (bytes.subarray(0, 4).toString() === 'GIF8') return 'image/gif';
  return SVG_START.test(bytes.toString('utf8', 0, 4096)) ? 'image/svg+xml' : null;
}

function iconSize(attributes: Map<string, string>, apple: boolean) {
  const declared = Number.parseInt(attributes.get('sizes') ?? '', 10);
  if (declared) return declared;
  if (apple) return 180;
  return /svg/i.test(attributes.get('type') ?? attributes.get('href') ?? '') ? 150 : 16;
}

// The icons announced by the page, from largest to smallest, then `/favicon.ico`.
export function iconCandidates(html: string, page: string) {
  const found: { href: string; size: number }[] = [];
  for (const tag of html.match(LINK_TAG) ?? []) {
    const attributes = new Map(
      [...tag.matchAll(ATTRIBUTE)].map(([, name, double, single, bare]) => [name!.toLowerCase(), double ?? single ?? bare ?? '']),
    );
    const rel = attributes.get('rel')?.toLowerCase().split(/\s+/) ?? [];
    const apple = rel.some((token) => token.startsWith('apple-touch-icon'));
    const href = attributes.get('href')?.replaceAll('&amp;', '&');
    if (href && (apple || rel.includes('icon'))) found.push({ href, size: iconSize(attributes, apple) });
  }
  const urls = found
    .sort((a, b) => b.size - a.size)
    .flatMap(({ href }) => {
      try {
        const url = new URL(href, page);
        return ['http:', 'https:'].includes(url.protocol) ? [url.href] : [];
      } catch {
        return [];
      }
    });
  return [...new Set(urls)].slice(0, MAX_CANDIDATES - 1).concat(new URL('/favicon.ico', page).href);
}

// The logo an external link announces. Any failure means no logo: the launchpad shows the initial.
export async function fetchLinkIcon(link: URL, options: Pick<EgressOptions, 'lookup' | 'policy'> = {}) {
  // The host chosen by the administrator may be an internal service. The page it serves does not choose another
  // private target: elsewhere, public https only. The machine and metadata stay refused everywhere.
  const ruleOf = (url: URL): NetworkRule | null => {
    if (url.hostname === link.hostname) return { host: url.hostname, internal: true, port: null };
    return url.protocol === 'https:' && !url.port ? { host: url.hostname, internal: false, port: null } : null;
  };
  const egress = createEgress({ ruleOf, limits: LIMITS, ...options });
  const get = (url: string) => egress({ url, headers: HEADERS });

  const search = async () => {
    const page = await get(link.href).catch(() => null);
    const html = /html/i.test(String(page?.headers['content-type'])) ? Buffer.from(page!.body, 'base64').toString('utf8') : '';
    for (const url of iconCandidates(html, page?.url ?? link.href)) {
      const response = await get(url).catch(() => null);
      if (response?.status !== 200) continue;
      const bytes = Buffer.from(response.body, 'base64');
      const type = iconType(bytes);
      if (type && bytes.length <= MAX_ICON_BYTES) return { bytes, type };
    }
    return null;
  };

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DEADLINE_MS);
  });
  try {
    return await Promise.race([search(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
