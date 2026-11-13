import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { CONFIG } from '../config/tokens.js';
import type { Config, User } from '../types.js';
import { AuthCookies, LOGIN_COOKIE } from './cookies.js';
import { sign, verify } from './tokens.js';

export interface IssuerSettings {
  issuer?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  scopes: string;
  groupsClaim: string;
  adminGroup: string;
  providerName?: string | undefined;
  publicUrl: string;
  allowInsecureIssuer?: boolean;
}

// What the login cookie remembers between the redirect to the provider and its callback.
export interface PendingLogin {
  verifier: string;
  state: string;
  nonce: string;
  returnTo?: string;
  reauth?: boolean;
  test?: string;
}

type Claims = Record<string, unknown> & { sub: string; auth_time?: number; email?: string };

const LOGIN_TTL_S = 600;
const DISCOVERY_TIMEOUT_S = 8;

function userFromClaims(claims: Claims, settings: Pick<IssuerSettings, 'groupsClaim' | 'adminGroup'>): User {
  const raw = claims[settings.groupsClaim];
  const groups = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
  return {
    sub: String(claims.sub),
    name: (claims.name || claims.preferred_username || claims.email || String(claims.sub)) as string,
    email: claims.email ?? null,
    groups,
    admin: groups.includes(settings.adminGroup),
  };
}

export const discoverIssuer = (settings: Pick<IssuerSettings, 'issuer' | 'clientId' | 'clientSecret' | 'allowInsecureIssuer'>) =>
  oidc.discovery(new URL(settings.issuer!), settings.clientId!, settings.clientSecret, undefined, {
    timeout: DISCOVERY_TIMEOUT_S,
    ...(settings.allowInsecureIssuer ? { execute: [oidc.allowInsecureRequests] } : {}),
  });

export const isOidcConfigured = (config: Pick<Config, 'auth'>) => Boolean(config.auth.issuer && config.auth.clientId);

// The OpenID Connect flow: the platform keeps no user, it only reads what the provider says.
@Injectable()
export class Oidc {
  private issuer: oidc.Configuration | undefined;
  private issuerKey: string | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly cookies: AuthCookies,
  ) {}

  // The settings in use, as opposed to those of a provider under test.
  liveSettings(): IssuerSettings {
    return { ...this.config.auth, publicUrl: this.config.publicUrl };
  }

  // Lazy discovery: an IdP that is briefly unreachable must not prevent startup.
  // The key follows the configuration, which can change from the settings.
  async liveIssuer() {
    const { issuer, clientId, clientSecret } = this.config.auth;
    const key = JSON.stringify([issuer, clientId, clientSecret]);
    if (!this.issuer || key !== this.issuerKey) {
      this.issuer = await discoverIssuer(this.config.auth);
      this.issuerKey = key;
    }
    return this.issuer;
  }

  async redirectToProvider(
    reply: FastifyReply,
    client: oidc.Configuration,
    settings: IssuerSettings,
    pending: Partial<PendingLogin>,
    extra: Record<string, string> = {},
  ) {
    const verifier = oidc.randomPKCECodeVerifier();
    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const cookie = sign({ ...pending, verifier, state, nonce }, this.config.secrets, 'login', LOGIN_TTL_S);
    this.cookies.set(reply, LOGIN_COOKIE, cookie, LOGIN_TTL_S);
    const url = oidc.buildAuthorizationUrl(client, {
      redirect_uri: `${settings.publicUrl}/auth/callback`,
      scope: settings.scopes,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
      ...extra,
    });
    return reply.redirect(url.toString(), 302);
  }

  // Reads the login cookie once: it is cleared whatever the outcome.
  takePendingLogin(request: FastifyRequest, reply: FastifyReply) {
    const pending = verify<PendingLogin>(this.cookies.read(request, LOGIN_COOKIE), this.config.secrets, 'login');
    this.cookies.clear(reply, LOGIN_COOKIE);
    return pending;
  }

  async userFromCallback(request: FastifyRequest, client: oidc.Configuration, settings: IssuerSettings, pending: PendingLogin) {
    const tokens = await oidc.authorizationCodeGrant(client, new URL(request.url, settings.publicUrl), {
      pkceCodeVerifier: pending.verifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
    });
    let claims = tokens.claims() as Claims;
    if (!claims[settings.groupsClaim]) {
      claims = { ...claims, ...(await oidc.fetchUserInfo(client, tokens.access_token, claims.sub)) };
    }
    return { user: userFromClaims(claims, settings), authTime: claims.auth_time ? claims.auth_time * 1000 : Date.now() };
  }

  // Signing out also goes back to the provider: otherwise, its session would reopen ours in one click.
  async logoutUrl() {
    try {
      const client = await this.liveIssuer();
      if (!client.serverMetadata().end_session_endpoint) return null;
      return oidc.buildEndSessionUrl(client, {
        client_id: this.config.auth.clientId!,
        post_logout_redirect_uri: `${this.config.publicUrl}/login`,
      }).href;
    } catch {
      return null;
    }
  }
}
