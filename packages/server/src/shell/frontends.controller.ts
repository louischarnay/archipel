import { Controller, Get, Inject, NotFoundException, Param, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CONFIG } from '../config/tokens.js';
import { Registry } from '../runtime/registry.js';
import type { Config } from '../types.js';
import { serveFrontend } from './frontends.js';

// The frontends of apps: a preview under `/preview/<release>/`, a live app under its declared route.
@Controller()
export class FrontendsController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly registry: Registry,
  ) {}

  @Get('preview/:release')
  previewRoot(@Param('release') release: string, @Res() reply: FastifyReply) {
    return reply.redirect(`/preview/${release}/`, 302);
  }

  @Get('preview/:release/*')
  preview(
    @Param('release') release: string,
    @Param('*') path: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const mount = this.registry.get(release);
    if (!mount?.preview || !mount.manifest.frontend) throw new NotFoundException('Preview stopped');
    return serveFrontend(mount, path, request, reply, this.config);
  }

  // Everything else targets an app's frontend, under its declared route.
  @Get('*')
  app(@Param('*') path: string, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const [first = '', ...rest] = path.split('/');
    const mount = this.registry.findByRoute(`/${first}`);
    if (!mount) throw new NotFoundException('Page not found');
    if (!path.includes('/')) return reply.redirect(`/${first}/`, 302);
    return serveFrontend(mount, rest.join('/'), request, reply, this.config);
  }
}
