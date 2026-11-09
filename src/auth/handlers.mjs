export const session = async ctx => await ctx.auth.session(ctx);
export const registerOptions = async ctx => ctx.auth.registerOptions(ctx);
export const registerVerify = async ctx => ctx.auth.registerVerify(ctx);
export const signinOptions = async ctx => ctx.auth.signinOptions(ctx);
export const signinVerify = async ctx => ctx.auth.signinVerify(ctx);
export const recover = async ctx => await ctx.auth.recover(ctx);
export const signout = async ctx => await ctx.auth.signout(ctx);
export const passkeys = async ctx => await ctx.auth.passkeys(ctx);
export const revokePasskey = async ctx => await ctx.auth.revokePasskey(ctx);
export const users = async ctx => await ctx.auth.users(ctx);
export const invite = async ctx => ctx.auth.invite(ctx);
export const requestDeviceLink = async ctx => ctx.auth.requestDeviceLink(ctx);
export const setRole = async ctx => await ctx.auth.setRole(ctx);
// Removing a member also deletes the MCP keys they created in that household (the auth store does
// it in the same transaction; their verification already fails closed once the membership is gone).
export const removeUser = async ctx => await ctx.auth.removeUser(ctx);
export const adminRevokePasskey = async ctx => await ctx.auth.adminRevokePasskey(ctx);
export const acceptInvitation = async ctx => await ctx.auth.acceptInvitation(ctx);
export const switchHousehold = async ctx => await ctx.auth.switchHousehold(ctx);
export const provisionHousehold = async ctx => await ctx.auth.provisionHousehold(ctx);
