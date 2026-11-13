import { Controller, Get, Inject } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import { CurrentUser, SignedIn } from '../auth/access.js';
import { launchpadOf } from '../config/instance.js';
import { CONFIG } from '../config/tokens.js';
import { Store } from '../database/store.js';
import * as schemas from '../http/schemas.js';
import { describeLink } from '../links/links.controller.js';
import { Registry } from '../runtime/registry.js';
import type { Config, User } from '../types.js';

// What every signed-in person sees: their account and the launchpad.
@Controller('api')
export class AccountController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly store: Store,
    private readonly registry: Registry,
  ) {}

  @Get('me')
  @SignedIn()
  @RouteSchema({
    summary: 'Signed-in account and customisation',
    tags: ['Account'],
    response: { 200: schemas.meBody, ...schemas.refused },
  })
  me(@CurrentUser() user: User) {
    const { logo, ...branding } = launchpadOf(this.config.instance);
    return {
      user,
      authMode: this.config.auth.mode,
      isolated: this.config.sandbox.mode === 'container',
      branding: { ...branding, hasLogo: Boolean(logo) },
    };
  }

  @Get('launchpad')
  @SignedIn()
  @RouteSchema({
    summary: 'Live apps, external links and groups',
    tags: ['Account'],
    response: { 200: schemas.launchpadBody, ...schemas.refused },
  })
  async launchpad() {
    const [apps, links, groups] = await Promise.all([this.store.listApps(), this.store.listLinks(), this.store.listGroups()]);
    const rows = [];
    for (const row of apps) {
      const mount = this.registry.get(row.id);
      if (row.status !== 'live' || !mount?.manifest.frontend) continue;
      rows.push({
        id: row.id,
        name: row.name,
        group: row.group_id,
        route: mount.manifest.frontend.route,
        version: mount.manifest.version,
        hasIcon: Boolean(mount.manifest.icon),
      });
    }
    return { apps: rows, links: links.map(describeLink), groups };
  }
}
