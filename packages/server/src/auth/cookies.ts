import { Inject, Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CONFIG } from '../config/tokens.js';
import type { Config } from '../types.js';
import { sign, verify } from './tokens.js';

export const SESSION_COOKIE = 'archipel_session';
export const LOGIN_COOKIE = 'archipel_login';
export const SETUP_COOKIE = 'archipel_setup';
const SETUP_TTL_S = 3600;

// The platform's cookies. Their name and flags follow the public address, which the settings can change.
@Injectable()
export class AuthCookies {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  private get secure() {
    return this.config.publicUrl.startsWith('https://');
  }

  // The prefix enforces Secure, Path=/ and no Domain: a subdomain cannot set this cookie.
  private nameOf(name: string) {
    return this.secure ? `__Host-${name}` : name;
  }

  private options(maxAge: number) {
    return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: this.secure, maxAge };
  }

  read(request: FastifyRequest, name: string) {
    return request.cookies[this.nameOf(name)];
  }

  set(reply: FastifyReply, name: string, value: string, ttlSeconds: number) {
    reply.setCookie(this.nameOf(name), value, this.options(ttlSeconds));
  }

  clear(reply: FastifyReply, name: string) {
    reply.clearCookie(this.nameOf(name), this.options(0));
  }

  // The session of the person who entered the setup code: it only exists in setup mode.
  openSetupSession(reply: FastifyReply) {
    this.set(reply, SETUP_COOKIE, sign({}, this.config.secrets, 'setup', SETUP_TTL_S), SETUP_TTL_S);
  }

  hasSetupSession(request: FastifyRequest) {
    return Boolean(verify(this.read(request, SETUP_COOKIE), this.config.secrets, 'setup'));
  }
}
