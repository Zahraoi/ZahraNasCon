import assert from 'node:assert/strict';
import test from 'node:test';

// config.js reads process.env at import time, and dotenv never overrides a variable
// that is already set — so setting these first pins the test to a known state no
// matter what this machine's .env happens to contain.
process.env.TOKEN_ENCRYPTION_KEY = 'unit-test-encryption-key';
process.env.GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID';
process.env.GOOGLE_CLIENT_SECRET = 'YOUR_GOOGLE_CLIENT_SECRET';

const { config } = await import('../src/config.js');
const { decryptSecret, encryptSecret, secretsEnabled } = await import('../src/lib/secrets.js');
const { buildAuthUrl, listEvents, refreshAccessToken } = await import('../src/lib/googleCalendar.js');

const ORIGINAL_FETCH = global.fetch;

/** Run a callback as though the OAuth client were properly configured. */
function asConfigured(run) {
  return async (t) => {
    const wasConfigured = config.google.configured;
    const originalId = config.google.clientId;
    const originalSecret = config.google.clientSecret;

    config.google.configured = true;
    config.google.clientId = '1234567890-real.apps.googleusercontent.com';
    config.google.clientSecret = 'GOCSPX-real';

    t.after(() => {
      config.google.configured = wasConfigured;
      config.google.clientId = originalId;
      config.google.clientSecret = originalSecret;
      global.fetch = ORIGINAL_FETCH;
    });

    await run(t);
  };
}

function respondWith({ ok, status, body }) {
  global.fetch = async () => ({
    ok,
    status,
    json: async () => body,
  });
}

// --- secrets ----------------------------------------------------------

test('a secret round trips through encryption', () => {
  const token = 'ya29.a0AfH6SMBx-long-looking-access-token_value-1234567890';

  const sealed = encryptSecret(token);

  assert.notEqual(sealed, token);
  assert.ok(!sealed.includes(token), 'the plaintext must not survive in the sealed value');
  assert.match(sealed, /^v1\./);
  assert.equal(decryptSecret(sealed), token);
});

test('the same secret seals differently every time, because the IV is random', () => {
  assert.notEqual(encryptSecret('same-input'), encryptSecret('same-input'));
});

test('a tampered ciphertext is rejected rather than decrypted to nonsense', () => {
  const sealed = encryptSecret('original value');
  const [version, iv, tag, data] = sealed.split('.');

  // Flip the last character of the payload.
  const flipped = data.slice(0, -1) + (data.at(-1) === 'A' ? 'B' : 'A');

  assert.throws(() => decryptSecret([version, iv, tag, flipped].join('.')));
});

test('a value sealed under a different key cannot be opened', () => {
  const sealed = encryptSecret('rotate me');

  const previous = config.google.encryptionKey;
  config.google.encryptionKey = 'a-completely-different-key';
  try {
    assert.throws(() => decryptSecret(sealed));
  } finally {
    config.google.encryptionKey = previous;
  }
});

test('a malformed blob is rejected', () => {
  assert.throws(() => decryptSecret('not-encrypted-at-all'));
  assert.throws(() => decryptSecret('v2.a.b.c'));
  assert.throws(() => decryptSecret(null));
});

test('secrets report themselves enabled once a key is present', () => {
  assert.equal(secretsEnabled(), true);

  const previous = config.google.encryptionKey;
  config.google.encryptionKey = '';
  try {
    assert.equal(secretsEnabled(), false);
    assert.throws(() => encryptSecret('x'), /not configured/);
  } finally {
    config.google.encryptionKey = previous;
  }
});

// --- configuration ----------------------------------------------------

test('placeholder credentials do not count as a configured client', () => {
  assert.equal(config.google.clientId, 'YOUR_GOOGLE_CLIENT_ID');
  assert.equal(config.google.configured, false);
});

test('the redirect URI points at the calendar callback, not somewhere else', () => {
  assert.match(config.google.redirectUri, /^https?:\/\/.+\/api\/calendar\/oauth\/callback$/);
});

test('the redirect URI falls back to the calendar callback on this port when unset', async () => {
  const saved = process.env.GOOGLE_REDIRECT_URI;
  delete process.env.GOOGLE_REDIRECT_URI;

  try {
    // dotenv only fills variables that are absent, and its module is already loaded,
    // so re-importing config under a fresh URL exercises the built-in default.
    const fresh = await import('../src/config.js?redirect-default');

    assert.equal(
      fresh.config.google.redirectUri,
      `http://localhost:${fresh.config.port}/api/calendar/oauth/callback`,
    );
  } finally {
    if (saved === undefined) delete process.env.GOOGLE_REDIRECT_URI;
    else process.env.GOOGLE_REDIRECT_URI = saved;
  }
});

