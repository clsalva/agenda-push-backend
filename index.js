require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const pool = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));

const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

const publicVapidKey = process.env.PUBLIC_VAPID_KEY;
const privateVapidKey = process.env.PRIVATE_VAPID_KEY;

if (publicVapidKey && privateVapidKey) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:agenda-todo@example.com',
    publicVapidKey,
    privateVapidKey
  );
} else {
  console.warn('ATTENZIONE: VAPID non configurato. Le push remote non funzioneranno.');
}

const APP_TOKEN = process.env.APP_TOKEN;
function requireAuth(req, res, next) {
  const token = req.header('x-app-token');
  if (!APP_TOKEN || !token || token !== APP_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Token mancante o non valido' });
  }
  req.token = token;
  next();
}

function requireCronSecret(req, res, next) {
  const secret = req.query.secret || req.header('x-cron-secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Secret non valido' });
  }
  next();
}

function parseData(data) {
  if (!data) return { appointments: [], tasks: [] };
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return { appointments: [], tasks: [] }; }
  }
  return data;
}

function parseReminderAt(value) {
  if (!value) return null;
  // OK: formato UTC o con offset, es. 2026-07-09T15:30:00.000Z oppure +02:00
  if (/Z$|[+-]\d{2}:\d{2}$/.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Compatibilita': vecchi valori datetime-local senza timezone.
  // Nota: su Render il timezone e' spesso UTC. Per evitare falsi ritardi,
  // interpreta il valore come orario locale Europa/Roma approssimato tramite offset configurabile.
  const offsetMinutes = Number(process.env.LOCAL_TZ_OFFSET_MINUTES || 120);
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - offsetMinutes * 60 * 1000);
}

async function sendToSubscription(row, payload) {
  const subscription = typeof row.subscription === 'string'
    ? JSON.parse(row.subscription)
    : row.subscription;

  try {
    await webpush.sendNotification(subscription, payload);
    return { ok: true };
  } catch (err) {
    console.error('Errore invio push:', err.statusCode, err.message);
    if (err.statusCode === 404 || err.statusCode === 410) {
      await pool.query('delete from push_subscriptions where endpoint = $1', [row.endpoint]);
    }
    return { ok: false, statusCode: err.statusCode, message: err.message };
  }
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'agenda-push-backend', version: '2.1.0' });
});

app.get('/api/items', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'select data, updated_at from sync_state where token = $1',
      [req.token]
    );
    if (rows.length === 0) {
      return res.json({ ok: true, data: { appointments: [], tasks: [] }, updatedAt: null });
    }
    res.json({ ok: true, data: parseData(rows[0].data), updatedAt: rows[0].updated_at });
  } catch (err) {
    console.error('Errore GET /api/items', err);
    res.status(500).json({ ok: false, error: 'Errore lettura dati' });
  }
});

