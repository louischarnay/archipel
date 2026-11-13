import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// Minimal OIDC provider: authorization code flow, which is what Pocket ID, Keycloak and the others do.
export async function startIdp() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, string | null>();
  // What the tests set (groups, audience, auth time, logout) and read back (last authorization, client secret).
  const state: {
    groups: string[];
    audience: string;
    endSession?: boolean;
    authTime?: number;
    authorize?: URLSearchParams;
    clientSecret?: string | null;
  } = { groups: ['archipel-admin', 'helpdesk'], audience: 'archipel' };
  let issuer = '';

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', issuer);
    const json = (body: unknown) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        ...(state.endSession ? { end_session_endpoint: `${issuer}/logout` } : {}),
      });
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      state.authorize = url.searchParams;
      const code = `code-${codes.size}`;
      codes.set(code, url.searchParams.get('nonce'));
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      back.searchParams.set('iss', issuer);
      response.writeHead(302, { location: back.toString() });
      return response.end();
    }
    if (url.pathname === '/token') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const form = new URLSearchParams(raw);
      const nonce = codes.get(form.get('code') ?? '');
      state.clientSecret = form.get('client_secret') ?? request.headers.authorization ?? null;
      const claims = state.authTime ? { auth_time: state.authTime } : {};
      const idToken = await new SignJWT({ nonce, name: 'Camille', email: 'camille@example.com', groups: state.groups, ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer)
        .setAudience(state.audience)
        .setSubject('user-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return json({ access_token: 'at', token_type: 'Bearer', id_token: idToken, expires_in: 300 });
    }
    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { issuer, state, close: () => server.close() };
}
