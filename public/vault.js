// The patient's vault, encrypted and decrypted on this device only (WebCrypto).
// The server receives {ciphertext, iv, kdf}; it never sees the passphrase, the key or the profile.
//
// Passphrase path: PBKDF2-SHA256, 600,000 iterations, 16-byte random salt -> AES-GCM-256, 12-byte random IV.
// Optional passkey path: WebAuthn PRF output -> HKDF-SHA256 -> AES-GCM-256 (kdf.kind 'prf').

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PBKDF2_ITERATIONS = 600000;
const HKDF_INFO = 'haledy vault aes-gcm v1';
const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error('This browser cannot encrypt on the device (WebCrypto needs https or localhost).');
  return s;
};

export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(String(text || ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Byte length of a base64 ciphertext (what the server stores). */
export function ciphertextBytes(ciphertext) {
  try { return fromBase64(ciphertext).length; } catch { return String(ciphertext || '').length; }
}

function parseKdf(kdf) {
  if (typeof kdf === 'string') {
    try { return JSON.parse(kdf); } catch { throw new Error('The vault record has an unreadable key-derivation header.'); }
  }
  if (!kdf || typeof kdf !== 'object') throw new Error('The vault record has no key-derivation header.');
  return kdf;
}

async function passphraseKey(passphrase, salt, iterations) {
  const material = await subtle().importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function decryptProfile(key, record) {
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(record.iv) }, key, fromBase64(record.ciphertext));
  return JSON.parse(decoder.decode(plain));
}

/** Encrypt the profile with an existing key. A fresh IV every time. */
export async function encryptProfile(key, profile, kdf) {
  const iv = randomBytes(12);
  const plain = encoder.encode(JSON.stringify(profile || {}));
  const cipher = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain);
  return { ciphertext: toBase64(cipher), iv: toBase64(iv), kdf: parseKdf(kdf) };
}

/** New passphrase vault. Returns the record for the server plus the in-memory key. */
export async function createVault(passphrase, profile) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const salt = randomBytes(16);
  const kdf = { kind: 'pbkdf2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) };
  const key = await passphraseKey(passphrase, salt, PBKDF2_ITERATIONS);
  const record = await encryptProfile(key, profile, kdf);
  return { ...record, key };
}

/** Unlock a passphrase vault record {ciphertext, iv, kdf}. Wrong passphrase -> clear error. */
export async function unlockVault(record, passphrase) {
  if (!record || !record.ciphertext || !record.iv) throw new Error('No vault record to unlock.');
  const kdf = parseKdf(record.kdf);
  if (kdf.kind === 'prf') throw new Error('This vault is locked with a passkey. Use "Unlock with passkey".');
  if (kdf.kind !== 'pbkdf2') throw new Error(`Unknown key derivation "${kdf.kind}".`);
  const iterations = Number(kdf.iterations) || PBKDF2_ITERATIONS;
  const key = await passphraseKey(String(passphrase || ''), fromBase64(kdf.salt), iterations);
  let profile;
  try {
    profile = await decryptProfile(key, record);
  } catch {
    throw new Error('Wrong passphrase. The vault did not decrypt, and nothing was sent anywhere.');
  }
  return { profile, key };
}

// ---------- Optional passkey (WebAuthn PRF) path ----------

export function passkeyAvailable() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials && window.isSecureContext;
}

function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

async function prfKey(prfOutput) {
  const material = await subtle().importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode(HKDF_INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function prfAssertion(credentialId, salt) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      rpId: location.hostname,
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const first = assertion && assertion.getClientExtensionResults().prf?.results?.first;
  if (!first) throw new Error('This passkey cannot derive an encryption key (PRF unavailable). Use a passphrase instead.');
  return new Uint8Array(first);
}

/** New passkey vault. Registers a platform passkey, then gates on a real get() that returns PRF output. */
export async function createPasskeyVault(profile) {
  if (!passkeyAvailable()) throw new Error('Passkeys need a secure page (https or localhost) and a supporting browser.');
  const salt = randomBytes(32);
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: 'Haledy' },
      user: { id: randomBytes(16), name: 'haledy-vault', displayName: 'Haledy vault' },
      challenge: randomBytes(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  if (!credential) throw new Error('No passkey was created.');
  const credentialId = toBase64Url(credential.rawId);
  // prf.enabled at create is unreliable on Chromium + Windows: trust only an actual PRF result.
  let output = credential.getClientExtensionResults().prf?.results?.first;
  output = output ? new Uint8Array(output) : await prfAssertion(credentialId, salt);
  const key = await prfKey(output);
  const kdf = { kind: 'prf', credentialId, salt: toBase64(salt), hkdf: 'SHA-256', info: HKDF_INFO };
  const record = await encryptProfile(key, profile, kdf);
  return { ...record, key };
}

/** Unlock a passkey vault record. */
export async function unlockPasskeyVault(record) {
  const kdf = parseKdf(record && record.kdf);
  if (kdf.kind !== 'prf') throw new Error('This vault uses a passphrase.');
  const key = await prfKey(await prfAssertion(kdf.credentialId, fromBase64(kdf.salt)));
  let profile;
  try {
    profile = await decryptProfile(key, record);
  } catch {
    throw new Error('That passkey did not open this vault.');
  }
  return { profile, key };
}
