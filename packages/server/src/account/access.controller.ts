import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Static } from 'typebox';
import { AdminOnly, AdminWithRecentSignIn, CurrentSession, CurrentUser } from '../auth/access.js';
import { issueAgentToken } from '../auth/agent-tokens.js';
import { Sessions } from '../auth/sessions.js';
import { Store } from '../database/store.js';
import * as schemas from '../http/schemas.js';
import type { Session, User } from '../types.js';

const MAX_TOKEN_NAME = 64;
const MAX_TOKEN_DAYS = 365;

// Who and what can reach the platform: agent tokens, open sessions, and the alerts raised about them.
// Every route is reserved for an administrator, which refuses any agent token: only a person can issue one.
@Controller('api')
export class AccessController {
  constructor(
    private readonly store: Store,
    private readonly sessions: Sessions,
  ) {}

  @Get('agent-tokens')
  @AdminOnly()
  @RouteSchema({ summary: 'Agent tokens', tags: ['Access'], response: { 200: schemas.tokensBody, ...schemas.refused } })
  async listTokens() {
    return { tokens: await this.store.listAgentTokens() };
  }

  @Post('agent-tokens')
  @AdminWithRecentSignIn()
  @RouteSchema({
    ...schemas.tokenBody,
    summary: 'Creates an agent token, shown only once',
    tags: ['Access'],
    response: { 201: schemas.issuedTokenBody, ...schemas.refused },
  })
  async createToken(@Body() body: Static<typeof schemas.tokenBody.body>, @CurrentUser() user: User) {
    const name = body.name?.trim();
    const days = Number(body.days ?? 90);
    if (!name || name.length > MAX_TOKEN_NAME) {
      throw new BadRequestException(`Name required, ${MAX_TOKEN_NAME} characters at most`);
    }
    if (!(days >= 1 && days <= MAX_TOKEN_DAYS)) {
      throw new BadRequestException(`Duration between 1 and ${MAX_TOKEN_DAYS} days`);
    }
    const apps = body.apps?.length ? body.apps : null;
    const issued = await issueAgentToken(this.store, { name, days, apps });
    await this.store.audit(user.name, 'agent_token.create', { detail: { id: issued.id, name, days, apps } });
    return issued;
  }

  @Post('agent-tokens/:id/revoke')
  @HttpCode(200)
  @AdminOnly()
  @RouteSchema({
    ...schemas.tokenParam,
    summary: 'Revokes an agent token',
    tags: ['Access'],
    response: { 200: schemas.okBody, 404: schemas.errorBody, ...schemas.refused },
  })
  async revokeToken(@Param('id') id: string, @CurrentUser() user: User) {
    if (!(await this.store.revokeAgentToken(id))) throw new NotFoundException('Token not found');
    await this.store.audit(user.name, 'agent_token.revoke', { detail: { id } });
    return { ok: true };
  }

  @Get('sessions')
  @AdminOnly()
  @RouteSchema({ summary: 'Open sessions', tags: ['Access'], response: { 200: schemas.sessionsBody, ...schemas.refused } })
  async listSessions(@CurrentSession() current: Session | null) {
    const sessions = await this.sessions.list();
    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        name: session.user.name,
        email: session.user.email,
        admin: session.user.admin,
        ip: session.ip,
        user_agent: session.user_agent,
        created_at: session.created_at,
        last_seen_at: session.last_seen_at,
        current: session.id === current?.id,
      })),
    };
  }

  @Post('sessions/:id/revoke')
  @HttpCode(200)
  @AdminOnly()
  @RouteSchema({
    ...schemas.sessionParam,
    summary: 'Revokes a session',
    tags: ['Access'],
    response: { 200: schemas.okBody, 404: schemas.errorBody, ...schemas.refused },
  })
  async revokeSession(@Param('id') id: string, @CurrentUser() user: User) {
    if (!(await this.sessions.revoke(id))) throw new NotFoundException('Session not found');
    await this.store.audit(user.name, 'session.revoke', { detail: { id } });
    return { ok: true };
  }

  @Post('alerts/:id/ack')
  @HttpCode(200)
  @AdminOnly()
  @RouteSchema({
    ...schemas.alertParam,
    summary: 'Acknowledges an alert',
    tags: ['Access'],
    response: { 200: schemas.okBody, 404: schemas.errorBody, ...schemas.refused },
  })
  async acknowledgeAlert(@Param('id') id: string, @CurrentUser() user: User) {
    if (!(await this.store.ackAlert(id, user.name))) throw new NotFoundException('Alert not found');
    return { ok: true };
  }
}
