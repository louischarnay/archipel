import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CONFIG } from '../config/tokens.js';
import { Store } from '../database/store.js';
import type { Config, User } from '../types.js';
import { AuthCookies, SESSION_COOKIE } from './cookies.js';
import { DEV_USER } from './identity.js';
import { discoverIssuer, isOidcConfigured, Oidc } from './oidc.js';
import { safeReturnTo } from './return-to.js';
import { Sessions, SESSION_TTL_S } from './sessions.js';
import { Setup } from './setup.js';

// The provider may take a moment to answer: beyond that, it did not really ask for authentication again.
const REAUTH_FRESH_S = 5 * 60;
const MAX_REASON = 200;
const STRICT_RATE = { rateLimit: { max: 60, timeWindow: '1 minute' } };

interface LoginQuery {
  returnTo?: string;
  reauth?: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly store: Store,
    private readonly sessions: Sessions,
    private readonly setup: Setup,
    private readonly cookies: AuthCookies,
    private readonly oidc: Oidc,
  ) {}

  // A new identity always opens a new session: nothing from the old one is reused.
  private async openSession(request: FastifyRequest, reply: FastifyReply, user: User, authTime?: number) {
    if (request.session) await this.sessions.revoke(request.session.id);
    const origin = { authTime, ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
    const { token } = await this.sessions.open(user, origin);
    this.cookies.set(reply, SESSION_COOKIE, token, SESSION_TTL_S);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    if (request.session) await this.sessions.revoke(request.session.id);
    this.cookies.clear(reply, SESSION_COOKIE);
    const fromProvider = request.user && request.user.sub !== DEV_USER.sub && isOidcConfigured(this.config);
    return { ok: true, redirect: fromProvider ? await this.oidc.logoutUrl() : null };
  }

  @Get('login')
  @RouteConfig(STRICT_RATE)
  async login(@Query() query: LoginQuery, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const returnTo = safeReturnTo(query.returnTo);
    if (!isOidcConfigured(this.config)) {
      if (this.config.auth.mode !== 'dev') return reply.redirect('/setup', 302);
      await this.openSession(request, reply, DEV_USER);
      return reply.redirect(returnTo, 302);
    }
    const reauth = query.reauth === '1';
    return this.oidc.redirectToProvider(
      reply,
      await this.oidc.liveIssuer(),
      this.oidc.liveSettings(),
      { returnTo, reauth },
      reauth ? { prompt: 'login', max_age: '0' } : {},
    );
  }

  // `npm run dev` keeps the local session even with a provider: it is the fallback path.
  @Get('local')
  @RouteConfig(STRICT_RATE)
  async local(@Query() query: LoginQuery, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    if (this.config.auth.mode !== 'dev') throw new NotFoundException('Page not found');
    await this.openSession(request, reply, DEV_USER);
    return reply.redirect(safeReturnTo(query.returnTo), 302);
  }

  // Test of a provider before activating it: same flow, no session at the end.
  @Get('test/:id')
  @RouteConfig(STRICT_RATE)
  async test(@Param('id') id: string, @Res() reply: FastifyReply) {
    const draft = this.setup.draft(id);
    if (!draft) throw new NotFoundException('Test expired, start it again from Archipel.');
    const client = await discoverIssuer(draft.settings);
    return this.oidc.redirectToProvider(reply, client, draft.settings, { test: id });
  }

  @Get('callback')
  @RouteConfig(STRICT_RATE)
  async callback(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const pending = this.oidc.takePendingLogin(request, reply);
    if (!pending) throw new HttpException('Sign-in session expired, start again.', 400);

    if (pending.test) {
      const draft = this.setup.draft(pending.test);
      if (!draft) throw new HttpException('Test expired, start it again from Archipel.', 400);
      try {
        const client = await discoverIssuer(draft.settings);
        const { user } = await this.oidc.userFromCallback(request, client, draft.settings, pending);
        draft.result = { user };
      } catch (error) {
        draft.result = { error: (error as Error).message };
      }
      return reply.redirect('/ui/oidc-test.html', 302);
    }

    let identity: Awaited<ReturnType<Oidc['userFromCallback']>>;
    try {
      identity = await this.oidc.userFromCallback(request, await this.oidc.liveIssuer(), this.oidc.liveSettings(), pending);
    } catch (error) {
      request.log.warn(error);
      const reason = String((error as Error).message).slice(0, MAX_REASON);
      await this.store.audit('unknown', 'auth.failure', { detail: { reason } });
      throw new HttpException('Sign-in refused by the provider, start again.', 401);
    }
    const { user, authTime } = identity;
    const actor = { type: 'user', id: user.sub };
    if (pending.reauth && Date.now() - authTime > REAUTH_FRESH_S * 1000) {
      const detail = { reason: 'reauthentication not requested by the provider' };
      await this.store.audit(user.name, 'auth.failure', { actor, detail });
      throw new HttpException('The provider did not ask for your identity again: check its configuration.', 403);
    }
    await this.openSession(request, reply, user, authTime);
    await this.store.audit(user.name, pending.reauth ? 'auth.reauth' : 'auth.login', { actor });
    return reply.redirect(pending.returnTo!, 302);
  }
}
