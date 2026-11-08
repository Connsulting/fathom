import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { HttpError } from '../api/http.mjs';
import { validatePublicUrl } from '../config.mjs';
import { createAuthStore, normalizeEmail, digest, validHandle, CHALLENGE_TTL } from './store.mjs';
import { authLinkMail, passkeyAddedMail, accountRecoveredMail } from './mail.mjs';
import { readCookie, setCookie, SESSION_COOKIE, CEREMONY_COOKIE } from './cookies.mjs';
import { createClientAddressResolver } from './client-ip.mjs';
import { createHouseholdStorage } from '../platform/db.mjs';
import { mapSeries } from '../shared/series.mjs';

const badVerification = () => new HttpError(400, 'passkey verification failed');
const expiredLink = () => new HttpError(410, 'link expired or already used');
const unauthorized = () => new HttpError(401, 'unauthorized');
const recentSigninRequired = () => new HttpError(403, 'Sign in again to add a passkey.', undefined, 'recent_signin_required');
const RECENT_SIGNIN_TTL = 10 * 60_000;
const GENERIC_MAIL = Object.freeze({ sent: true });

function passkeyName(value) {
  if (value === undefined) return 'Passkey';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new HttpError(400, 'invalid passkey name');
  }
  return value.trim();
}

// Accounts and sessions live in the platform DB (`platform`); the service never reads a
// financial store. Identity: { id, email, login, name, householdId, role, operator, memberships }.
// householdId is the session's household while the user is an active member of it (else, with no
// session household, the user's only active membership); role is that membership's role while the
// household is active; memberships lists only the user's own. Every household-scoped check works on
// the identity's own household: servedMember(identity) is an active membership in an active
// household, servedAdmin(identity) adds the admin role, and the admin user routes act on
// identity.householdId. `demo` is the instance mode. `secrets` (src/platform/secrets.mjs) lets the
// operator route create a provisioned household's storage (createHouseholdStorage).
export function createAuthService({ platform, config, transport, secrets = null, now = () => Date.now() }) {
  if (!platform) throw new TypeError('createAuthService needs the platform database');
  const db = platform;
  const store = createAuthStore(platform, { now });
  const clientAddress = createClientAddressResolver(config.trustedProxies ?? []);
  const demo = store.servedHousehold()?.mode === 'demo';
  const publicUrl = validatePublicUrl(config.publicUrl, { required: !demo });
  const origin = publicUrl ? new URL(publicUrl).origin : null;
  const rpID = origin ? new URL(origin).hostname : null;
  const currentSession = req => readCookie(req, SESSION_COOKIE);
  const currentUser = req => store.session(currentSession(req));
  async function identityFor(user) {
    if (!user) return null;
    const memberships = await store.activeMemberships(user.id);
    const bound = user.sessionHouseholdId ?? store.defaultHousehold(user.id);
    const current = memberships.find(m => m.householdId === bound) || null;
    const active = current ? (await db.prepare('SELECT status FROM households WHERE id = ?').get(current.householdId))?.status === 'active' : false;
    return {
      id: user.id, email: user.email, login: user.email, name: user.email,
      householdId: current ? current.householdId : null, role: active ? current.role : null,
      operator: store.isOperator(user.id), memberships, contextVersion: user.contextVersion ?? null,
    };
  }
  const identityOfUser = async id => await identityFor(store.getUser(id));
  // The identity of a session token's user, with that session's household and context version.
  const identityOfSession = async token => await identityFor(store.session(token));
  // Listeners told the session key (sha256 of the session token) whose household context ended:
  // a switch or a sign-out. The router ends that session's streams.
  const contextListeners = new Set();
  function contextEnded(raw) {
    if (!validHandle(raw)) return;
    const key = digest(raw);
    for (const listener of contextListeners) {
      try { listener(key); } catch { /* a listener never blocks the change */ }
    }
  }
  // True when the identity holds an active membership in its own household and that household is active.
  async function servedMember(identity) {
    if (!identity || typeof identity.householdId !== 'string' || !identity.role) return false;
    return (await db.prepare('SELECT status FROM households WHERE id = ?').get(identity.householdId))?.status === 'active';
  }
  const servedAdmin = async identity => await servedMember(identity) && identity.role === 'admin';
  async function requireUser(req, { admin = false } = {}) {
    const identity = await identityFor(currentUser(req));
    if (!identity) throw unauthorized();
    if (admin && !await servedAdmin(identity)) throw new HttpError(403, 'administrator required');
    return identity;
  }
  // The admin's own household (requireUser with admin has already checked the membership).
  const adminHousehold = admin => admin.householdId;
  // A creator-owned MCP key verifies only while its creator is an active member of the key's household.
  function creatorActive(userId, householdId) {
    return typeof userId === 'string' && typeof householdId === 'string' && store.membership(userId, householdId)?.status === 'active';
  }
  async function rate(req, kind) {
    const address = clientAddress(req);
    if (kind === 'recover' || kind === 'invite' || kind === 'device') {
      await store.rateLimit(`${kind}:global`, { limit: 120, windowMs: 10 * 60_000 });
      await store.rateLimit(`${kind}:socket:${address}`, { limit: 60, windowMs: 10 * 60_000 });
    } else {
      await store.rateLimit('ceremony:global', { limit: 240 });
      await store.rateLimit(`ceremony:socket:${address}`, { limit: 120 });
    }
  }
  // Adding a passkey, or asking for an add-a-device link, with only a session needs a sign-in from
  // the last 10 minutes. Both answer the same 403.
  async function requireRecentSignin(req) {
    const session = currentSession(req);
    const signedInAt = await store.sessionSignedInAt(session);
    if (signedInAt === null || now() - signedInAt >= RECENT_SIGNIN_TTL) throw recentSigninRequired();
    return session;
  }
  // An emailed link is an invitation (enrolls a new account) or a recovery or add-passkey token
  // (an enrolled account). An invitation for an enrolled account is redeemed by accepting it.
  async function registrationContext(req, body) {
    if (body.token !== undefined) {
      const invitation = await store.invitation(body.token);
      if (invitation) {
        const user = store.userRow(invitation.userId);
        if (!user || user.enrolled_at !== null) throw expiredLink();
        return { user, token: body.token, purpose: 'invite', session: null };
      }
      const token = store.token(body.token);
      if (!token) throw expiredLink();
      const user = store.userRow(token.userId);
      if (!user || user.enrolled_at === null) throw expiredLink();
      return { user, token: body.token, purpose: token.purpose, session: null };
    }
    const user = await requireUser(req);
    const session = await requireRecentSignin(req);
    return { user: store.userRow(user.id), token: null, purpose: null, session };
  }
  async function recheckRegistration(req, body, context) {
    const fresh = await registrationContext(req, body);
    if (fresh.user.id !== context.user.id || fresh.user.user_handle !== context.user.user_handle
      || fresh.token !== context.token || fresh.purpose !== context.purpose || fresh.session !== context.session) throw badVerification();
    return fresh;
  }
  async function challengeCookie(req, res, data) {
    await store.revokeChallenge(readCookie(req, CEREMONY_COOKIE));
    const challenge = await store.createChallenge(data);
    setCookie(res, CEREMONY_COOKIE, challenge, now());
  }
  async function consumeChallenge(req, res, ceremony, token) {
    const challenge = await store.consumeChallenge(readCookie(req, CEREMONY_COOKIE));
    setCookie(res, CEREMONY_COOKIE, null);
    if (token !== undefined && !store.token(token) && !await store.invitation(token)) throw expiredLink();
    if (!challenge || challenge.ceremony !== ceremony) throw badVerification();
    return challenge;
  }
  function freshChallenge(challenge) {
    if (challenge.expires_at <= now()) throw badVerification();
  }
  async function revokeFailedMail(token, purpose) {
    try {
      if (purpose === 'invite') await store.revokeInvitation(token);
      else await store.revokeToken(token);
    } catch { /* The process may already have closed its store. */ }
    console.error('fathom: auth mail failed', 'send_failed');
  }
  async function sendLink(user, token, purpose) {
    const { message } = authLinkMail(config, user, token, purpose);
    try {
      if (!transport) throw new Error();
      await transport.send(message);
    } catch {
      await revokeFailedMail(token, purpose);
      throw new HttpError(503, 'authentication email unavailable');
    }
  }
  // Recovery tells the user and the enrolled admins of every household the user is an active
  // member of; any other add (invite, add-a-device link or in place) tells the user only.
  async function sendSecurityNotices(user, purpose) {
    const recovery = purpose === 'recovery';
    const recipients = new Set([user.email]);
    if (recovery) {
      for (const { householdId } of await store.activeMemberships(user.id)) {
        for (const admin of await store.householdAdmins(householdId)) recipients.add(admin.email);
      }
    }
    for (const to of recipients) {
      try {
        if (!transport) throw new Error();
        await transport.send(recovery
          ? accountRecoveredMail({ to, account: user.email })
          : passkeyAddedMail({ to, account: user.email }));
      } catch {
        console.error('security_notice_failed');
      }
    }
  }
  return {
    store, demo, requireUser, servedMember, servedAdmin, creatorActive,
    sweep: () => store.sweep(),
    // The request's session key (sha256 of its session token), or null.
    sessionKey(req) {
      const raw = currentSession(req);
      return validHandle(raw) ? digest(raw) : null;
    },
    onContextEnded(listener) { contextListeners.add(listener); return () => contextListeners.delete(listener); },
    identity: async req => demo ? null : await identityFor(currentUser(req)),
    async session({ req }) { return { identity: demo ? null : await identityFor(currentUser(req)), demo }; },
    async registerOptions({ req, res, body }) {
      await rate(req, 'ceremony');
      passkeyName(body.name);
      const context = await registrationContext(req, body);
      let options;
      try {
        options = await generateRegistrationOptions({
          rpName: 'Fathom', rpID, userName: context.user.email, userDisplayName: context.user.email,
          userID: Buffer.from(context.user.user_handle, 'base64url'), timeout: CHALLENGE_TTL,
          attestationType: 'none',
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
          extensions: { credProps: true },
          excludeCredentials: (await store.listPasskeys(context.user.id)).map(({ id, transports }) => ({ id, transports })),
        });
      } catch { throw badVerification(); }
      await recheckRegistration(req, body, context);
      options.excludeCredentials = (await store.listPasskeys(context.user.id)).map(({ id, transports }) => ({ id, transports, type: 'public-key' }));
      const invitation = context.purpose === 'invite';
      await challengeCookie(req, res, { ceremony: 'register', userId: context.user.id, token: invitation ? null : context.token,
        invitation: invitation ? context.token : null, session: context.session, challenge: options.challenge });
      return { options };
    },
    async registerVerify({ req, res, body }) {
      const challenge = await consumeChallenge(req, res, 'register', body.token);
      await rate(req, 'ceremony');
      const context = await registrationContext(req, body);
      const linkHash = context.token ? digest(context.token) : null;
      const invitation = context.purpose === 'invite';
      if (challenge.user_id !== context.user.id
        || (challenge.token_hash ?? null) !== (invitation ? null : linkHash)
        || (challenge.invitation_hash ?? null) !== (invitation ? linkHash : null)
        || challenge.session_hash !== (context.session ? digest(context.session) : null)) throw badVerification();
      const name = passkeyName(body.name);
      if (body.response?.clientExtensionResults?.credProps?.rk !== true) {
        throw new HttpError(400, 'a discoverable passkey is required');
      }
      let verified;
      try {
        verified = await verifyRegistrationResponse({ response: body.response, expectedChallenge: challenge.challenge,
          expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true, requireUserPresence: true });
      } catch { throw badVerification(); }
      if (!verified.verified || !verified.registrationInfo?.userVerified) throw badVerification();
      const credential = verified.registrationInfo.credential;
      const result = await store.transaction(async (store) => {
        freshChallenge(challenge);
        const fresh = await recheckRegistration(req, body, context);
        if (await db.prepare('SELECT 1 FROM passkeys WHERE id = ?').get(credential.id)) throw badVerification();
        if (fresh.purpose === 'invite') {
          await store.consumeInvitation(fresh.token, fresh.user.id);
        } else if (fresh.token) {
          const consumed = await store.consumeToken(fresh.token);
          if (!consumed || consumed.userId !== fresh.user.id || consumed.purpose !== fresh.purpose) throw expiredLink();
          if (fresh.purpose === 'recovery') {
            await db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(fresh.user.id);
            store.revokeUserSessions(fresh.user.id);
            await db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'add-passkey'").run(fresh.user.id);
          }
        }
        const transports = Array.isArray(credential.transports)
          ? credential.transports.filter(value => typeof value === 'string' && ['ble', 'hybrid', 'internal', 'nfc', 'usb', 'cable', 'smart-card'].includes(value)) : [];
        await db.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(credential.id, fresh.user.id, credential.publicKey, credential.counter, JSON.stringify(transports), name, now());
        await store.markEnrolled(fresh.user.id);
        // Invite and recovery replace this browser's session. An add-a-device link never revokes a
        // session: the browser keeps a live session of the same user, or gets a new one beside any other.
        let session = null;
        if (fresh.purpose === 'add-passkey') {
          if (store.session(currentSession(req))?.id !== fresh.user.id) session = await store.createSession(fresh.user.id);
        } else if (fresh.token) {
          store.revokeSession(currentSession(req));
          session = await store.createSession(fresh.user.id);
        }
        const sessionUser = store.session(session ? session.token : currentSession(req));
        return { identity: sessionUser?.id === fresh.user.id ? await identityFor(sessionUser) : await identityOfUser(fresh.user.id), session };
      });
      if (result.session) setCookie(res, SESSION_COOKIE, result.session, now());
      await sendSecurityNotices(result.identity, context.purpose);
      return { identity: result.identity };
    },
    async signinOptions({ req, res }) {
      await rate(req, 'ceremony');
      let options;
      try { options = await generateAuthenticationOptions({ rpID, userVerification: 'required', timeout: CHALLENGE_TTL }); }
      catch { throw badVerification(); }
      delete options.allowCredentials;
      await challengeCookie(req, res, { ceremony: 'signin', challenge: options.challenge });
      return { options };
    },
    async signinVerify({ req, res, body }) {
      const challenge = await consumeChallenge(req, res, 'signin');
      await rate(req, 'ceremony');
      const response = body.response;
      if (typeof response?.id !== 'string' || !response.id || response.id.length > 2048) throw badVerification();
      const credential = await db.prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id);
      if (!credential) throw badVerification();
      const user = store.userRow(credential.user_id);
      const userHandle = response.response?.userHandle;
      if (!user || user.enrolled_at === null || !validHandle(userHandle) || userHandle !== user.user_handle) throw badVerification();
      let verified;
      try {
        verified = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge,
          expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
          credential: { id: credential.id, publicKey: credential.public_key, counter: credential.counter, transports: JSON.parse(credential.transports) } });
      } catch { throw badVerification(); }
      if (!verified.verified || !verified.authenticationInfo?.userVerified) throw badVerification();
      const result = await store.transaction(async (store) => {
        freshChallenge(challenge);
        const current = await db.prepare('SELECT * FROM passkeys WHERE id = ?').get(credential.id);
        const fresh = store.userRow(user.id);
        if (!current || !fresh || fresh.enrolled_at === null || fresh.user_handle !== userHandle
          || current.user_id !== user.id || current.counter !== credential.counter
          || current.created_at !== credential.created_at || !Buffer.from(current.public_key).equals(Buffer.from(credential.public_key))) throw badVerification();
        await db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(verified.authenticationInfo.newCounter, credential.id);
        store.revokeSession(currentSession(req));
        const session = await store.createSession(user.id);
        return { session, identity: await identityOfSession(session.token) };
      });
      setCookie(res, SESSION_COOKIE, result.session, now());
      return { identity: result.identity };
    },
    async recover({ req, body }) {
      await rate(req, 'recover');
      let email;
      try { email = normalizeEmail(body.email); } catch { email = null; }
      await store.rateLimit(`recover:email:${email ?? 'invalid'}`, { limit: 10, windowMs: 20 * 60_000 });
      const user = email ? await store.findUser(email) : null;
      if (user?.enrolledAt != null) {
        const issued = await store.createToken(user.id, 'recovery');
        void Promise.resolve().then(async () => sendLink(user, issued.token, 'recovery')).catch(() => {});
      }
      return { ...GENERIC_MAIL };
    },
    async signout({ req, res }) {
      const user = await requireUser(req);
      const session = currentSession(req);
      const ceremony = readCookie(req, CEREMONY_COOKIE);
      await store.transaction(async (store) => {
        store.revokeSession(session);
        store.clearAddPasskey(user.id);
        await store.revokeChallenge(ceremony);
      });
      contextEnded(session);
      setCookie(res, SESSION_COOKIE, null);
      setCookie(res, CEREMONY_COOKIE, null);
      return { signedOut: true };
    },
    async passkeys({ req }) { return { passkeys: await store.listPasskeys((await requireUser(req)).id) }; },
    async revokePasskey({ req, res, params }) {
      const user = await requireUser(req);
      if (!await store.revokePasskey(user.id, params.id, { actorId: user.id, householdId: user.householdId })) throw new HttpError(404, 'no such passkey');
      setCookie(res, SESSION_COOKIE, null);
      return { passkeys: await store.listPasskeys(user.id) };
    },
    async users({ req }) {
      const admin = await requireUser(req, { admin: true });
      // Only an active member's passkeys are listed; a pending invitee may hold an account elsewhere.
      return { users: await mapSeries((await store.listPeople(adminHousehold(admin))), async person => ({
        ...person, passkeys: person.status === 'active' ? await store.listPasskeys(person.id) : [],
      })) };
    },
    async invite({ req, body }) {
      const admin = await requireUser(req, { admin: true });
      await rate(req, 'invite');
      const issued = store.invite(adminHousehold(admin), body.email, { role: body.role, inviterId: admin.id });
      await sendLink(issued.user, issued.token, 'invite');
      return { ...GENERIC_MAIL };
    },
    // An add-a-device link goes to the session user's own address; the body is ignored.
    async requestDeviceLink({ req }) {
      const user = await requireUser(req);
      await requireRecentSignin(req);
      await rate(req, 'device');
      await store.rateLimit(`device:user:${user.id}`, { limit: 10, windowMs: 20 * 60_000 });
      const { token } = await store.createToken(user.id, 'add-passkey');
      await sendLink(user, token, 'add-passkey');
      return { ...GENERIC_MAIL };
    },
    // Admin actions resolve the target inside the admin's household first: anyone else is 404
    // before any change.
    async setRole({ req, params, body }) {
      const admin = await requireUser(req, { admin: true });
      const hh = adminHousehold(admin);
      if (!await store.person(hh, params.id)) throw new HttpError(404, 'no such user');
      return { user: await store.setRole(hh, params.id, body.role, { actorId: admin.id }) };
    },
    async removeUser({ req, params }) {
      const admin = await requireUser(req, { admin: true });
      if (!await store.removeMember(adminHousehold(admin), params.id, { actorId: admin.id })) throw new HttpError(404, 'no such user');
      return { removed: true };
    },
    // Only an active member's passkeys: a pending invitee's are 404 with nothing changed.
    async adminRevokePasskey({ req, params }) {
      const admin = await requireUser(req, { admin: true });
      const hh = adminHousehold(admin);
      if ((await store.person(hh, params.id))?.status !== 'active'
        || !await store.revokePasskey(params.id, params.keyId, { actorId: admin.id, householdId: hh })) throw new HttpError(404, 'no such passkey');
      return { passkeys: await store.listPasskeys(params.id) };
    },
    // Select the session's household (docs/multi-tenancy.md, Active household and switching): only
    // an active membership in an active household, else the generic 403. Rotates the session's
    // context version, so every tab still asserting the old one is refused, and ends this session's
    // streams. Returns the new identity and { id, name, role } of the household.
    async switchHousehold({ req, body }) {
      await requireUser(req);
      await rate(req, 'ceremony');
      if (typeof body.householdId !== 'string' || !body.householdId) throw new HttpError(400, 'householdId must be a household id');
      const raw = currentSession(req);
      const household = await store.switchHousehold(raw, body.householdId);
      contextEnded(raw);
      return { identity: await identityOfSession(raw), household };
    },
    // A signed-in user joins a household through an invitation to their own address.
    async acceptInvitation({ req, body }) {
      const user = await requireUser(req);
      await rate(req, 'ceremony');
      await store.acceptInvitation(body.token, user.id);
      return { identity: await identityFor(currentUser(req)) };
    },
    // An operator provisions another household; the gate refuses it with 409 multi_household_gated.
    // Its storage (root, empty store, data key when available, all-paused outbound) is created
    // before the invitation is sent; the household turns active when its first admin joins. A
    // storage failure revokes the invitation and leaves a provisioning row with no root.
    async provisionHousehold({ req, body }) {
      const user = await requireUser(req);
      if (!store.isOperator(user.id)) throw new HttpError(403, 'operator required');
      await rate(req, 'invite');
      const made = await store.provisionHousehold({ displayName: body.displayName, adminEmail: body.adminEmail }, { actorId: user.id });
      try {
        await createHouseholdStorage({ platform, dataDir: config.dataDir, householdId: made.household.id, mode: demo ? 'demo' : 'real', secrets });
      } catch (err) {
        await store.revokeInvitation(made.token);
        console.error('fathom: household storage failed', typeof err?.code === 'string' && /^[a-z_]{1,64}$/.test(err.code) ? err.code : 'unknown');
        throw new HttpError(503, 'household storage unavailable');
      }
      await sendLink(made.user, made.token, 'invite');
      return { household: made.household };
    },
  };
}
