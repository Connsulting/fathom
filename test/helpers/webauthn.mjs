// Software WebAuthn authenticator for HTTP-level tests.
//
// It plays the browser and the authenticator together: given the server's registration or
// authentication options it returns the JSON a browser hands to the page after
// navigator.credentials.create() or .get(). Shapes follow the WebAuthn Level 3 spec
// (https://www.w3.org/TR/webauthn-3/: authenticator data, attestation object, collected client
// data, PublicKeyCredential JSON) and what @simplewebauthn/server's verifier reads. That verifier
// is the real one these tests run against: nothing here is trusted by the server, every
// response is checked by the same code a real browser's response is.
//
// Credentials are ES256 (P-256 via node:crypto), discoverable, user-verified, attestation 'none',
// with a zero AAGUID. Each authenticator keeps its own credentials, like a separate device.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const AAGUID = Buffer.alloc(16);

const b64u = value => Buffer.from(value).toString('base64url');
const sha256 = value => createHash('sha256').update(value).digest();

function ceremonyError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

// CBOR head in its shortest form. The verifier decodes the COSE key and re-encodes it to find
// where it ends, so every head must already be minimal (RFC 8949 section 4.2.1).
function head(major, n) {
  const type = major << 5;
  if (n < 24) return Buffer.from([type | n]);
  if (n < 0x100) return Buffer.from([type | 24, n]);
  if (n < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = type | 25;
    out.writeUInt16BE(n, 1);
    return out;
  }
  if (n < 0x100000000) {
    const out = Buffer.alloc(5);
    out[0] = type | 26;
    out.writeUInt32BE(n, 1);
    return out;
  }
  const out = Buffer.alloc(9);
  out[0] = type | 27;
  out.writeBigUInt64BE(BigInt(n), 1);
  return out;
}

// Minimal CBOR encoder: integers (negative too), byte strings, text strings, arrays, and maps
// given as a Map (any of these as keys, in insertion order) or a plain object (text keys).
export function cbor(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('cbor: only safe integers are supported');
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value && typeof value === 'object') {
    const entries = value instanceof Map ? [...value] : Object.entries(value);
    return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  throw new TypeError(`cbor: unsupported value ${typeof value}`);
}

// COSE_Key for an EC2 P-256 ES256 public key: {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}.
function coseKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return cbor(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
  ]));
}

function counterBytes(counter) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(counter, 0);
  return out;
}

function clientData(type, challenge, origin) {
  if (typeof challenge !== 'string' || !challenge) throw new TypeError('options carry no challenge');
  if (typeof origin !== 'string' || !origin) throw new TypeError('an origin is required');
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
}

export function createAuthenticator() {
  const credentials = [];

  return {
    // The credentials this device holds (no private keys).
    credentials() {
      return credentials.map(({ id, rpId, userHandle, counter }) => ({ id, rpId, userHandle, counter }));
    },

    // navigator.credentials.create() for PublicKeyCredentialCreationOptionsJSON.
    createCredential(options, { origin } = {}) {
      if (!options || typeof options !== 'object') throw new TypeError('registration options are required');
      const rpId = options.rp?.id ?? new URL(origin).hostname;
      const userHandle = options.user?.id;
      if (typeof userHandle !== 'string' || !userHandle) throw new TypeError('options carry no user.id');
      const excluded = new Set((options.excludeCredentials || []).map(item => item.id));
      if (credentials.some(item => item.rpId === rpId && excluded.has(item.id))) {
        throw ceremonyError('InvalidStateError', 'this authenticator already holds an excluded credential');
      }
      const clientDataJSON = clientData('webauthn.create', options.challenge, origin);
      const rawId = randomBytes(32);
      const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(rawId.length, 0);
      const authData = Buffer.concat([
        sha256(rpId), Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT]), counterBytes(0),
        AAGUID, idLength, rawId, coseKey(publicKey),
      ]);
      const attestationObject = cbor({ fmt: 'none', attStmt: new Map(), authData });
      const id = b64u(rawId);
      credentials.push({ id, rpId, userHandle, privateKey, counter: 0 });
      return {
        id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: { credProps: { rk: true } },
      };
    },

    // navigator.credentials.get() for PublicKeyCredentialRequestOptionsJSON. With no
    // allowCredentials the first discoverable credential for the RP answers, unless credentialId
    // picks one (the account chooser).
    getAssertion(options, { origin, credentialId } = {}) {
      if (!options || typeof options !== 'object') throw new TypeError('authentication options are required');
      const rpId = options.rpId ?? new URL(origin).hostname;
      const allowed = new Set((options.allowCredentials || []).map(item => item.id));
      const credential = credentials.find(item => item.rpId === rpId
        && (allowed.size === 0 || allowed.has(item.id))
        && (credentialId === undefined || item.id === credentialId));
      if (!credential) throw ceremonyError('NotAllowedError', 'no matching credential on this authenticator');
      credential.counter += 1;
      const clientDataJSON = clientData('webauthn.get', options.challenge, origin);
      const authData = Buffer.concat([sha256(rpId), Buffer.from([FLAG_UP | FLAG_UV]), counterBytes(credential.counter)]);
      // ES256 signs authenticatorData || SHA-256(clientDataJSON); WebAuthn carries it DER-encoded.
      const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), { key: credential.privateKey, dsaEncoding: 'der' });
      return {
        id: credential.id, rawId: credential.id, type: 'public-key', authenticatorAttachment: 'platform',
        response: {
          clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData),
          signature: b64u(signature), userHandle: credential.userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
}
