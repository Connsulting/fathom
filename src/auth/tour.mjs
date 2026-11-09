// Per-user tour flag in the platform DB (users.tour_pending): set when the user completes
// onboarding, cleared when they finish or dismiss the guided tour, so it shows once per user and
// not again on another device or browser. Each function acts on ctx.identity's own row only; a
// caller without an identity (the demo, a signed-out request) has no row and nothing changes.

const userId = ctx => (typeof ctx.identity?.id === 'string' ? ctx.identity.id : null);

export async function tourPending(ctx) {
  const id = userId(ctx);
  if (!id || !ctx.platform) return false;
  return (await ctx.platform.prepare('SELECT tour_pending AS p FROM users WHERE id = ?').get(id))?.p === 1;
}

export async function setTourPending(ctx, pending) {
  const id = userId(ctx);
  if (id && ctx.platform) await ctx.platform.prepare('UPDATE users SET tour_pending = ? WHERE id = ?').run(pending ? 1 : 0, id);
}
