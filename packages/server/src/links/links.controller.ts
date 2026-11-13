import { randomBytes } from 'node:crypto';
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { FastifyReply } from 'fastify';
import type { Static } from 'typebox';
import { AdminWithRecentSignIn, CurrentUser, SignedIn } from '../auth/access.js';
import { Store } from '../database/store.js';
import * as schemas from '../http/schemas.js';
import type { ExternalLink, User } from '../types.js';
import { fetchLinkIcon } from './link-icon.js';

const MAX_NAME = 100;

function parseUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export const describeLink = ({ id, name, url, group_id, hasIcon }: ExternalLink) => ({ id, name, url, group: group_id, hasIcon });

// A link installs no code: it does not go through review, but it remains an administrator's decision.
@Controller('api/links')
export class LinksController {
  constructor(private readonly store: Store) {}

  @Post()
  @AdminWithRecentSignIn()
  @RouteSchema({
    ...schemas.linkBody,
    summary: 'Adds an external link to the launchpad',
    tags: ['Apps'],
    response: { 201: schemas.link, ...schemas.refused },
  })
  async add(@Body() body: Static<typeof schemas.linkBody.body>, @CurrentUser() user: User) {
    const name = body.name.trim();
    if (!name || name.length > MAX_NAME) throw new BadRequestException(`Name required, ${MAX_NAME} characters at most`);
    const url = parseUrl(body.url);
    if (!url) throw new BadRequestException('Invalid address: http or https, without credentials');
    const group_id = body.group || null;
    const groups = await this.store.listGroups();
    if (group_id && !groups.some((group) => group.id === group_id)) {
      throw new BadRequestException(`Unknown group: ${group_id}`);
    }

    const icon = await fetchLinkIcon(url);
    const link: ExternalLink = {
      id: `lnk${randomBytes(6).toString('hex')}`,
      name,
      url: url.href,
      group_id,
      hasIcon: Boolean(icon),
    };
    await this.store.addLink(link, icon, user.name);
    // The full address may carry a private parameter: the audit keeps the host.
    await this.store.audit(user.name, 'link.create', { detail: { id: link.id, name, host: url.host } });
    return describeLink(link);
  }

  @Delete(':id')
  @AdminWithRecentSignIn()
  @RouteSchema({
    ...schemas.linkParam,
    summary: 'Removes an external link',
    tags: ['Apps'],
    response: { 200: schemas.okBody, 404: schemas.errorBody, ...schemas.refused },
  })
  async remove(@Param('id') id: string, @CurrentUser() user: User) {
    const link = (await this.store.listLinks()).find((item) => item.id === id);
    if (!link) throw new NotFoundException('Link not found');
    await this.store.removeLink(link.id);
    await this.store.audit(user.name, 'link.remove', { detail: { id: link.id, name: link.name } });
    return { ok: true };
  }

  @Get(':id/icon')
  @SignedIn()
  @RouteSchema({ ...schemas.linkParam, summary: "An external link's logo", tags: ['Apps'] })
  async icon(@Param('id') id: string, @Res() reply: FastifyReply) {
    const icon = await this.store.getLinkIcon(id);
    if (!icon) throw new NotFoundException('Logo not found');
    return reply
      .headers({
        'content-type': icon.icon_type,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        'cache-control': 'no-cache',
      })
      .send(icon.icon);
  }
}
