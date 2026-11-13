const health = async (ctx) => {
    await ctx.db.table('ticket').list({ limit: 1 });
    return { ok: true };
};
export default health;
