/**
 * Google Calendar client.
 *
 * OAuth 2.0 and the Calendar REST API over global fetch — no SDK, matching the
 * rest of lib/. Access is limited to what the consented scopes allow, and every
 * function refuses to run when the client is not configured.
 */
import { config } from '../config.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

/** `calendar.events` reads and writes events; `readonly` covers listing. */
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
];

export function isConfigured() {
  return config.google.configured;
}

function assertConfigured() {
  if (!config.google.configured) {
    throw new Error('Google Calendar is not configured');
  }
}

async function call(url, init) {
  let response;

  try {
    response = await fetch(url, init);
  } catch {
    throw new Error('Google is unreachable from this server');
  }

  // The revoke endpoint answers with an empty body, so a failed parse is not fatal.
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const detail =
      payload?.error_description ??
      payload?.error?.message ??
      (typeof payload?.error === 'string' ? payload.error : null);

    const error = new Error(detail ?? `Google replied with status ${response.status}`);
    error.status = response.status === 429 ? 429 : 502;
    error.googleStatus = response.status;
    throw error;
  }

  return payload;
}

export function buildAuthUrl({ state }) {
  assertConfigured();

  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: CALENDAR_SCOPES.join(' '),
    // Both are required to be handed a refresh token on every consent, not just the first.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function toTokens(payload) {
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: new Date(Date.now() + Number(payload.expires_in ?? 3600) * 1000).toISOString(),
    scope: payload.scope ?? '',
  };
}

/** Trim Google's event resource down to what the portal renders. */
function toPublicEvent(event) {
  return {
    id: event.id,
    summary: event.summary ?? '(no title)',
    description: event.description ?? '',
    location: event.location ?? '',
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    allDay: Boolean(event.start?.date),
    htmlLink: event.htmlLink ?? '',
    status: event.status ?? '',
  };
}

export async function exchangeCode(code) {
  assertConfigured();

  const payload = await call(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  return toTokens(payload);
}

/** Google may not return a new refresh token, in which case the existing one stays valid. */
export async function refreshAccessToken(refreshToken) {
  assertConfigured();

  const payload = await call(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  return { ...toTokens(payload), refreshToken: payload.refresh_token ?? refreshToken };
}

export function revokeToken(token) {
  return call(`${REVOKE_ENDPOINT}?${new URLSearchParams({ token }).toString()}`, { method: 'POST' });
}

export async function fetchUserEmail(accessToken) {
  const payload = await call(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  return payload?.email ?? '';
}

export async function listEvents({
  accessToken,
  calendarId = config.google.calendarId,
  timeMin,
  timeMax,
  maxResults = 25,
}) {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: String(maxResults),
    singleEvents: 'true',
    orderBy: 'startTime',
  });

  const payload = await call(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  return (payload?.items ?? []).map(toPublicEvent);
}

export async function createEvent({
  accessToken,
  calendarId = config.google.calendarId,
  summary,
  description,
  start,
  end,
  timeZone = config.google.timeZone,
}) {
  const payload = await call(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary,
        ...(description ? { description } : {}),
        start: { dateTime: start, timeZone },
        end: { dateTime: end, timeZone },
      }),
    },
  );

  return toPublicEvent(payload);
}
