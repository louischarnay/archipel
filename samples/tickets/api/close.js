const close = async (ctx) => {
    const ticket = await ctx.db.table('ticket').get(ctx.params.id);
    if (!ticket)
        throw ctx.error(404, 'Ticket not found');
    ctx.log.info(`Ticket ${ticket.id} closed by ${ctx.user.name}`);
    return ctx.db.table('ticket').update(ticket.id, { status: 'done' });
};
export default close;