// --- the consent URL --------------------------------------------------

test(
  'the consent URL asks for offline access so a refresh token comes back',
  asConfigured(() => {
    const url = new URL(buildAuthUrl({ state: 'signed-state-value' }));
    const params = url.searchParams;

    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(params.get('access_type'), 'offline');
    assert.equal(params.get('prompt'), 'consent');
    assert.equal(params.get('response_type'), 'code');
    assert.equal(params.get('state'), 'signed-state-value');
    assert.equal(params.get('redirect_uri'), config.google.redirectUri);
    assert.equal(params.get('client_id'), config.google.clientId);
    assert.match(params.get('scope'), /calendar\.events/);
  }),
);

test('building a consent URL without credentials throws', () => {
  assert.throws(() => buildAuthUrl({ state: 'x' }), /not configured/);
});

// --- talking to Google ------------------------------------------------

test(
  'a failed Google call becomes a 502 carrying Google’s own message',
  asConfigured(async () => {
    respondWith({ ok: false, status: 500, body: { error: { message: 'backend error' } } });

    await assert.rejects(
      () => listEvents({ accessToken: 'token', timeMin: 'a', timeMax: 'b' }),
      (error) => {
        assert.equal(error.status, 502);
        assert.equal(error.googleStatus, 500);
        assert.equal(error.message, 'backend error');
        return true;
      },
    );
  }),
);

test(
  'a rate limit keeps its 429 instead of being flattened to 502',
  asConfigured(async () => {
    respondWith({ ok: false, status: 429, body: { error: { message: 'rate limited' } } });

    await assert.rejects(
      () => listEvents({ accessToken: 'token', timeMin: 'a', timeMax: 'b' }),
      (error) => error.status === 429,
    );
  }),
);

test(
  'an unreachable Google is reported as unreachable, not as a bad response',
  asConfigured(async () => {
    global.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };

    await assert.rejects(
      () => listEvents({ accessToken: 'token', timeMin: 'a', timeMax: 'b' }),
      /unreachable from this server/,
    );
  }),
);

test(
  'events come back trimmed to the fields the portal renders',
  asConfigured(async () => {
    respondWith({
      ok: true,
      status: 200,
      body: {
        items: [
          {
            id: 'evt-1',
            summary: 'Parent meeting',
            location: 'Room 4',
            htmlLink: 'https://calendar.google.com/event?eid=1',
            start: { dateTime: '2026-03-01T09:00:00+05:00' },
            end: { dateTime: '2026-03-01T09:30:00+05:00' },
            etag: 'leaky-internal-field',
          },
        ],
      },
    });

    const [event] = await listEvents({ accessToken: 'token', timeMin: 'a', timeMax: 'b' });

    assert.equal(event.id, 'evt-1');
    assert.equal(event.summary, 'Parent meeting');
    assert.equal(event.allDay, false);
    assert.equal(event.etag, undefined, 'unmapped Google fields must not pass through');
  }),
);

test(
  'an all-day event is marked as such',
  asConfigured(async () => {
    respondWith({
      ok: true,
      status: 200,
      body: { items: [{ id: 'evt-2', summary: 'Holiday', start: { date: '2026-03-02' }, end: { date: '2026-03-03' } }] },
    });

    const [event] = await listEvents({ accessToken: 'token', timeMin: 'a', timeMax: 'b' });

    assert.equal(event.allDay, true);
    assert.equal(event.start, '2026-03-02');
  }),
);

// --- refresh ----------------------------------------------------------

test(
  'a refresh moves the expiry forward and keeps the refresh token',
  asConfigured(async () => {
    respondWith({
      ok: true,
      status: 200,
      body: { access_token: 'fresh-access', expires_in: 3600, scope: 'calendar.events' },
    });

    const refreshed = await refreshAccessToken('the-refresh-token');

    assert.equal(refreshed.accessToken, 'fresh-access');
    assert.equal(refreshed.refreshToken, 'the-refresh-token');
    assert.ok(new Date(refreshed.expiresAt).getTime() > Date.now());
  }),
);

test(
  'a rotated refresh token from Google replaces the stored one',
  asConfigured(async () => {
    respondWith({
      ok: true,
      status: 200,
      body: { access_token: 'fresh-access', refresh_token: 'rotated', expires_in: 3600 },
    });

    const refreshed = await refreshAccessToken('the-old-refresh-token');

    assert.equal(refreshed.refreshToken, 'rotated');
  }),
);
