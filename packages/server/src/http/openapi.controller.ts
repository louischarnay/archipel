import { Controller, Get } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { AdminOnly } from '../auth/access.js';

@Controller('api')
export class OpenApiController {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  // It describes the whole API: reserved for administrators, and without a web page, which the shell's CSP would refuse.
  @Get('openapi.json')
  @AdminOnly()
  @RouteSchema({ hide: true })
  document() {
    return this.adapterHost.httpAdapter.getInstance<FastifyInstance>().swagger();
  }
}
