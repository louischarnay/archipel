import { randomUUID } from 'node:crypto';
import { createWriteStream, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline as pump } from 'node:stream/promises';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import type { Static } from 'typebox';
import { AdminOnly, AdminOrAgent, AdminWithRecentSignIn, CurrentAgent, CurrentUser } from '../auth/access.js';
import { CONFIG } from '../config/tokens.js';
import { Store } from '../database/store.js';
import { contentType, readText, resolveInside } from '../http/files.js';
import * as schemas from '../http/schemas.js';
import { cloneRepository, extractArchive } from '../pipeline/intake.js';
import { Pipeline } from '../pipeline/pipeline.js';
import { Registry } from '../runtime/registry.js';
import type { Config, ReleaseStatus, StoredAgentToken, User } from '../types.js';
import { agentName, releaseSummary } from './summary.js';

const VIEWS: Record<string, ReleaseStatus[]> = {
  queue: ['in_review', 'processing'],
  blocked: ['failed'],
  history: ['live', 'superseded', 'rejected', 'changes_requested'],
};

const MAX_PREVIEWED_FILE = 256 * 1024;
const ACTIVITY_LIMIT = 8;
const MAX_REASON = 500;

const agentOf = (actor: string) => actor.replace(/^agent:/, '');

// Versions of apps: submitted by a person or an agent, then decided by a person only.
@Controller('api')
export class ReleasesController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly store: Store,
    private readonly registry: Registry,
    private readonly pipeline: Pipeline,
  ) {}

  @Post('releases/archive')
  @HttpCode(202)
  @AdminOrAgent()
  @RouteSchema({
    summary: 'Submits an archive',
    tags: ['Releases'],
    response: { 202: schemas.createdBody, 413: schemas.errorBody, 429: schemas.errorBody, ...schemas.refused },
  })
  async submitArchive(
    @Req() request: FastifyRequest,
    @CurrentUser() user: User | null,
    @CurrentAgent() agent: StoredAgentToken | null,
  ) {
    const part = await request.file();
    if (!part) throw new BadRequestException('Missing archive');
    const temp = join(this.config.dataDir, `upload-${randomUUID()}`);
    const discard = () => rmSync(temp, { force: true });
    await pump(part.file, createWriteStream(temp));
    if (part.file.truncated) {
      discard();
      const limitMb = this.config.limits.uploadBytes / 1024 / 1024;
      throw new PayloadTooLargeException(`Archive too large (limit ${limitMb} MB)`);
    }
    const { limits } = this.config;
    const submission = await this.pipeline
      .submit({
        sourceType: 'archive',
        sourceLabel: part.filename,
        user: agent ? { name: agentName(agent), tokenId: agent.id, apps: agent.apps } : user!,
        prepare: async (workdir) => ({
          root: await extractArchive(temp, part.filename, workdir, limits),
          sourceInfo: { type: 'archive', filename: part.filename, bytes: statSync(temp).size },
        }),
      })
      .catch((error: unknown) => {
        discard();
        throw error;
      });
    void submission.done.finally(discard);
    return { id: submission.id };
  }

  @Post('releases/git')
  @HttpCode(202)
  @AdminOnly()
  @RouteSchema({
    ...schemas.gitBody,
    summary: 'Submits a Git repository',
    tags: ['Releases'],
    response: { 202: schemas.createdBody, 429: schemas.errorBody, ...schemas.refused },
  })
  async submitGit(@Body() body: Static<typeof schemas.gitBody.body>, @CurrentUser() user: User) {
    const { url, ref } = body;
    if (!url?.trim()) throw new BadRequestException('Repository URL required');
    const { id } = await this.pipeline.submit({
      sourceType: 'git',
      sourceLabel: ref ? `${url}#${ref}` : url,
      user,
      prepare: async (workdir) => {
        const target = join(workdir, 'repo');
        const { root, commit } = await cloneRepository(url.trim(), ref?.trim() || null, target, this.config);
        return { root, sourceInfo: { type: 'git', url, ref: ref ?? null, commit } };
      },
    });
    return { id };
  }

  @Get('releases')
  @AdminOrAgent()
  @RouteSchema({
    ...schemas.releasesQuery,
    summary: 'Versions, by view, or by app for an agent',
    tags: ['Releases'],
    response: { 200: schemas.releasesBody, ...schemas.refused },
  })
  async list(@Query() query: Static<typeof schemas.releasesQuery.querystring>, @CurrentAgent() agent: StoredAgentToken | null) {
    // An agent only sees what its token submitted.
    const filter = agent
      ? { appId: query.app, submittedToken: agent.id }
      : { statuses: VIEWS[Object.hasOwn(VIEWS, query.view ?? '') ? query.view! : 'queue']! };
    const releases = await this.store.listReleases(filter);
    return { releases: releases.map(releaseSummary) };
  }

  @Get('releases/counts')
  @AdminOnly()
  @RouteSchema({
    summary: 'Number of versions per view',
    tags: ['Releases'],
    response: { 200: schemas.countsBody, ...schemas.refused },
  })
  async counts() {
    const counts: Record<string, number> = {};
    for (const [view, statuses] of Object.entries(VIEWS)) {
      counts[view] = (await this.store.listReleases({ statuses })).length;
    }
    return counts;
  }

  @Get('releases/:id')
  @AdminOrAgent()
  @RouteSchema({
    ...schemas.releaseParam,
    summary: "A version's report",
    tags: ['Releases'],
    response: { 200: schemas.releaseBody, 404: schemas.errorBody, ...schemas.refused },
  })
  async detail(@Param('id') id: string, @CurrentAgent() agent: StoredAgentToken | null) {
    const release = await this.store.getRelease(id);
    const readable = release && (!agent || release.submitted_token === agent.id);
    if (!readable) throw new NotFoundException('Version not found');
    const mounted = this.registry.get(release.id);
    return {
      ...releaseSummary(release),
      manifest: release.manifest,
      report: release.report,
      previewUrl: mounted?.manifest.frontend ? `/preview/${release.id}/` : null,
      logs: await this.store.logs(release.id),
    };
  }

  @Get('releases/:id/file')
  @AdminOnly()
  @RouteSchema({
    ...schemas.releaseParam,
    ...schemas.fileQuery,
    summary: "Content of a version's file",
    tags: ['Releases'],
    response: { 200: schemas.releaseFileBody, 404: schemas.errorBody, ...schemas.refused },
  })
  file(@Param('id') id: string, @Query() query: Static<typeof schemas.fileQuery.querystring>) {
    const file = resolveInside(join(this.config.dataDir, 'releases', id, 'app'), query.path ?? '');
    if (!file || !statSync(file).isFile()) throw new NotFoundException('File not found');
    const type = contentType(file);
    const textual = /^text\/|json|svg/.test(type) || /\.(ya?ml|md|ts|tsx|jsx|cjs|env)$/i.test(file);
    if (!textual) return { binary: true };
    if (statSync(file).size > MAX_PREVIEWED_FILE) return { tooLarge: true };
    return { content: readText(file) };
  }

  @Post('releases/:id/approve')
  @HttpCode(200)
  @AdminWithRecentSignIn()
  @RouteSchema({
    ...schemas.releaseParam,
    ...schemas.approveBody,
    summary: 'Approves a version and puts it live',
    tags: ['Releases'],
    response: { 200: schemas.releaseSummaryBody, 409: schemas.errorBody, ...schemas.refused },
  })
  async approve(@Param('id') id: string, @Body() body: Static<typeof schemas.approveBody.body>, @CurrentUser() user: User) {
    const { comment, allowDestructive } = body;
    const release = await this.pipeline.approve(id, { user, comment, allowDestructive: allowDestructive === true });
    return releaseSummary(release!);
  }

  @Post('releases/:id/request-changes')
  @HttpCode(200)
  @AdminOnly()
  @RouteSchema({
    ...schemas.releaseParam,
    ...schemas.declineBody,
    summary: 'Requests changes',
    tags: ['Releases'],
    response: { 200: schemas.releaseSummaryBody, 409: schemas.errorBody, ...schemas.refused },
  })
  requestChanges(@Param('id') id: string, @Body() body: Static<typeof schemas.declineBody.body>, @CurrentUser() user: User) {
    return this.decline(id, 'changes_requested', body.comment, user);
  }

  @Post('releases/:id/reject')
  @HttpCode(200)
  @AdminOnly()
  @RouteSchema({
    ...schemas.releaseParam,
    ...schemas.declineBody,
    summary: 'Rejects a version',
    tags: ['Releases'],
    response: { 200: schemas.releaseSummaryBody, 409: schemas.errorBody, ...schemas.refused },
  })
  reject(@Param('id') id: string, @Body() body: Static<typeof schemas.declineBody.body>, @CurrentUser() user: User) {
    return this.decline(id, 'rejected', body.comment, user);
  }

  private async decline(id: string, status: ReleaseStatus, comment: string | null | undefined, user: User) {
    const release = await this.pipeline.decline(id, { user, comment, status });
    return releaseSummary(release!);
  }

  // Only these two sources prove an agent: a name starting with "agent:" can come from an OIDC account.
  @Get('activity')
  @AdminOnly()
  @RouteSchema({
    summary: 'Recent agent activity and alerts to handle',
    tags: ['Releases'],
    response: { 200: schemas.activityBody, ...schemas.refused },
  })
  async activity() {
    const [releases, requests, apps, alerts] = await Promise.all([
      this.store.listReleases({ byAgent: true, limit: ACTIVITY_LIMIT }),
      this.store.auditByAction('release.rollback_request', ACTIVITY_LIMIT),
      this.store.listApps(),
      this.store.listOpenAlerts(),
    ]);
    const appName = new Map(apps.map((row) => [row.id, row.name]));
    // A rollback request also raises an alert: the activity line waits until it is handled.
    const pending = new Set(alerts.filter((alert) => alert.kind === 'rollback_request').map((alert) => alert.release_id));
    const events = [
      ...releases.map((release) => ({
        type: 'submit',
        at: release.created_at,
        agent: agentOf(release.submitted_by),
        release: releaseSummary(release),
      })),
      ...requests
        .filter((entry) => !pending.has(entry.release_id))
        .map((entry) => ({
          type: 'rollback_request',
          at: entry.at,
          agent: agentOf(entry.actor),
          app: { id: entry.app_id, name: appName.get(entry.app_id!) ?? entry.app_id },
          version: entry.detail!.version as string | null,
          reason: (entry.detail!.reason as string | null)?.slice(0, MAX_REASON) ?? null,
        })),
    ];
    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { events: events.slice(0, ACTIVITY_LIMIT), alerts };
  }
}
