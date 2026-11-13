import { fileURLToPath } from 'node:url';
import { Controller, Get, Inject, NotFoundException, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isOidcConfigured } from '../auth/oidc.js';
import { safeReturnTo } from '../auth/return-to.js';
import { ACCENTS, decodeLogo, launchpadOf } from '../config/instance.js';
import { CONFIG } from '../config/tokens.js';
import { readText, resolveInside, sendFile } from '../http/files.js';
import type { Config, User } from '../types.js';
import { VERSION } from '../version.js';

// Built by `npm run build`, from `packages/web`.
const WEB_ROOT = fileURLToPath(new URL('../../../web/dist', import.meta.url));

const SHELL_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const SHELL_HEADERS = {
  'content-security-policy': SHELL_CSP,
  'referrer-policy': 'same-origin',
  'cache-control': 'no-cache',
};

const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// The launchpad's own pages and files. The pages are the same built interface: the server only fills in
// what must be right before any script runs (name, colours, sign-in links).
@Controller()
export class ShellController {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  private page(reply: FastifyReply, file: string, fields: Record<string, string> = {}) {
    const path = resolveInside(WEB_ROOT, file);
    if (!path) throw new NotFoundException('Interface not built: run "npm run build" on the server.');
    const { name, accent, background } = launchpadOf(this.config.instance);
    const values: Record<string, string> = { name, accent, background, ...fields };
    const html = readText(path).replace(/\{\{(\w+)\}\}/g, (_, key: string) => escapeHtml(values[key] ?? ''));
    return reply.headers({ ...SHELL_HEADERS, 'content-type': 'text/html; charset=utf-8' }).send(html);
  }

  private setupPending(user: User | null) {
    return Boolean(user?.admin && !this.config.instance.setup?.completedAt);
  }

  @Get('health')
  health() {
    return { ok: true };
  }

  @Get()
  home(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    if (!request.user) return reply.redirect('/login', 302);
    if (this.setupPending(request.user)) return reply.redirect('/setup', 302);
    return this.page(reply, 'index.html');
  }

  @Get('setup')
  setup(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    if (this.config.auth.mode === 'setup') return this.page(reply, 'setup.html');
    if (!request.user) return reply.redirect('/login?returnTo=/setup', 302);
    if (!this.setupPending(request.user)) return reply.redirect('/', 302);
    return this.page(reply, 'setup.html');
  }

  @Get('login')
  login(@Query('returnTo') requested: string | undefined, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const returnTo = safeReturnTo(requested);
    if (request.user) return reply.redirect(returnTo, 302);
    const dev = this.config.auth.mode === 'dev';
    const oidc = isOidcConfigured(this.config);
    const provider = this.config.auth.providerName;
    const { loginMessage } = launchpadOf(this.config.instance);
    const target = encodeURIComponent(returnTo);
    return this.page(reply, 'login.html', {
      lead: loginMessage || 'Sign in with your account.',
      action: !oidc ? 'Continue locally' : provider ? `Continue with ${provider}` : 'Sign in',
      href: `/auth/login?returnTo=${target}`,
      localHref: `/auth/local?returnTo=${target}`,
      localHidden: dev && oidc ? '' : 'hidden',
      devHidden: dev ? '' : 'hidden',
      version: VERSION,
    });
  }

  // The logo carries the accent colour, including in the browser tab.
  @Get('ui/mark.svg')
  mark(@Res() reply: FastifyReply) {
    const path = resolveInside(WEB_ROOT, 'mark.svg');
    if (!path) throw new NotFoundException('File not found');
    const { accent } = launchpadOf(this.config.instance);
    const svg = readText(path).replace(ACCENTS.ocean!, ACCENTS[accent]!);
    return reply.headers({ ...SHELL_HEADERS, 'content-type': 'image/svg+xml' }).send(svg);
  }

  @Get('ui/logo')
  logo(@Res() reply: FastifyReply) {
    const { logo } = launchpadOf(this.config.instance);
    if (!logo) return reply.redirect('/ui/mark.svg', 302);
    const { bytes, type } = decodeLogo(logo);
    return reply.headers({ ...SHELL_HEADERS, 'content-type': type!, 'x-content-type-options': 'nosniff' }).send(bytes);
  }

  @Get('ui/*')
  asset(@Param('*') path: string, @Res() reply: FastifyReply) {
    const file = resolveInside(WEB_ROOT, path);
    if (!file) throw new NotFoundException('File not found');
    return sendFile(reply, file, SHELL_HEADERS);
  }
}