app.put('/api/items', requireAuth, async (req, res) => {
  const { appointments, tasks } = req.body || {};
  if (!Array.isArray(appointments) || !Array.isArray(tasks)) {
    return res.status(400).json({ ok: false, error: 'appointments e tasks devono essere array' });
  }
  try {
    await pool.query(
      `insert into sync_state (token, data, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (token) do update set data = $2::jsonb, updated_at = now()`,
      [req.token, JSON.stringify({ appointments, tasks })]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Errore PUT /api/items', err);
    res.status(500).json({ ok: false, error: 'Errore salvataggio dati' });
  }
});

app.post('/api/subscribe', requireAuth, async (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return res.status(400).json({ ok: false, error: 'Subscription non valida' });
  }
  try {
    await pool.query(
      `insert into push_subscriptions (endpoint, token, subscription, updated_at)
       values ($1, $2, $3::jsonb, now())
       on conflict (endpoint) do update set subscription = $3::jsonb, token = $2, updated_at = now()`,
      [subscription.endpoint, req.token, JSON.stringify(subscription)]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Errore POST /api/subscribe', err);
    res.status(500).json({ ok: false, error: 'Errore salvataggio subscription' });
  }
});

app.post('/api/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ ok: false, error: 'endpoint mancante' });
  try {
    await pool.query('delete from push_subscriptions where endpoint = $1 and token = $2', [endpoint, req.token]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Errore POST /api/unsubscribe', err);
    res.status(500).json({ ok: false, error: 'Errore rimozione subscription' });
  }
});

app.post('/api/send-test', requireAuth, async (req, res) => {
  if (!publicVapidKey || !privateVapidKey) {
    return res.status(500).json({ ok: false, error: 'VAPID non configurato' });
  }
  try {
    const { rows } = await pool.query(
      'select endpoint, subscription from push_subscriptions where token = $1',
      [req.token]
    );
    const payload = JSON.stringify({
      title: req.body?.title || 'Agenda Todo',
      body: req.body?.body || 'Notifica di prova dal backend.',
      url: './index.html',
      tag: 'backend-test'
    });
    const results = await Promise.all(rows.map((r) => sendToSubscription(r, payload)));
    res.json({ ok: true, subscriptions: rows.length, sent: results.filter((r) => r.ok).length });
  } catch (err) {
    console.error('Errore POST /api/send-test', err);
    res.status(500).json({ ok: false, error: 'Errore invio' });
  }
});

app.get('/api/cron/check-reminders', requireCronSecret, async (req, res) => {
  if (!publicVapidKey || !privateVapidKey) {
    return res.status(500).json({ ok: false, error: 'VAPID non configurato' });
  }

  const debug = req.query.debug === '1';
  const now = Date.now();
  let remindersFound = 0;
  let remindersAlreadySent = 0;
  let remindersWithoutSubscriptions = 0;
  let notificationsSent = 0;
  const details = [];

  try {
    const { rows: states } = await pool.query('select token, data from sync_state');

    for (const stateRow of states) {
      const data = parseData(stateRow.data);
      const items = [
        ...(data.appointments || []).map((i) => ({ ...i, kind: 'appuntamento' })),
        ...(data.tasks || []).map((i) => ({ ...i, kind: 'task' }))
      ];

      const due = items.filter((item) => {
        const reminderDate = parseReminderAt(item.reminderAt);
        return item.id && reminderDate && reminderDate.getTime() <= now;
      });
      remindersFound += due.length;

      if (due.length === 0) continue;

      const { rows: subs } = await pool.query(
        'select endpoint, subscription from push_subscriptions where token = $1',
        [stateRow.token]
      );

      if (subs.length === 0) {
        remindersWithoutSubscriptions += due.length;
        if (debug) details.push({ token: stateRow.token, due: due.length, subscriptions: 0 });
        continue;
      }

      const { rows: already } = await pool.query(
        'select item_id from sent_reminders where token = $1',
        [stateRow.token]
      );
      const alreadySet = new Set(already.map((r) => r.item_id));
      const toSend = due.filter((d) => !alreadySet.has(d.id));
      remindersAlreadySent += due.length - toSend.length;

      for (const item of toSend) {
        const payload = JSON.stringify({
          title: item.title || 'Promemoria',
          body: item.notes || (item.kind === 'appuntamento' ? 'Hai un appuntamento in agenda.' : 'Hai un task da completare.'),
          url: './index.html',
          tag: `reminder-${item.id}`
        });

        const results = await Promise.all(subs.map((s) => sendToSubscription(s, payload)));
        const okCount = results.filter((r) => r.ok).length;
        notificationsSent += okCount;

        // Marca come inviato solo se almeno una push e' partita davvero.
        if (okCount > 0) {
          await pool.query(
            `insert into sent_reminders (token, item_id, sent_at)
             values ($1, $2, now())
             on conflict (token, item_id) do nothing`,
            [stateRow.token, item.id]
          );
        }

        if (debug) details.push({ itemId: item.id, title: item.title, subscriptions: subs.length, sent: okCount });
      }
    }

    res.json({
      ok: true,
      remindersFound,
      remindersAlreadySent,
      remindersWithoutSubscriptions,
      notificationsSent,
      remindersSent: notificationsSent,
      ...(debug ? { details } : {})
    });
  } catch (err) {
    console.error('Errore GET /api/cron/check-reminders', err);
    res.status(500).json({ ok: false, error: 'Errore controllo reminder' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log('agenda-push-backend v2.1 in ascolto sulla porta', PORT);
});
