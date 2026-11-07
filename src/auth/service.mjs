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

// Accounts and sessions live in the platform DB (`platform`); the service never reads the
// financial store. Identity: { id, email, login, name, householdId, role, operator, memberships }.
// householdId is the session's household when the user is an active member of it; role is that
// membership's role while the household is active; memberships lists only the user's own.
export function createAuthService({ platform, config, transport, now = () => Date.now() }) {
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
  function identityFor(user) {
    if (!user) return null;
    const memberships = store.activeMemberships(user.id);
    const bound = user.sessionHouseholdId ?? store.defaultHousehold(user.id);
    const current = memberships.find(m => m.householdId === bound) || null;
    const active = current ? db.prepare('SELECT status FROM households WHERE id = ?').get(current.householdId)?.status === 'active' : false;
    return {
      id: user.id, email: user.email, login: user.email, name: user.email,
      householdId: current ? current.householdId : null, role: active ? current.role : null,
      operator: store.isOperator(user.id), memberships,
    };
  }
  const identityOfUser = id => identityFor(store.getUser(id));
  // True when the identity is an active member of the household the store serves.
  function servedMember(identity) {
    const served = store.servedHousehold();
    return Boolean(identity && served && identity.householdId === served.id && identity.role !== null);
  }
  const servedAdmin = identity => servedMember(identity) && identity.role === 'admin';
  function requireUser(req, { admin = false } = {}) {
    const identity = identityFor(currentUser(req));
    if (!identity) throw unauthorized();
    if (admin && !servedAdmin(identity)) throw new HttpError(403, 'administrator required');
    return identity;
  }
  const servedId = () => store.servedHousehold().id;
  // A creator-owned MCP key verifies only while its creator is an active member of the served household.
  function creatorActive(userId) {
    const served = store.servedHousehold();
    return Boolean(served && typeof userId === 'string' && store.membership(userId, served.id)?.status === 'active');
  }
  function rate(req, kind) {
    const address = clientAddress(req);
    if (kind === 'recover' || kind === 'invite' || kind === 'device') {
      store.rateLimit(`${kind}:global`, { limit: 120, windowMs: 10 * 60_000 });
      store.rateLimit(`${kind}:socket:${address}`, { limit: 60, windowMs: 10 * 60_000 });
    } else {
      store.rateLimit('ceremony:global', { limit: 240 });
      store.rateLimit(`ceremony:socket:${address}`, { limit: 120 });
    }
  }
  // Adding a passkey, or asking for an add-a-device link, with only a session needs a sign-in from
  // the last 10 minutes. Both answer the same 403.
  function requireRecentSignin(req) {
    const session = currentSession(req);
    const signedInAt = store.sessionSignedInAt(session);
    if (signedInAt === null || now() - signedInAt >= RECENT_SIGNIN_TTL) throw recentSigninRequired();
    return session;
  }
  // An emailed link is an invitation (enrolls a new account) or a recovery or add-passkey token
  // (an enrolled account). An invitation for an enrolled account is redeemed by accepting it.
  function registrationContext(req, body) {
    if (body.token !== undefined) {
      const invitation = store.invitation(body.token);
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
    const user = requireUser(req);
    const session = requireRecentSignin(req);
    return { user: store.userRow(user.id), token: null, purpose: null, session };
  }
  function recheckRegistration(req, body, context) {
    const fresh = registrationContext(req, body);
    if (fresh.user.id !== context.user.id || fresh.user.user_handle !== context.user.user_handle
      || fresh.token !== context.token || fresh.purpose !== context.purpose || fresh.session !== context.session) throw badVerification();
    return fresh;
  }
  function challengeCookie(req, res, data) {
    store.revokeChallenge(readCookie(req, CEREMONY_COOKIE));
    const challenge = store.createChallenge(data);
    setCookie(res, CEREMONY_COOKIE, challenge, now());
  }
  function consumeChallenge(req, res, ceremony, token) {
    const challenge = store.consumeChallenge(readCookie(req, CEREMONY_COOKIE));
    setCookie(res, CEREMONY_COOKIE, null);
    if (token !== undefined && !store.token(token) && !store.invitation(token)) throw expiredLink();
    if (!challenge || challenge.ceremony !== ceremony) throw badVerification();
    return challenge;
  }
  function freshChallenge(challenge) {
    if (challenge.expires_at <= now()) throw badVerification();
  }
  function revokeFailedMail(token, purpose) {
    try {
      if (purpose === 'invite') store.revokeInvitation(token);
      else store.revokeToken(token);
    } catch { /* The process may already have closed its store. */ }
    console.error('fathom: auth mail failed', 'send_failed');
  }
  async function sendLink(user, token, purpose) {
    const { message } = authLinkMail(config, user, token, purpose);
    try {
      if (!transport) throw new Error();
      await transport.send(message);
    } catch {
      revokeFailedMail(token, purpose);
      throw new HttpError(503, 'authentication email unavailable');
    }
  }
  // Recovery tells the user and the enrolled admins of every household the user is an active
  // member of; any other add (invite, add-a-device link or in place) tells the user only.
  async function sendSecurityNotices(user, purpose) {
    const recovery = purpose === 'recovery';
    const recipients = new Set([user.email]);
    if (recovery) {
      for (const { householdId } of store.activeMemberships(user.id)) {
        for (const admin of store.householdAdmins(householdId)) recipients.add(admin.email);
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
    identity: req => demo ? null : identityFor(currentUser(req)),
    session({ req }) { return { identity: demo ? null : identityFor(currentUser(req)), demo }; },
    async registerOptions({ req, res, body }) {
      rate(req, 'ceremony');
      passkeyName(body.name);
      const context = registrationContext(req, body);
      let options;
      try {
        options = await generateRegistrationOptions({
          rpName: 'Fathom', rpID, userName: context.user.email, userDisplayName: context.user.email,
          userID: Buffer.from(context.user.user_handle, 'base64url'), timeout: CHALLENGE_TTL,
          attestationType: 'none',
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
          extensions: { credProps: true },
          excludeCredentials: store.listPasskeys(context.user.id).map(({ id, transports }) => ({ id, transports })),
        });
      } catch { throw badVerification(); }
      recheckRegistration(req, body, context);
      options.excludeCredentials = store.listPasskeys(context.user.id).map(({ id, transports }) => ({ id, transports, type: 'public-key' }));
      const invitation = context.purpose === 'invite';
      challengeCookie(req, res, { ceremony: 'register', userId: context.user.id, token: invitation ? null : context.token,
        invitation: invitation ? context.token : null, session: context.session, challenge: options.challenge });
      return { options };
    },
    async registerVerify({ req, res, body }) {
      const challenge = consumeChallenge(req, res, 'register', body.token);
      rate(req, 'ceremony');
      const context = registrationContext(req, body);
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
      const result = store.transaction(() => {
        freshChallenge(challenge);
        const fresh = recheckRegistration(req, body, context);
        if (db.prepare('SELECT 1 FROM passkeys WHERE id = ?').get(credential.id)) throw badVerification();
        if (fresh.purpose === 'invite') {
          store.consumeInvitation(fresh.token, fresh.user.id);
        } else if (fresh.token) {
          const consumed = store.consumeToken(fresh.token);
          if (!consumed || consumed.userId !== fresh.user.id || consumed.purpose !== fresh.purpose) throw expiredLink();
          if (fresh.purpose === 'recovery') {
            db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(fresh.user.id);
            store.revokeUserSessions(fresh.user.id);
            db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'add-passkey'").run(fresh.user.id);
          }
        }
        const transports = Array.isArray(credential.transports)
          ? credential.transports.filter(value => typeof value === 'string' && ['ble', 'hybrid', 'internal', 'nfc', 'usb', 'cable', 'smart-card'].includes(value)) : [];
        db.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(credential.id, fresh.user.id, credential.publicKey, credential.counter, JSON.stringify(transports), name, now());
        store.markEnrolled(fresh.user.id);
        // Invite and recovery replace this browser's session. An add-a-device link never revokes a
        // session: the browser keeps a live session of the same user, or gets a new one beside any other.
        let session = null;
        if (fresh.purpose === 'add-passkey') {
          if (store.session(currentSession(req))?.id !== fresh.user.id) session = store.createSession(fresh.user.id);
        } else if (fresh.token) {
          store.revokeSession(currentSession(req));
          session = store.createSession(fresh.user.id);
        }
        return { identity: identityOfUser(fresh.user.id), session };
      });
      if (result.session) setCookie(res, SESSION_COOKIE, result.session, now());
      await sendSecurityNotices(result.identity, context.purpose);
      return { identity: result.identity };
    },
    async signinOptions({ req, res }) {
      rate(req, 'ceremony');
      let options;
      try { options = await generateAuthenticationOptions({ rpID, userVerification: 'required', timeout: CHALLENGE_TTL }); }
      catch { throw badVerification(); }
      delete options.allowCredentials;
      challengeCookie(req, res, { ceremony: 'signin', challenge: options.challenge });
      return { options };
    },
    async signinVerify({ req, res, body }) {
      const challenge = consumeChallenge(req, res, 'signin');
      rate(req, 'ceremony');
      const response = body.response;
      if (typeof response?.id !== 'string' || !response.id || response.id.length > 2048) throw badVerification();
      const credential = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id);
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
      const result = store.transaction(() => {
        freshChallenge(challenge);
        const current = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(credential.id);
        const fresh = store.userRow(user.id);
        if (!current || !fresh || fresh.enrolled_at === null || fresh.user_handle !== userHandle
          || current.user_id !== user.id || current.counter !== credential.counter
          || current.created_at !== credential.created_at || !Buffer.from(current.public_key).equals(Buffer.from(credential.public_key))) throw badVerification();
        db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(verified.authenticationInfo.newCounter, credential.id);
        store.revokeSession(currentSession(req));
        return { session: store.createSession(user.id), identity: identityOfUser(user.id) };
      });
      setCookie(res, SESSION_COOKIE, result.session, now());
      return { identity: result.identity };
    },
    recover({ req, body }) {
      rate(req, 'recover');
      let email;
      try { email = normalizeEmail(body.email); } catch { email = null; }
      store.rateLimit(`recover:email:${email ?? 'invalid'}`, { limit: 10, windowMs: 20 * 60_000 });
      const user = email ? store.findUser(email) : null;
      if (user?.enrolledAt != null) {
        const issued = store.createToken(user.id, 'recovery');
        void Promise.resolve().then(() => sendLink(user, issued.token, 'recovery')).catch(() => {});
      }
      return { ...GENERIC_MAIL };
    },
    signout({ req, res }) {
      const user = requireUser(req);
      const session = currentSession(req);
      const ceremony = readCookie(req, CEREMONY_COOKIE);
      store.transaction(() => {
        store.revokeSession(session);
        store.clearAddPasskey(user.id);
        store.revokeChallenge(ceremony);
      });
      setCookie(res, SESSION_COOKIE, null);
      setCookie(res, CEREMONY_COOKIE, null);
      return { signedOut: true };
    },
    passkeys({ req }) { return { passkeys: store.listPasskeys(requireUser(req).id) }; },
    revokePasskey({ req, res, params }) {
      const user = requireUser(req);
      if (!store.revokePasskey(user.id, params.id)) throw new HttpError(404, 'no such passkey');
      setCookie(res, SESSION_COOKIE, null);
      return { passkeys: store.listPasskeys(user.id) };
    },
    users({ req }) {
      requireUser(req, { admin: true });
      return { users: store.listPeople(servedId()).map(person => ({ ...person, passkeys: store.listPasskeys(person.id) })) };
    },
    async invite({ req, body }) {
      const admin = requireUser(req, { admin: true });
      rate(req, 'invite');
      const issued = store.invite(servedId(), body.email, { role: body.role, inviterId: admin.id });
      await sendLink(issued.user, issued.token, 'invite');
      return { ...GENERIC_MAIL };
    },
    // An add-a-device link goes to the session user's own address; the body is ignored.
    async requestDeviceLink({ req }) {
      const user = requireUser(req);
      requireRecentSignin(req);
      rate(req, 'device');
      store.rateLimit(`device:user:${user.id}`, { limit: 10, windowMs: 20 * 60_000 });
      const { token } = store.createToken(user.id, 'add-passkey');
      await sendLink(user, token, 'add-passkey');
      return { ...GENERIC_MAIL };
    },
    // Admin actions resolve the target inside the admin's household first: anyone else is 404
    // before any change.
    setRole({ req, params, body }) {
      requireUser(req, { admin: true });
      const hh = servedId();
      if (!store.person(hh, params.id)) throw new HttpError(404, 'no such user');
      return { user: store.setRole(hh, params.id, body.role) };
    },
    removeUser({ req, params }) {
      requireUser(req, { admin: true });
      if (!store.removeMember(servedId(), params.id)) throw new HttpError(404, 'no such user');
      return { removed: true };
    },
    adminRevokePasskey({ req, params }) {
      requireUser(req, { admin: true });
      if (!store.person(servedId(), params.id) || !store.revokePasskey(params.id, params.keyId)) throw new HttpError(404, 'no such passkey');
      return { passkeys: store.listPasskeys(params.id) };
    },
    // A signed-in user joins a household through an invitation to their own address.
    acceptInvitation({ req, body }) {
      const user = requireUser(req);
      rate(req, 'ceremony');
      store.acceptInvitation(body.token, user.id);
      return { identity: identityFor(currentUser(req)) };
    },
    // An operator provisions another household; the gate refuses it with 409 multi_household_gated.
    async provisionHousehold({ req, body }) {
      const user = requireUser(req);
      if (!store.isOperator(user.id)) throw new HttpError(403, 'operator required');
      rate(req, 'invite');
      const made = store.provisionHousehold({ displayName: body.displayName, adminEmail: body.adminEmail }, { actorId: user.id });
      await sendLink(made.user, made.token, 'invite');
      return { household: made.household };
    },
  };
}
