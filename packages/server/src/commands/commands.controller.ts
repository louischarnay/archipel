import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Static } from 'typebox';
import { CurrentUser, SignedIn } from '../auth/access.js';
import { rolesFor } from '../auth/roles.js';
import { Store } from '../database/store.js';
import * as schemas from '../http/schemas.js';
import { Registry } from '../runtime/registry.js';
import type { AppRow, User } from '../types.js';
import { checkInput, fieldsOf, toRequest, type Input } from './tools.js';

// Actions from `exposes.mcp` for signed-in people: an agent token does not come through here.
@Controller('api/commands')
export class CommandsController {
  constructor(
    private readonly store: Store,
    private readonly registry: Registry,
  ) {}

  private mountOf(row: AppRow) {
    const mount = row.status === 'live' ? this.registry.get(row.id) : null;
    return mount && !mount.preview ? mount : null;
  }

  @Get()
  @SignedIn()
  @RouteSchema({
    summary: 'Actions available to the signed-in person',
    tags: ['Actions'],
    response: { 200: schemas.commandsBody, ...schemas.refused },
  })
  async list(@CurrentUser() user: User) {
    const commands = [];
    for (const row of await this.store.listApps()) {
      const mount = this.mountOf(row);
      if (!mount) continue;
      const roles = rolesFor(user, mount.manifest);
      for (const tool of mount.manifest.exposes?.mcp ?? []) {
        // The palette does not offer an action the app would then refuse.
        if (!this.registry.canCall(mount, tool.calls, roles)) continue;
        commands.push({
          app: { id: row.id, name: row.name },
          name: tool.name,
          description: tool.description,
          fields: fieldsOf(tool),
        });
      }
    }
    return { commands };
  }

  @Post(':app/:tool')
  @HttpCode(200)
  @SignedIn()
  @RouteSchema({
    ...schemas.commandParams,
    ...schemas.commandBody,
    summary: 'Runs an app action',
    tags: ['Actions'],
    response: { 200: schemas.commandResultBody, 404: schemas.errorBody, ...schemas.refused },
  })
  async run(
    @Param('app') appId: string,
    @Param('tool') toolName: string,
    @Body() body: Static<typeof schemas.commandBody.body>,
    @CurrentUser() person: User,
  ) {
    const row = await this.store.getApp(appId);
    const mount = row && this.mountOf(row);
    const tool = mount?.manifest.exposes?.mcp?.find((item) => item.name === toolName);
    if (!row || !mount || !tool) throw new NotFoundException('Action not found');

    const input = (body.input ?? {}) as Input;
    if (typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('Invalid fields');
    const problem = checkInput(tool, input);
    if (problem) throw new BadRequestException(problem);

    const call = toRequest(tool, input);
    const response = await this.registry.dispatch(mount, {
      ...call,
      user: { sub: person.sub, name: person.name, roles: rolesFor(person, mount.manifest) },
    });
    mount.log(
      response.status >= 500 ? 'error' : 'info',
      `${call.method} ${call.path} → ${response.status} (${person.name}, action ${tool.name})`,
    );
    // The values entered may be personal: the audit keeps the action, not its content.
    await this.store.audit(person.name, 'command.run', {
      appId: row.id,
      releaseId: mount.releaseId,
      detail: { tool: tool.name, status: response.status },
    });
    return { status: response.status, result: response.body ?? null };
  }
}
