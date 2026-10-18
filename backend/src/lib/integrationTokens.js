/**
 * Per-user integration credentials, at rest.
 *
 * One record per connected account. Access and refresh tokens are encrypted with
 * lib/secrets.js before they touch the disk, and never leave this module in the
 * clear — toPublicConnection() is the only shape routes may return.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptSecret, encryptSecret } from './secrets.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'data');
const dbFile = join(dataDir, 'integration-tokens.json');

let writeQueue = Promise.resolve();

async function readAll() {
  try {
    const raw = await readFile(dbFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeAll(connections) {
  await mkdir(dataDir, { recursive: true });
  const tmpFile = join(dataDir, `.integration-tokens.${randomUUID()}.tmp`);
  await writeFile(tmpFile, `${JSON.stringify(connections, null, 2)}\n`, 'utf8');
  await rename(tmpFile, dbFile);
}

function withLock(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Insert or update one account's credentials. Existing secrets survive a partial update. */
export async function saveTokens(userId, tokens) {
  return withLock(async () => {
    const connections = await readAll();
    const index = connections.findIndex((record) => record.userId === userId);
    const existing = index === -1 ? null : connections[index];
    const now = new Date().toISOString();

    const record = {
      userId,
      email: tokens.email ?? existing?.email ?? '',
      calendarId: tokens.calendarId ?? existing?.calendarId ?? '',
      timeZone: tokens.timeZone ?? existing?.timeZone ?? '',
      scope: tokens.scope ?? existing?.scope ?? '',
      expiresAt: tokens.expiresAt ?? existing?.expiresAt ?? '',
      connectedAt: existing?.connectedAt ?? now,
      updatedAt: now,
      ...(tokens.accessToken ? { accessToken: encryptSecret(tokens.accessToken) } : {}),
      ...(tokens.refreshToken ? { refreshToken: encryptSecret(tokens.refreshToken) } : {}),
    };

    if (index === -1) connections.push(record);
    else connections[index] = record;

    await writeAll(connections);
    return toPublicConnection(record);
  });
}

/**
 * Decrypted credentials, or null when this account has none.
 *
 * A record that cannot be decrypted — the key was rotated, or the file was edited
 * — is treated as not connected rather than throwing, so the page offers Connect
 * again instead of failing outright.
 */
export async function getTokens(userId) {
  const connections = await readAll();
  const record = connections.find((entry) => entry.userId === userId);

  if (!record) return null;

  try {
    return {
      userId: record.userId,
      email: record.email ?? '',
      calendarId: record.calendarId ?? '',
      timeZone: record.timeZone ?? '',
      scope: record.scope ?? '',
      expiresAt: record.expiresAt ?? '',
      connectedAt: record.connectedAt ?? '',
      updatedAt: record.updatedAt ?? '',
      accessToken: record.accessToken ? decryptSecret(record.accessToken) : '',
      refreshToken: record.refreshToken ? decryptSecret(record.refreshToken) : '',
    };
  } catch (error) {
    console.error(`[google] stored credentials for ${userId} are unreadable: ${error.message}`);
    return null;
  }
}

export async function deleteTokens(userId) {
  return withLock(async () => {
    const connections = await readAll();
    const remaining = connections.filter((record) => record.userId !== userId);
    const removed = remaining.length !== connections.length;

    if (removed) await writeAll(remaining);
    return removed;
  });
}

/** The only shape that may cross into a response: no tokens, ever. */
export function toPublicConnection(record) {
  if (!record) return null;

  return {
    email: record.email ?? '',
    calendarId: record.calendarId ?? '',
    timeZone: record.timeZone ?? '',
    scope: record.scope ?? '',
    expiresAt: record.expiresAt ?? '',
    connectedAt: record.connectedAt ?? '',
    updatedAt: record.updatedAt ?? '',
  };
}
