import { join } from 'node:path';
import { appOpenApi } from '@archipel/manifest-schema';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import type { Static } from 'typebox';
import {
  AdminOnly,
  AdminOrAgent,
  AdminWithRecentSignIn,
  AgentOnly,
  CurrentAgent,
  CurrentUser,
  SignedIn,
} from '../auth/access.js';
import { CONFIG } from '../config/tokens.js';
import { Store } from '../database/store.js';
import { resolveInside, sendFile } from '../http/files.js';
import * as schemas from '../http/schemas.js';
import { Pipeline } from '../pipeline/pipeline.js';
import { agentName, releaseSummary } from '../releases/summary.js';
import { Registry } from '../runtime/registry.js';
import type { AgentToken, Config, StoredAgentToken, User } from '../types.js';
import { describeTables } from './tables.js';

// A token limited to some apps reads nothing about the others.
function assertTokenCovers(agent: AgentToken | null, appId: string) {
  if (agent?.apps && !agent.apps.includes(appId)) {
    throw new ForbiddenException(`This token is not allowed for the app ${appId}`);
  }
}

@Controller('api')
export class AppsController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly store: Store,
    private readonly registry: Registry,
    private readonly pipeline: Pipeline,
  ) {}

  @Get('apps')
  @AdminOnly()
  @RouteSchema({ summary: 'Apps and groups', tags: ['Apps'], response: { 200: schemas.appsBody, ...schemas.refused } })
  async list() {
    const [apps, groups, releases] = await Promise.all([
      this.store.listApps(),
      this.store.listGroups(),
      this.store.listReleases(),
    ]);
    const groupName = new Map(groups.map((group) => [group.id, group.name]));
    return {
      groups,
      apps: apps.map((row) => {
        const own = releases.filter((release) => release.app_id === row.id);
        const live = own.find((release) => release.id === row.live_release_id);
        return {
          id: row.id,
          name: row.name,
          status: row.status,
          group: row.group_id,
          groupName: row.group_id ? (groupName.get(row.group_id) ?? row.group_id) : null,
          version: live?.version ?? null,
          route: live?.manifest?.frontend?.route ?? null,
          hasIcon: Boolean((live ?? own[0])?.manifest?.icon),
          inReview: own.filter((release) => release.status === 'in_review').length,
          blocked: own[0]?.status === 'failed',
          updated_at: own[0]?.created_at ?? row.created_at,
        };
      }),
    };
  }

  @Get('apps/:id')
  @AdminOnly()
  @RouteSchema({
    ...schemas.appParam,
    summary: "An app's page",
    tags: ['Apps'],
    response: { 200: schemas.appBody, 404: schemas.errorBody, ...schemas.refused },
  })
  async detail(@Param('id') id: string) {
    const row = await this.store.getApp(id);
    if (!row) throw new NotFoundException('App not found');
    const [releases, audit] = await Promise.all([this.store.listReleases({ appId: row.id }), this.store.auditFor(row.id)]);
    const live = releases.find((release) => release.id === row.live_release_id);
    return {
      app: {
        id: row.id,
        name: row.name,
        group_id: row.group_id,
        status: row.status,
        live_release_id: row.live_release_id,
        created_at: row.created_at,
      },
      manifest: live?.manifest ?? null,
      releases: releases.map(releaseSummary),
      logs: live ? await this.store.logs(live.id) : [],
      audit,
    };
  }

  @Get('apps/:id/icon')
  @SignedIn()
  @RouteSchema({ ...schemas.appParam, summary: "An app's icon", tags: ['Apps'] })
  async icon(@Param('id') id: string, @Res() reply: FastifyReply) {
    const row = await this.store.getApp(id);
    const releases = row ? await this.store.listReleases({ appId: row.id }) : [];
    const release = releases.find((item) => item.id === row?.live_release_id) ?? releases.find((item) => item.manifest?.icon);
    const relative = release?.manifest?.icon;
    const file = relative && resolveInside(join(this.config.dataDir, 'releases', release.id, 'app'), relative);
    if (!file) throw new NotFoundException('Icon not found');
    return sendFile(reply, file, {
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'cache-control': 'no-cache',
    });
  }

  // Metadata only, including for an app not deployed yet: that is what is needed to write a manifest.
  @Get('apps/:id/schema')
  @AdminOrAgent()
  @RouteSchema({
    ...schemas.appParam,
    summary: "An app's applied schema and shared tables",
    tags: ['Apps'],
    response: { 200: schemas.appSchemaBody, ...schemas.refused },
  })
  async schema(@Param('id') id: string, @CurrentAgent() agent: StoredAgentToken | null) {
    assertTokenCovers(agent, id);
    const row = await this.store.getApp(id);
    const live = row?.live_release_id ? await this.store.getRelease(row.live_release_id) : null;
    const shared: Record<string, unknown> = {};
    for (const [name, { owner, definition }] of this.registry.sharedCatalog()) {
      shared[name] = { owner, columns: definition.columns };
    }
    return {
      id,
      status: row?.status ?? null,
      version: live?.version ?? null,
      tables: row?.applied_tables ?? {},
      shared,
    };
  }

  // Contract of the live version: an app's routes are not platform routes, so they are absent from `/api/openapi.json`.
  @Get('apps/:id/openapi.json')
  @AdminOrAgent()
  @RouteSchema({
    ...schemas.appParam,
    summary: 'OpenAPI contract of the live app',
    tags: ['Apps'],
    response: { 200: schemas.dictionaryBody, 404: schemas.errorBody, ...schemas.refused },
  })
  openApi(@Param('id') id: string, @CurrentAgent() agent: StoredAgentToken | null) {
    assertTokenCovers(agent, id);
    const mount = this.registry.get(id);
    if (!mount) throw new NotFoundException('Live version not found');
    const sharedTable = (name: string) => this.registry.sharedCatalog().get(name)?.definition ?? null;
    return appOpenApi(mount.manifest, { sharedTable });
  }

  @Post('apps/:id/rollback-request')
  @HttpCode(202)
  @AgentOnly()
  @RouteSchema({
    ...schemas.appParam,
    ...schemas.rollbackRequestBody,
    summary: 'Asks a person to roll back a version',
    tags: ['Apps'],
    response: { 202: schemas.rollbackRequestedBody, 404: schemas.errorBody, 409: schemas.errorBody, ...schemas.refused },
  })
  async requestRollback(
    @Param('id') id: string,
    @Body() body: Static<typeof schemas.rollbackRequestBody.body>,
    @CurrentAgent() agent: StoredAgentToken,
  ) {
    const own = await this.store.listReleases({ appId: id, submittedToken: agent.id });
    if (!own.length) throw new NotFoundException('App not found');
    const { releaseId, reason } = body;
    const target = await this.pipeline.requestRollback(id, releaseId, { actor: agentName(agent), reason });
    return { target: releaseSummary(target) };
  }

  @Post('apps/:id/disable')
  @HttpCode(200)
  @AdminOnly()
  @RouteSchema({
    ...schemas.appParam,
    summary: 'Stops an app',
    tags: ['Apps'],
    response: { 200: schemas.okBody, 409: schemas.errorBody, ...schemas.refused },
  })
  async disable(@Param('id') id: string, @CurrentUser() user: User) {
    await this.pipeline.setEnabled(id, false, { user });
    return { ok: true };
  }

  @Post('apps/:id/enable')
  @HttpCode(200)
  @AdminOnly()
  @RouteSchema({
    ...schemas.appParam,
    summary: 'Restarts an app',
    tags: ['Apps'],
    response: { 200: schemas.okBody, 409: schemas.errorBody, ...schemas.refused },
  })
  async enable(@Param('id') id: string, @CurrentUser() user: User) {
    await this.pipeline.setEnabled(id, true, { user });
    return { ok: true };
  }

  @Post('apps/:id/uninstall')
  @HttpCode(200)
  @AdminWithRecentSignIn()
  @RouteSchema({
    ...schemas.appParam,
    summary: 'Uninstalls an app, its data stays in the database',
    tags: ['Apps'],
    response: { 200: schemas.okBody, 409: schemas.errorBody, ...schemas.refused },
  })
  async uninstall(@Param('id') id: string, @CurrentUser() user: User) {
    await this.pipeline.uninstall(id, { user });
    return { ok: true };
  }

  @Post('apps/:id/rollback')
  @HttpCode(200)
  @AdminWithRecentSignIn()
  @RouteSchema({
    ...schemas.appParam,
    ...schemas.rollbackBody,
    summary: 'Puts an already approved version back online',
    tags: ['Apps'],
    response: { 200: schemas.rolledBackBody, 409: schemas.errorBody, ...schemas.refused },
  })
  rollback(@Param('id') id: string, @Body() body: Static<typeof schemas.rollbackBody.body>, @CurrentUser() user: User) {
    return this.pipeline.rollback(id, body.releaseId, { user });
  }

  @Patch('groups/:id')
  @AdminOnly()
  @RouteSchema({
    ...schemas.appParam,
    ...schemas.groupBody,
    summary: 'Renames an app group',
    tags: ['Apps'],
    response: { 200: schemas.okBody, 404: schemas.errorBody, ...schemas.refused },
  })
  async renameGroup(@Param('id') id: string, @Body() body: Static<typeof schemas.groupBody.body>, @CurrentUser() user: User) {
    const name = body.name?.trim();
    if (!name) throw new BadRequestException('Name required');
    if (!(await this.store.renameGroup(id, name))) throw new NotFoundException('Group not found');
    await this.store.audit(user.name, 'group.rename', { detail: { id, name } });
    return { ok: true };
  }

  @Get('tables')
  @AdminOnly()
  @RouteSchema({ summary: "Each app's tables", tags: ['Apps'], response: { 200: schemas.tablesBody, ...schemas.refused } })
  async tables() {
    return { apps: await describeTables({ store: this.store, db: this.store.db }) };
  }
}
