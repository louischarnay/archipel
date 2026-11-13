import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Controller, Get, Res, ServiceUnavailableException } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import { create } from 'tar';
import { AgentOnly, CurrentAgent } from '../auth/access.js';
import * as schemas from '../http/schemas.js';
import type { StoredAgentToken } from '../types.js';

// Built by `npm run build`: the skill's instructions and the CLI as a single file, served as is.
const SKILL_ROOT = fileURLToPath(new URL('../../../cli/dist/skill', import.meta.url));

// What an agent needs before it submits anything: its own identity, and the skill that explains the platform.
@Controller()
export class AgentController {
  @Get('api/agent/me')
  @AgentOnly()
  @RouteSchema({
    summary: 'Agent token in use and the apps it can submit',
    tags: ['Access'],
    response: { 200: schemas.agentIdentityBody, ...schemas.refused },
  })
  me(@CurrentAgent() agent: StoredAgentToken) {
    const { id, name, apps } = agent;
    return { id, name, apps };
  }

  // Public, like the sign-in page: no data or secret, and `curl` must be able to install it without a session.
  @Get('agent/skill.tar.gz')
  skill(@Res() reply: FastifyReply) {
    if (!existsSync(SKILL_ROOT)) throw new ServiceUnavailableException('Skill not built: run "npm run build" on the server.');
    return reply
      .headers({
        'content-type': 'application/gzip',
        'content-disposition': 'attachment; filename="archipel-skill.tar.gz"',
        'cache-control': 'no-cache',
      })
      .send(create({ gzip: true, portable: true, cwd: SKILL_ROOT }, ['archipel']));
  }
}
