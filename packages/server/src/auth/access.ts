import {
  applyDecorators,
  createParamDecorator,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { CONFIG } from '../config/tokens.js';
import type { Config } from '../types.js';

type Rule = 'user' | 'admin' | 'admin-or-agent' | 'agent';

const RULE = 'archipel:access';
const RECENT_SIGN_IN = 'archipel:recent-sign-in';
const REAUTH_WINDOW_MS = 15 * 60_000;
const HUMAN_ONLY = 'Reserved for a person: an agent token submits and reads, it never decides.';

// Who may call a route. A route without any of these decorators is public.
export const SignedIn = () => SetMetadata(RULE, 'user' satisfies Rule);
export const AdminOnly = () => SetMetadata(RULE, 'admin' satisfies Rule);
export const AdminOrAgent = () => SetMetadata(RULE, 'admin-or-agent' satisfies Rule);
export const AgentOnly = () => SetMetadata(RULE, 'agent' satisfies Rule);
// A stolen session is not enough to decide: the person must have signed in at the provider recently.
export const AdminWithRecentSignIn = () => applyDecorators(AdminOnly(), SetMetadata(RECENT_SIGN_IN, true));

const requestOf = (context: ExecutionContext) => context.switchToHttp().getRequest<FastifyRequest>();

// The guard has already checked these are set: a route that asks for one declares the matching rule.
export const CurrentUser = createParamDecorator((_: unknown, context: ExecutionContext) => requestOf(context).user);
export const CurrentAgent = createParamDecorator((_: unknown, context: ExecutionContext) => requestOf(context).agent);
export const CurrentSession = createParamDecorator((_: unknown, context: ExecutionContext) => requestOf(context).session);

const refuse = (status: number, error: string, flags: Record<string, unknown> = {}) =>
  new HttpException({ error, ...flags }, status);

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  canActivate(context: ExecutionContext) {
    const rule = this.reflector.get<Rule | undefined>(RULE, context.getHandler());
    if (!rule) return true;
    const request = requestOf(context);

    if (rule === 'agent') {
      if (!request.agent) throw refuse(403, 'Reserved for agent tokens');
      return true;
    }
    if (request.agent) {
      if (rule === 'admin-or-agent') return true;
      throw refuse(403, HUMAN_ONLY, { human_required: true });
    }
    if (!request.user) throw refuse(401, 'Authentication required', { login: '/login' });
    if (rule !== 'user' && !request.user.admin) throw refuse(403, 'Reserved for platform administrators');

    if (this.reflector.get<boolean | undefined>(RECENT_SIGN_IN, context.getHandler())) this.requireRecentSignIn(request);
    return true;
  }

  // Without a provider, there is nothing to ask again.
  private requireRecentSignIn(request: FastifyRequest) {
    if (this.config.auth.mode !== 'oidc' || !request.session) return;
    if (Date.now() - request.session.authTime < REAUTH_WINDOW_MS) return;
    throw refuse(403, 'Confirm your identity to continue.', { reauth_required: true });
  }
}
