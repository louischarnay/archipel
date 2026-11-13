import type { Controller } from '@archipel/sdk';
import type { Tables } from '../app.types.js';

const health: Controller<Tables> = async (ctx) => {
  await ctx.db.table('ticket').list({ limit: 1 });
  return { ok: true };
};

export default health;
