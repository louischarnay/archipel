import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { RouteConfig, RouteSchema } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Static } from 'typebox';
import { AdminOnly, AdminWithRecentSignIn, CurrentUser } from '../auth/access.js';
import { AuthCookies } from '../auth/cookies.js';
import { discoverIssuer, type IssuerSettings } from '../auth/oidc.js';
import { Setup, type Draft } from '../auth/setup.js';
import { isLoopbackUrl, withIdentityDefaults } from '../config/config.js';
import { launchpadOf, normalizeLaunchpad, writeInstance } from '../config/instance.js';
import { CONFIG, RESTART, type Restart } from '../config/tokens.js';
import { openDatabase } from '../database/database.js';
import { Store } from '../database/store.js';
import * as schemas from '../http/schemas.js';
import type { Config, User } from '../types.js';
import {
  databaseLabel,
  field,
  httpUrl,
  normalizeDatabase,
  POSTGRES,
  SQLITE,
  testDatabase,
  type DatabaseTarget,
} from './database-target.js';

const RESTART_DELAY_MS = 100;
const IDENTITY_LOCKED = "Identity is set by the server's environment.";
const DATABASE_LOCKED = "The database is set by the server's environment.";

// Instance settings, from the setup wizard and from the settings page. The environment always wins:
// a section it sets is locked here.
@Controller('api')
export class SettingsController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(RESTART) private readonly restart: Restart,
    private readonly store: Store,
    private readonly setup: Setup,
    private readonly cookies: AuthCookies,
  ) {}

  @Get('setup/state')
  @RouteSchema({ summary: 'Setup state', tags: ['Settings'], response: { 200: schemas.setupStateBody } })
  setupState(@Req() request: FastifyRequest) {
    return { required: this.config.auth.mode === 'setup', unlocked: Boolean(request.user) };
  }

  @Post('setup/unlock')
  @HttpCode(200)
  @RouteConfig({ rateLimit: { max: 10, timeWindow: '1 minute' } })
  @RouteSchema({
    ...schemas.unlockBody,
    summary: 'Opens setup with the server code',
    tags: ['Settings'],
    response: { 200: schemas.okBody, 409: schemas.errorBody, ...schemas.refused },
  })
  unlock(@Body() body: Static<typeof schemas.unlockBody.body>, @Res({ passthrough: true }) reply: FastifyReply) {
    if (this.config.auth.mode !== 'setup') throw new ConflictException('Setup is already done.');
    if (!this.setup.checkCode(body.code)) throw new ForbiddenException('Wrong setup code');
    this.cookies.openSetupSession(reply);
    return { ok: true };
  }

  @Get('settings')
  @AdminOnly()
  @RouteSchema({
    summary: 'Instance settings',
    tags: ['Settings'],
    response: { 200: schemas.settingsStateBody, ...schemas.refused },
  })
  async describe() {
    const { config } = this;
    const { logo, ...launchpad } = launchpadOf(config.instance);
    const [apps, tokens] = await Promise.all([this.store.listApps(), this.store.listAgentTokens()]);
    return {
      mode: config.auth.mode,
      launchpad: { ...launchpad, hasLogo: Boolean(logo) },
      identity: {
        locked: config.locks.identity,
        configured: Boolean(config.auth.issuer && config.auth.clientId),
        issuer: config.auth.issuer ?? '',
        clientId: config.auth.clientId ?? '',
        hasClientSecret: Boolean(config.auth.clientSecret),
        scopes: config.auth.scopes,
        groupsClaim: config.auth.groupsClaim,
        adminGroup: config.auth.adminGroup,
        providerName: config.auth.providerName ?? '',
        publicUrl: config.publicUrl,
        publicUrlLocked: config.locks.publicUrl,
      },
      database: {
        locked: config.locks.database,
        client: config.db.client,
        label: databaseLabel(config.db),
        supported: [SQLITE, POSTGRES].includes(config.db.client),
        apps: apps.length,
        tokens: tokens.length,
      },
      setup: { completedAt: config.instance.setup?.completedAt ?? null },
    };
  }

  @Post('settings/identity/test')
  @HttpCode(200)
  @AdminOnly()
  @RouteSchema({
    ...schemas.identityTestBody,
    summary: 'Prepares the test login of a provider',
    tags: ['Settings'],
    response: { 200: schemas.identityTestedBody, 409: schemas.errorBody, ...schemas.refused },
  })
  async testIdentity(@Body() body: Static<typeof schemas.identityTestBody.body>) {
    const { config } = this;
    if (config.locks.identity) throw new ConflictException(IDENTITY_LOCKED);
    const issuer = httpUrl(field(body, 'issuer', 'Issuer'), 'Issuer');
    const clientId = field(body, 'clientId', 'Client ID');
    if (!clientId) throw new BadRequestException('The client ID is required');
    const publicUrl = config.locks.publicUrl
      ? config.publicUrl
      : httpUrl(field(body, 'publicUrl', 'Public address'), 'Public address');
    const allowInsecureIssuer = config.allowHttpIssuer || isLoopbackUrl(issuer);
    if (issuer.startsWith('http:') && !allowInsecureIssuer) throw new BadRequestException('The issuer must use https.');
    // The saved secret is only sent to the provider that issued it.
    const savedSecret = issuer === config.auth.issuer ? config.auth.clientSecret : undefined;
    const settings: IssuerSettings = withIdentityDefaults({
      issuer,
      clientId,
      clientSecret: field(body, 'clientSecret', 'Secret client') || savedSecret,
      scopes: field(body, 'scopes', 'Scopes'),
      groupsClaim: field(body, 'groupsClaim', 'Groups claim'),
      adminGroup: field(body, 'adminGroup', 'Administrator group'),
      providerName: field(body, 'providerName', 'Provider name'),
      publicUrl,
      allowInsecureIssuer,
    });
    try {
      await discoverIssuer(settings);
    } catch (error) {
      return { ok: false, error: `Provider unreachable or invalid: ${(error as Error).message}` };
    }
    const id = this.setup.createDraft(settings);
    return { ok: true, id, loginUrl: `${publicUrl}/auth/test/${id}` };
  }

  @Get('settings/identity/test/:id')
  @AdminOnly()
  @RouteSchema({
    ...schemas.draftParam,
    summary: 'Result of the test login',
    tags: ['Settings'],
    response: { 200: schemas.identityResultBody, 404: schemas.errorBody, ...schemas.refused },
  })
  identityResult(@Param('id') id: string) {
    const draft = this.setup.draft(id);
    if (!draft) throw new NotFoundException('Test expired, start it again.');
    if (!draft.result) return { status: 'waiting' };
    if (draft.result.error) return { status: 'failed', error: draft.result.error };
    const { name, email, groups, admin } = draft.result.user!;
    return { status: admin ? 'ok' : 'refused', user: { name, email, groups }, adminGroup: draft.settings.adminGroup };
  }

  @Post('settings/database/test')
  @HttpCode(200)
  @AdminOnly()
  @RouteSchema({
    ...schemas.databaseBody,
    summary: 'Checks a connection to a database',
    tags: ['Settings'],
    response: { 200: schemas.databaseTestedBody, 409: schemas.errorBody, ...schemas.refused },
  })
  testDatabase(@Body() body: Static<typeof schemas.databaseBody.body>) {
    if (this.config.locks.database) throw new ConflictException(DATABASE_LOCKED);
    return testDatabase(normalizeDatabase(body));
  }

  // Applies everything the request holds at once: the wizard sends it all at the end, settings send one section.
  @Put('settings')
  @AdminWithRecentSignIn()
  @RouteSchema({
    ...schemas.settingsBody,
    summary: 'Saves the instance settings',
    tags: ['Settings'],
    response: { 200: schemas.settingsSavedBody, 409: schemas.errorBody, ...schemas.refused },
  })
  async save(
    @Body() body: Static<typeof schemas.settingsBody.body>,
    @CurrentUser() person: User,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { config } = this;
    const installing = config.auth.mode === 'setup';
    const instance = structuredClone(config.instance);
    const sections: string[] = [];

    if (body.launchpad !== undefined) {
      instance.launchpad = normalizeLaunchpad(body.launchpad, launchpadOf(config.instance));
      sections.push('launchpad');
    }

    let identity: Draft | null = null;
    if (body.identity !== undefined) {
      identity = this.testedIdentity(body.identity.testId);
      const { allowInsecureIssuer: _, ...stored } = identity.settings;
      instance.oidc = stored;
      sections.push('identity');
    } else if (installing) {
      throw new ConflictException('Without an OIDC provider, nobody could sign in: finish the Identity step.');
    }

    const database = body.database !== undefined ? await this.changedDatabase(body.database) : null;
    if (database) {
      if (database.client === SQLITE) delete instance.db;
      else instance.db = database;
      sections.push('database');
    }

    if (body.completeSetup || installing) {
      instance.setup = { completedAt: new Date().toISOString(), by: person.name };
      sections.push('setup');
    }

    writeInstance(config.dataDir, instance, config.masterKey);
    config.instance = instance;
    if (identity) {
      const { publicUrl, ...settings } = identity.settings;
      Object.assign(config.auth, settings, { mode: config.auth.mode === 'dev' ? 'dev' : 'oidc' });
      config.publicUrl = publicUrl;
      this.setup.forget(body.identity!.testId!);
    }
    await this.store.audit(person.name, 'settings.update', { detail: { sections } });

    const { restart } = this;
    if (database && restart) reply.raw.once('finish', () => setTimeout(restart, RESTART_DELAY_MS));
    return { ok: true, restart: database ? (restart ? 'running' : 'manual') : null };
  }

  // Without this round trip, a mistyped group would lock everyone out of the platform.
  private testedIdentity(testId: string | undefined) {
    if (this.config.locks.identity) throw new ConflictException(IDENTITY_LOCKED);
    const draft = this.setup.draft(testId);
    if (!draft?.result?.user?.admin) {
      throw new ConflictException('Activation refused: a successful test login with an administrator account is required.');
    }
    return draft;
  }

  // Returns the database to switch to, or null when the request names the one already in use.
  private async changedDatabase(input: Static<typeof schemas.databaseBody.body>): Promise<DatabaseTarget | null> {
    const { config } = this;
    if (config.locks.database) throw new ConflictException(DATABASE_LOCKED);
    const target = normalizeDatabase(input);
    const connection = target.url ?? config.defaultDatabase;
    if (target.client === config.db.client && connection === config.db.connection) return null;

    const processing = await this.store.listReleases({ statuses: ['processing'] });
    if (processing.length) {
      throw new ConflictException('A version is being processed: try again when the pipeline has finished.');
    }
    const check = await testDatabase(target);
    if (!check.ok) throw new BadRequestException(`Connection failed: ${check.error}`);
    // Creates the platform tables right away: a failure here does not change anything yet.
    const opened = await openDatabase({ db: { client: target.client, connection } });
    await opened.destroy();
    return target;
  }
}
