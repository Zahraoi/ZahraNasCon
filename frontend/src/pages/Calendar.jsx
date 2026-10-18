import {
  CalendarDays,
  CalendarPlus,
  ExternalLink,
  Link2,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Unlink,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import AsyncSection from '../components/AsyncSection.jsx';
import { useAuth } from '../context/authContext.js';
import { useToast } from '../context/toastContext.js';
import useApiResource from '../hooks/useApiResource.js';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';

const LOOKAHEAD_DAYS = 30;

/** `datetime-local` speaks local wall-clock time, which is what the form shows. */
function toLocalInput(date) {
  const pad = (value) => String(value).padStart(2, '0');

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** The next full hour, an hour long — somewhere sensible to start from. */
function defaultWindow() {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  start.setMinutes(0, 0, 0);

  return {
    start: toLocalInput(start),
    end: toLocalInput(new Date(start.getTime() + 60 * 60 * 1000)),
  };
}

export default function Calendar() {
  const { token } = useAuth();
  const { showToast } = useToast();

  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => ({ ...defaultWindow(), summary: '', description: '' }));

  const load = useCallback(async () => {
    const status = await api.calendarStatus(token);

    if (!status.connected) return { status, events: [] };

    const result = await api.calendarEvents(token, LOOKAHEAD_DAYS);
    return { status, events: result.events ?? [] };
  }, [token]);

  const { data, error, loading, reload } = useApiResource(load);

  const status = data?.status ?? null;
  const events = data?.events ?? [];
  const connected = Boolean(status?.connected);

  // Consent bounces the browser back here with the outcome in the query string.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get('connected');
    const failure = params.get('error');

    if (!linked && !failure) return;

    if (linked) {
      showToast({
        tone: 'success',
        title: 'Google Calendar connected',
        message: 'Your calendar is now linked to this account.',
      });
    } else {
      showToast({ tone: 'error', title: 'Could not connect Google Calendar', message: failure });
    }

    window.history.replaceState({}, '', window.location.pathname);
    reload();
  }, [reload, showToast]);

  async function connect() {
    setBusy(true);

    try {
      const { url } = await api.calendarConnect(token);
      window.location.href = url;
    } catch (connectError) {
      showToast({
        tone: 'error',
        title: 'Could not start the connection',
        message: connectError.message,
      });
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);

    try {
      await api.calendarDisconnect(token);
      showToast({
        tone: 'info',
        title: 'Google Calendar disconnected',
        message: 'Access was revoked and the stored tokens were removed.',
      });
      reload();
    } catch (disconnectError) {
      showToast({ tone: 'error', title: 'Could not disconnect', message: disconnectError.message });
    } finally {
      setBusy(false);
    }
  }

  async function addEvent(event) {
    event.preventDefault();
    setSaving(true);

    try {
      const created = await api.calendarCreateEvent(token, {
        summary: form.summary,
        description: form.description,
        start: new Date(form.start).toISOString(),
        end: new Date(form.end).toISOString(),
      });

      showToast({ tone: 'success', title: 'Event created', message: created.event.summary });
      setForm({ ...defaultWindow(), summary: '', description: '' });
      reload();
    } catch (createError) {
      showToast({ tone: 'error', title: 'Could not create the event', message: createError.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Google Calendar</h1>
          <p>Connect your own Google account to read and create events from the portal.</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={reload}>
          <RefreshCw size={14} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <p className="alert alert--info" style={{ marginBottom: '1.5rem' }}>
        <ShieldCheck size={15} aria-hidden="true" />
        Tokens are encrypted before they are written to disk and never leave the server.
        Events are read from and written to{' '}
        <strong>{status?.connection?.calendarId || 'your primary calendar'}</strong> — Calendar
        has no sandbox, so changes are real.
      </p>

      <AsyncSection
        loading={loading}
        error={error}
        onRetry={reload}
        shape="cards"
        count={2}
        label="Loading your Google Calendar connection"
        errorTitle="We could not load the calendar integration"
      >
        <section className="card cal-panel">
          <div className="pay-panel__head">
            <div>
              <span className="label-micro">Connection</span>
              <h3 style={{ margin: '0.25rem 0 0' }}>
                {connected ? status.connection?.email || 'Connected' : 'Not connected'}
              </h3>
            </div>
            <span className={`pill ${connected ? 'pill--done' : 'pill--neutral'}`}>
              {connected ? 'Connected' : 'Not connected'}
            </span>
          </div>

          {!status?.ready ? (
            <p className="alert alert--error" style={{ marginTop: '0.75rem' }}>
              {status?.problem ?? 'The integration is not configured on the server.'}
            </p>
          ) : connected ? (
            <>
              <div className="cal-facts">
                <div className="pay-cell">
                  <span className="label-micro">Account</span>
                  <strong className="pay-cell__value">{status.connection?.email || '—'}</strong>
                </div>

                <div className="pay-cell">
                  <span className="label-micro">Calendar</span>
                  <strong className="pay-cell__value">
                    {status.connection?.calendarId || 'primary'}
                  </strong>
                </div>

                <div className="pay-cell">
                  <span className="label-micro">Time zone</span>
                  <strong className="pay-cell__value">{status.connection?.timeZone || '—'}</strong>
                </div>

                <div className="pay-cell">
                  <span className="label-micro">Access expires</span>
                  <strong className="pay-cell__value">
                    {formatDateTime(status.connection?.expiresAt)}
                  </strong>
                  <span className="hint">Refreshed automatically</span>
                </div>
              </div>

              <div className="btn-row" style={{ marginTop: '1rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={disconnect}
                  disabled={busy}
                >
                  <Unlink size={15} aria-hidden="true" />
                  {busy ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
            </>
          ) : (
            <div className="btn-row" style={{ marginTop: '0.75rem' }}>
              <button type="button" className="btn btn-primary" onClick={connect} disabled={busy}>
                <Link2 size={15} aria-hidden="true" />
                {busy ? 'Opening Google…' : 'Connect Google Calendar'}
              </button>
              <span className="hint" style={{ alignSelf: 'center' }}>
                You will be asked to approve calendar access.
              </span>
            </div>
          )}
        </section>

        {connected ? (
          <section className="dash-section">
            <h2 className="dash-section__title">
              <CalendarPlus size={17} aria-hidden="true" />
              Add an event
            </h2>

            <form className="card cal-form" onSubmit={addEvent}>
              <div className="field">
                <label htmlFor="cal-title">Title</label>
                <input
                  id="cal-title"
                  className="input"
                  type="text"
                  value={form.summary}
                  maxLength={120}
                  required
                  placeholder="Parent–teacher meeting"
                  onChange={(event) => setForm({ ...form, summary: event.target.value })}
                />
              </div>

              <div className="cal-form__row">
                <div className="field">
                  <label htmlFor="cal-start">Starts</label>
                  <input
                    id="cal-start"
                    className="input"
                    type="datetime-local"
                    value={form.start}
                    required
                    onChange={(event) => setForm({ ...form, start: event.target.value })}
                  />
                </div>

                <div className="field">
                  <label htmlFor="cal-end">Ends</label>
                  <input
                    id="cal-end"
                    className="input"
                    type="datetime-local"
                    value={form.end}
                    required
                    onChange={(event) => setForm({ ...form, end: event.target.value })}
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="cal-notes">Notes</label>
                <textarea
                  id="cal-notes"
                  className="textarea"
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </div>

              <div className="btn-row">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  <CalendarPlus size={15} aria-hidden="true" />
                  {saving ? 'Creating…' : 'Create event'}
                </button>
                <span className="hint" style={{ alignSelf: 'center' }}>
                  Written straight to Google Calendar.
                </span>
              </div>
            </form>
          </section>
        ) : null}

        {connected ? (
          <section className="dash-section">
            <h2 className="dash-section__title">
              <CalendarDays size={17} aria-hidden="true" />
              Next {LOOKAHEAD_DAYS} days
            </h2>

            {events.length === 0 ? (
              <p className="hint">Nothing scheduled.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Event</th>
                      <th scope="col">Starts</th>
                      <th scope="col">Ends</th>
                      <th scope="col">Where</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((entry) => (
                      <tr key={entry.id}>
                        <th scope="row">
                          {entry.htmlLink ? (
                            <a
                              className="cal-event-link"
                              href={entry.htmlLink}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {entry.summary}
                              <ExternalLink size={12} aria-hidden="true" />
                            </a>
                          ) : (
                            entry.summary
                          )}
                        </th>
                        <td>{entry.allDay ? 'All day' : formatDateTime(entry.start)}</td>
                        <td>{entry.allDay ? '—' : formatDateTime(entry.end)}</td>
                        <td>
                          {entry.location ? (
                            <>
                              <MapPin size={12} aria-hidden="true" /> {entry.location}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}
      </AsyncSection>
    </>
  );
}
