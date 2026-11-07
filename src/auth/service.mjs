import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { HttpError } from '../api/http.mjs';
import { validatePublicUrl } from '../config.mjs';
import { getSetting } from '../store/db.mjs';
import { createAuthStore, normalizeEmail, digest, validHandle, CHALLENGE_TTL, TOKEN_PURPOSES } from './store.mjs';
import { authLinkMail, passkeyAddedMail, accountRecoveredMail } from './mail.mjs';
import { readCookie, setCookie, SESSION_COOKIE, CEREMONY_COOKIE } from './cookies.mjs';
import { createClientAddressResolver } from './client-ip.mjs';

const badVerification = () => new HttpError(400, 'passkey verification failed');
const expiredLink = () => new HttpError(410, 'link expired or already used');
const unauthorized = () => new HttpError(401, 'unauthorized');
const recentSigninRequired = () => new HttpError(403, 'Sign in again to add a passkey.', undefined, 'recent_signin_required');
const RECENT_SIGNIN_TTL = 10 * 60_000;
const GENERIC_MAIL = Object.freeze({ sent: true });
export const publicIdentity = user => user ? {
  id: user.id, email: user.email, login: user.email, name: user.email,
  householdId: user.householdId, role: user.role,
} : null;

function passkeyName(value) {
  if (value === undefined) return 'Passkey';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new HttpError(400, 'invalid passkey name');
  }
  return value.trim();
}

export function createAuthService({ db, config, transport, now = () => Date.now() }) {
  const store = createAuthStore(db, { now });
  const clientAddress = createClientAddressResolver(config.trustedProxies ?? []);
  const demo = getSetting(db, 'mode', null) === 'demo';
  const publicUrl = validatePublicUrl(config.publicUrl, { required: !demo });
  const origin = publicUrl ? new URL(publicUrl).origin : null;
  store.ensureHousehold();
  const rpID = origin ? new URL(origin).hostname : null;
  const currentSession = req => readCookie(req, SESSION_COOKIE);
  const currentUser = req => store.session(currentSession(req));
  function requireUser(req, { admin = false } = {}) {
    const user = currentUser(req);
    if (!user) throw unauthorized();
    if (admin && user.role !== 'admin') throw new HttpError(403, 'administrator required');
    return user;
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
  function registrationContext(req, body) {
    if (body.token !== undefined) {
      const token = store.token(body.token);
      if (!token || !TOKEN_PURPOSES.includes(token.purpose)) throw expiredLink();
      const user = store.userRow(token.userId);
      if (!user || (token.purpose === 'invite' ? user.enrolled_at !== null : user.enrolled_at === null)) throw expiredLink();
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
    if (token !== undefined && !store.token(token)) throw expiredLink();
    if (!challenge || challenge.ceremony !== ceremony) throw badVerification();
    return challenge;
  }
  function freshChallenge(challenge) {
    if (challenge.expires_at <= now()) throw badVerification();
  }
  function revokeFailedMail(token) {
    try { store.revokeToken(token); } catch { /* The process may already have closed its store. */ }
    console.error('fathom: auth mail failed', 'send_failed');
  }
  async function sendLink(user, token, purpose) {
    const { message } = authLinkMail(config, user, token, purpose);
    try {
      if (!transport) throw new Error();
      await transport.send(message);
    } catch {
      revokeFailedMail(token);
      throw new HttpError(503, 'authentication email unavailable');
    }
  }
  // Recovery tells the user and every enrolled admin; any other add (invite, add-a-device link or
  // in place) tells the user only.
  async function sendSecurityNotices(user, purpose, name) {
    const recovery = purpose === 'recovery';
    const recipients = new Set([user.email]);
    if (recovery) {
      for (const admin of store.listUsers()) {
        if (admin.role === 'admin' && admin.enrolledAt !== null) recipients.add(admin.email);
      }
    }
    for (const to of recipients) {
      try {
        if (!transport) throw new Error();
        await transport.send(recovery
          ? accountRecoveredMail({ to, account: user.email })
          : passkeyAddedMail({ to, account: user.email, passkeyName: name }));
      } catch {
        console.error('security_notice_failed');
      }
    }
  }
  return {
    store, demo, requireUser,
    sweep: () => store.sweep(),
    identity: req => demo ? null : publicIdentity(currentUser(req)),
    session({ req }) { return { identity: demo ? null : publicIdentity(currentUser(req)), demo }; },
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
      challengeCookie(req, res, { ceremony: 'register', userId: context.user.id, token: context.token,
        session: context.session, challenge: options.challenge });
      return { options };
    },
    async registerVerify({ req, res, body }) {
      const challenge = consumeChallenge(req, res, 'register', body.token);
      rate(req, 'ceremony');
      const context = registrationContext(req, body);
      if (challenge.user_id !== context.user.id
        || challenge.token_hash !== (context.token ? digest(context.token) : null)
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
        if (fresh.token) {
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
        db.prepare('UPDATE users SET enrolled_at = coalesce(enrolled_at, ?) WHERE id = ?').run(now(), fresh.user.id);
        // Invite and recovery replace this browser's session. An add-a-device link never revokes a
        // session: the browser keeps a live session of the same user, or gets a new one beside any other.
        let session = null;
        if (fresh.purpose === 'add-passkey') {
          if (store.session(currentSession(req))?.id !== fresh.user.id) session = store.createSession(fresh.user.id);
        } else if (fresh.token) {
          store.revokeSession(currentSession(req));
          session = store.createSession(fresh.user.id);
        }
        return { identity: publicIdentity(store.getUser(fresh.user.id)), session };
      });
      if (result.session) setCookie(res, SESSION_COOKIE, result.session, now());
      await sendSecurityNotices(result.identity, context.purpose, name);
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
        return { session: store.createSession(user.id), identity: publicIdentity(store.getUser(user.id)) };
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
      requireUser(req);
      store.revokeSession(currentSession(req));
      store.revokeChallenge(readCookie(req, CEREMONY_COOKIE));
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
      return { users: store.listUsers().map(user => ({ ...user, passkeys: store.listPasskeys(user.id) })) };
    },
    async invite({ req, body }) {
      requireUser(req, { admin: true });
      rate(req, 'invite');
      const issued = store.transaction(() => {
        const user = store.inviteUser(body.email, { role: body.role });
        return { user, ...store.createToken(user.id, 'invite') };
      });
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
    setRole({ req, params, body }) {
      requireUser(req, { admin: true });
      return { user: store.setRole(params.id, body.role) };
    },
    removeUser({ req, params }) {
      requireUser(req, { admin: true });
      if (!store.removeUser(params.id)) throw new HttpError(404, 'no such user');
      return { removed: true };
    },
    adminRevokePasskey({ req, params }) {
      requireUser(req, { admin: true });
      if (!store.revokePasskey(params.id, params.keyId)) throw new HttpError(404, 'no such passkey');
      return { passkeys: store.listPasskeys(params.id) };
    },
  };
}
