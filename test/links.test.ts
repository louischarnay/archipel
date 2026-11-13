import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { BlockList } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fetchLinkIcon, iconCandidates, iconType } from '../packages/server/src/links/link-icon.js';
import { startPlatform } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');
const ICO = Buffer.from('00000100010010100000', 'hex');
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');

// The tests serve from the machine, which the default policy rightly refuses.
const open = { policy: { forbidden: new BlockList(), private: new BlockList() } };

interface Site {
  url: string;
  close: () => void;
}

function serve(routes: Record<string, { body?: string | Buffer; type?: string; redirect?: string }>) {
  const server = createServer((request, response) => {
    const route = routes[request.url ?? ''];
    if (!route) return response.writeHead(404).end();
    if (route.redirect) return response.writeHead(302, { location: route.redirect }).end();
    response.writeHead(200, { 'content-type': route.type ?? 'text/html' }).end(route.body);
  });
  return new Promise<Site>((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }),
    );
  });
}

describe('External link logos', () => {
  test('the type comes from the bytes, not from what the site announces', () => {
    assert.equal(iconType(PNG), 'image/png');
    assert.equal(iconType(ICO), 'image/x-icon');
    assert.equal(iconType(SVG), 'image/svg+xml');
    assert.equal(iconType(Buffer.from('GIF89a')), 'image/gif');
    assert.equal(iconType(Buffer.from('<!doctype html><html></html>')), null);
    assert.equal(iconType(Buffer.from('<html><svg></svg></html>')), null);
  });

  test('announced icons go from largest to smallest, then /favicon.ico', () => {
    const html = `<head>
      <link rel="icon" sizes="16x16" href="/small.png">
      <link href='/big.png?a=1&amp;b=2' rel='shortcut icon' sizes='192x192'>
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel="stylesheet" href="/style.css">
      <link rel="icon" href="data:image/png;base64,AAAA">
    </head>`;
    assert.deepEqual(iconCandidates(html, 'https://example.com/docs/'), [
      'https://example.com/big.png?a=1&b=2',
      'https://example.com/touch.png',
      'https://example.com/small.png',
      'https://example.com/favicon.ico',
    ]);
  });

  test('takes the logo announced by the page, following its redirects', async () => {
    const site = await serve({
      '/': { redirect: '/home' },
      '/home': { body: '<link rel="icon" href="logo.png">' },
      '/logo.png': { type: 'image/png', body: PNG },
    });
    try {
      assert.deepEqual(await fetchLinkIcon(new URL(site.url), open), { bytes: PNG, type: 'image/png' });
    } finally {
      site.close();
    }
  });

  test('falls back to /favicon.ico if the announced icon is not an image', async () => {
    const site = await serve({
      '/': { body: '<link rel="icon" href="/fake.png">' },
      '/fake.png': { body: '<html>Not found</html>' },
      '/favicon.ico': { type: 'image/x-icon', body: ICO },
    });
    try {
      assert.equal((await fetchLinkIcon(new URL(site.url), open)).type, 'image/x-icon');
    } finally {
      site.close();
    }
  });

  test('a page cannot send the server to another plain-text target', async () => {
    const other = await serve({ '/logo.png': { type: 'image/png', body: PNG } });
    const site = await serve({
      '/': { body: `<link rel="icon" href="${other.url.replace('127.0.0.1', 'localhost')}/logo.png">` },
    });
    try {
      assert.equal(await fetchLinkIcon(new URL(site.url), open), null);
    } finally {
      site.close();
      other.close();
    }
  });

  test('the machine itself stays refused, even for a chosen host', async () => {
    const site = await serve({ '/favicon.ico': { type: 'image/x-icon', body: ICO } });
    try {
      assert.equal(await fetchLinkIcon(new URL(site.url)), null);
    } finally {
      site.close();
    }
  });
});

describe('External links API', () => {
  let platform;
  before(async () => {
    platform = await startPlatform();
  });
  after(() => platform.stop());

  test('a link appears on the launchpad and is removed', async () => {
    const { api } = platform;
    const created = await api.post('/api/links', { name: '  Docs  ', url: 'http://127.0.0.1:1/guide?cle=privee' });
    assert.equal(created.statusCode, 201);
    const link = created.json();
    assert.match(link.id, /^lnk[0-9a-f]{12}$/);
    assert.equal(link.name, 'Docs');
    assert.equal(link.hasIcon, false);

    const { links } = (await api.get('/api/launchpad')).json();
    assert.deepEqual(links, [link]);
    assert.equal((await api.get(`/api/links/${link.id}/icon`)).statusCode, 404);

    const [audit] = await platform.db('platform_audit').where({ action: 'link.create' });
    assert.deepEqual(JSON.parse(audit.detail), { id: link.id, name: 'Docs', host: '127.0.0.1:1' });

    assert.equal((await api.delete(`/api/links/${link.id}`)).statusCode, 200);
    assert.equal((await api.delete(`/api/links/${link.id}`)).statusCode, 404);
    assert.deepEqual((await api.get('/api/launchpad')).json().links, []);
  });

  test('refuses a dangerous address, an empty name or an unknown group', async () => {
    const { api } = platform;
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'https://me:secret@example.com',
      'not an address',
    ]) {
      assert.equal((await api.post('/api/links', { name: 'X', url })).statusCode, 400, url);
    }
    assert.equal((await api.post('/api/links', { name: '   ', url: 'https://example.com' })).statusCode, 400);
    assert.equal((await api.post('/api/links', { name: 'X', url: 'http://127.0.0.1:1/', group: 'unknown' })).statusCode, 400);
    assert.deepEqual((await api.get('/api/launchpad')).json().links, []);
  });

  test('the logo is served with its real type, under a CSP that neutralises an SVG', async () => {
    const id = 'lnk000000000001';
    await platform.store.addLink(
      { id, name: 'Logo', url: 'https://example.com/', group_id: null, hasIcon: true },
      { bytes: SVG, type: 'image/svg+xml' },
      'test',
    );
    const response = await platform.api.get(`/api/links/${id}/icon`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/svg+xml');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-security-policy'], /^sandbox/);
    assert.deepEqual(response.rawPayload, SVG);
  });

  test('an agent token can neither add nor remove a link', async () => {
    const { token } = (await platform.api.post('/api/agent-tokens', { name: 'ci', days: 1 })).json();
    const headers = { authorization: `Bearer ${token}` };
    const add = await platform.app.inject({
      method: 'POST',
      url: '/api/links',
      headers,
      payload: { name: 'X', url: 'https://example.com' },
    });
    const remove = await platform.app.inject({ method: 'DELETE', url: '/api/links/lnk000000000001', headers });
    assert.equal(add.statusCode, 403);
    assert.equal(remove.statusCode, 403);
  });
});
