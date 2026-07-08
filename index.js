require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const pool = require('./db');

const app = express();
app.use(express.json());

// --- CORS: solo l'origine della PWA puo' chiamare questo backend ---
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

// --- VAPID: chiavi per firmare le push ---
const publicVapidKey = process.env.PUBLIC_VAPID_KEY;
const privateVapidKey = process.env.PRIVATE_VAPID_KEY;

if (publicVapidKey && privateVapidKey) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:agenda-todo@example.com',
    publicVapidKey,
    privateVapidKey
  );
} else {
  console.warn('ATTENZIONE: PUBLIC_VAPID_KEY o PRIVATE_VAPID_KEY non impostate. Le push non funzioneranno.');
}

// --- APP_TOKEN: segreto condiviso che protegge i tuoi dati ---
const APP_TOKEN = process.env.APP_TOKEN;
if (!APP_TOKEN) {
  console.warn('ATTENZIONE: APP_TOKEN non impostato. Il backend rifiuterà tutte le richieste autenticate.');
}

function requireAuth(req, res, next) {
  const token = req.header('x-app-token');
  if (!APP_TOKEN || !token || token !== APP_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Token mancante o non valido' });
  }
  req.token = token;
  next();
}

// --- Health check ---
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'agenda-push-backend', version: '2.0.0' });
});

// --- Sincronizzazione dati (appuntamenti + task) ---

app.get('/api/items', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'select data, updated_at from sync_state where token = $1',
      [req.token]
    );
    if (rows.length === 0) {
      return res.json({ ok: true, data: { appointments: [], tasks: [] }, updatedAt: null });
    }
    res.json({ ok: true, data: rows[0].data, updatedAt: rows[0].updated_at });
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
       values ($1, $2, now())
       on conflict (token) do update set data = $2, updated_at = now()`,
      [req.token, JSON.stringify({ appointments, tasks })]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Errore PUT /api/items', err);
    res.status(500).json({ ok: false, error: 'Errore salvataggio dati' });
  }
});

// --- Subscription push ---

app.post('/api/subscribe', requireAuth, async (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ ok: false, error: 'Subscription non valida' });
  }
  try {
    await pool.query(
      `insert into push_subscriptions (endpoint, token, subscription)
       values ($1, $2, $3)
       on conflict (endpoint) do update set subscription = $3, token = $2`,
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
    await pool.query('delete from push_subscriptions where endpoint = $1', [endpoint]);
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
      'select subscription from push_subscriptions where token = $1',
      [req.token]
    );
    const payload = JSON.stringify({
      title: req.body?.title || 'Agenda Todo',
      body: req.body?.body || 'Notifica di prova dal backend.',
      url: './index.html'
    });
    await Promise.all(
      rows.map((r) =>
        webpush.sendNotification(r.subscription, payload).catch((err) => {
          console.error('Errore invio push:', err.message);
        })
      )
    );
    res.json({ ok: true, sent: rows.length });
  } catch (err) {
    console.error('Errore POST /api/send-test', err);
    res.status(500).json({ ok: false, error: 'Errore invio' });
  }
});

// --- Scheduler dei reminder ---
app.get('/api/cron/check-reminders', async (req, res) => {
  const secret = req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Secret non valido' });
  }
  if (!publicVapidKey || !privateVapidKey) {
    return res.status(500).json({ ok: false, error: 'VAPID non configurato' });
  }

  try {
    const { rows: states } = await pool.query('select token, data from sync_state');
    const now = Date.now();
    let totalSent = 0;

    for (const state of states) {
      const items = [
        ...(state.data.appointments || []).map((i) => ({ ...i, kind: 'appuntamento' })),
        ...(state.data.tasks || []).map((i) => ({ ...i, kind: 'task' }))
      ];

      const due = items.filter((item) => {
        if (!item.reminderAt || !item.id) return false;
        const ts = new Date(item.reminderAt).getTime();
        return !Number.isNaN(ts) && ts <= now;
      });

      if (due.length === 0) continue;

      const { rows: already } = await pool.query(
        'select item_id from sent_reminders where token = $1',
        [state.token]
      );
      const alreadySet = new Set(already.map((r) => r.item_id));
      const toSend = due.filter((d) => !alreadySet.has(d.id));
      if (toSend.length === 0) continue;

      const { rows: subs } = await pool.query(
        'select subscription from push_subscriptions where token = $1',
        [state.token]
      );

      for (const item of toSend) {
        const payload = JSON.stringify({
          title: item.title || 'Promemoria',
          body: item.notes || (item.kind === 'appuntamento' ? 'Hai un appuntamento in agenda.' : 'Hai un task da completare.'),
          url: './index.html',
          tag: `reminder-${item.id}`
        });
        await Promise.all(
          subs.map((s) =>
            webpush.sendNotification(s.subscription, payload).catch((err) => {
              console.error('Errore invio push reminder:', err.message);
              if (err.statusCode === 404 || err.statusCode === 410) {
                pool.query('delete from push_subscriptions where subscription = $1', [
                  JSON.stringify(s.subscription)
                ]).catch(() => {});
              }
            })
          )
        );
        await pool.query(
          'insert into sent_reminders (item_id, token) values ($1, $2) on conflict (item_id) do nothing',
          [item.id, state.token]
        );
        totalSent += 1;
      }
    }

    res.json({ ok: true, remindersSent: totalSent });
  } catch (err) {
    console.error('Errore GET /api/cron/check-reminders', err);
    res.status(500).json({ ok: false, error: 'Errore controllo reminder' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log('agenda-push-backend v2 in ascolto sulla porta', PORT);
});
