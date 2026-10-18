/**
 * Keeps access tokens usable without every caller knowing about expiry.
 */
import { config } from '../config.js';
import { refreshAccessToken } from './googleCalendar.js';
import { getTokens, saveTokens } from './integrationTokens.js';

/** Refresh a minute early so a slow request cannot land on a token that just expired. */
const REFRESH_SKEW_MS = 60 * 1000;

function needsReconnect(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/**
 * -> { accessToken, connection }
 *
 * Refreshes and persists when the stored token is spent. Callers get a usable
 * token or an error carrying the status the route should answer with.
 */
export async function getFreshAccessToken(userId) {
  const connection = await getTokens(userId);

  if (!connection) {
    throw needsReconnect('Connect your Google Calendar to continue');
  }

  const expiresAt = new Date(connection.expiresAt || 0).getTime();

  if (Number.isFinite(expiresAt) && expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return { accessToken: connection.accessToken, connection };
  }

  if (!connection.refreshToken) {
    throw needsReconnect('Your Google access has expired — reconnect to continue');
  }

  const refreshed = await refreshAccessToken(connection.refreshToken);
  const updated = await saveTokens(userId, {
    ...refreshed,
    calendarId: connection.calendarId || config.google.calendarId,
    timeZone: connection.timeZone || config.google.timeZone,
  });

  return { accessToken: refreshed.accessToken, connection: { ...connection, ...updated } };
}
