import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { requireAuth } from '../lib/auth.js';
import { getFreshAccessToken } from '../lib/calendarAuth.js';
import {
  buildAuthUrl,
  createEvent,
  exchangeCode,
  fetchUserEmail,
  isConfigured,
  listEvents,
  revokeToken,
} from '../lib/googleCalendar.js';
import { deleteTokens, getTokens, saveTokens, toPublicConnection } from '../lib/integrationTokens.js';
import { secretsEnabled } from '../lib/secrets.js';

const router = Router();

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const MAX_TITLE = 120;
const STATE_TTL = '10m';

/** Why the page cannot offer Connect yet, or null when it can. */
function blockedReason() {
  if (!isConfigured()) {
    return 'The Google Calendar client is not configured on the server';
  }

  if (!secretsEnabled()) {
    return 'Token storage is not configured on the server (TOKEN_ENCRYPTION_KEY)';
  }

  return null;
}

/**
 * The callback arrives as a browser redirect, so it carries no Authorization
 * header. A short-lived signed state both carries the user's identity across that
 * hop and stops a third party from planting an authorization code on someone else.
 */
function signedState(userId) {
  return jwt.sign({ sub: userId, nonce: randomUUID() }, config.jwt.secret, { expiresIn: STATE_TTL });
}

router.get('/status', requireAuth, async (req, res) => {
  const blocked = blockedReason();
  const connection = blocked ? null : await getTokens(req.user.id);

  res.json({
    configured: isConfigured(),
    ready: blocked === null,
    problem: blocked,
    connected: Boolean(connection),
    connection: toPublicConnection(connection),
  });
});

router.post('/connect', requireAuth, async (req, res) => {
  const blocked = blockedReason();

  if (blocked) {
    return res.status(503).json({ error: blocked });
  }

  return res.json({ url: buildAuthUrl({ state: signedState(req.user.id) }) });
});

/** Google redirects the browser here. Not behind requireAuth — see signedState(). */
router.get('/oauth/callback', async (req, res) => {
  const done = (params) =>
    res.redirect(`${config.google.frontendUrl}/calendar?${new URLSearchParams(params).toString()}`);

  const { code, state, error: providerError } = req.query;

  if (providerError) {
    return done({ error: String(providerError) });
  }

  if (!code || !state) {
    return done({ error: 'Google did not return an authorization code' });
  }

  const blocked = blockedReason();
  if (blocked) {
    return done({ error: blocked });
  }

  let userId;

  try {
    userId = jwt.verify(String(state), config.jwt.secret).sub;
  } catch {
    return done({ error: 'This connection link has expired. Please try again.' });
  }

  try {
    const tokens = await exchangeCode(String(code));
    const email = await fetchUserEmail(tokens.accessToken).catch(() => '');

    await saveTokens(userId, {
      ...tokens,
      email,
      calendarId: config.google.calendarId,
      timeZone: config.google.timeZone,
    });

    return done({ connected: '1' });
  } catch (error) {
    console.error(`[google] token exchange failed: ${error.message}`);
    return done({ error: error.message });
  }
});

router.post('/disconnect', requireAuth, async (req, res) => {
  const connection = await getTokens(req.user.id);

  if (connection) {
    try {
      await revokeToken(connection.refreshToken || connection.accessToken);
    } catch (error) {
      // Revoking at Google is best-effort: dropping the local record is what stops us
      // reaching the calendar, and a revoked-elsewhere token is not worth failing on.
      console.error(`[google] revoke failed: ${error.message}`);
    }

    await deleteTokens(req.user.id);
  }

  return res.json({ disconnected: true });
});

router.get('/events', requireAuth, async (req, res) => {
  const requested = Number.parseInt(req.query.days ?? '', 10);
  const days = Math.min(MAX_DAYS, Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_DAYS));

  const { accessToken, connection } = await getFreshAccessToken(req.user.id);

  const from = new Date();
  const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);

  const events = await listEvents({
    accessToken,
    calendarId: connection.calendarId || config.google.calendarId,
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
  });

  return res.json({ events, days, connection: toPublicConnection(connection) });
});

router.post('/events', requireAuth, async (req, res) => {
  const summary = String(req.body?.summary ?? '').trim();
  const description = String(req.body?.description ?? '').trim();
  const startAt = new Date(String(req.body?.start ?? ''));
  const endAt = new Date(String(req.body?.end ?? ''));

  if (!summary) {
    return res.status(400).json({ error: 'Give the event a title' });
  }

  if (summary.length > MAX_TITLE) {
    return res.status(400).json({ error: `Titles must be ${MAX_TITLE} characters or fewer` });
  }

  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    return res.status(400).json({ error: 'Pick a valid start and end time' });
  }

  if (endAt <= startAt) {
    return res.status(400).json({ error: 'The end time must come after the start time' });
  }

  const { accessToken, connection } = await getFreshAccessToken(req.user.id);

  const event = await createEvent({
    accessToken,
    calendarId: connection.calendarId || config.google.calendarId,
    timeZone: connection.timeZone || config.google.timeZone,
    summary,
    description,
    start: startAt.toISOString(),
    end: endAt.toISOString(),
  });

  return res.status(201).json({ event });
});

export default router;
