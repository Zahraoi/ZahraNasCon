/**
 * Symmetric encryption for integration secrets held at rest.
 *
 * An OAuth refresh token is a bearer credential: anything able to read
 * data/integration-tokens.json could otherwise use it against Google until it is
 * revoked. Tokens are sealed with AES-256-GCM under a key derived from
 * TOKEN_ENCRYPTION_KEY, so the file on its own is not enough to use them.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const VERSION = 'v1';
const IV_BYTES = 12;

/** Any passphrase length works — the key is the digest, not the raw value. */
function encryptionKey() {
  if (!config.google.encryptionKey) {
    throw new Error('Token encryption is not configured');
  }

  return createHash('sha256').update(config.google.encryptionKey).digest();
}

export function secretsEnabled() {
  return Boolean(config.google.encryptionKey);
}

/** -> "v1.<iv>.<tag>.<ciphertext>", each part base64url. */
export function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new Error('Nothing to encrypt');
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Throws when the blob is malformed, was sealed with another key, or was tampered with. */
export function decryptSecret(blob) {
  if (typeof blob !== 'string') {
    throw new Error('Encrypted value is not a string');
  }

  const [version, ivPart, tagPart, dataPart] = blob.split('.');

  if (version !== VERSION || !ivPart || !tagPart || !dataPart) {
    throw new Error('Encrypted value is not in a known format');
  }

  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
