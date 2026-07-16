/* versione 2.3 */

require('dotenv').config();
console.log('=== BACKEND START ===');
console.log(
  'DATABASE_URL:',
  process.env.DATABASE_URL
    ? process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')
    : 'MISSING'
);
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const pool = require('./db');
const crypto = require('crypto');

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
//INSERIMENTO PATCH PER MULTIUTENTE
const APP_PUBLIC_URL = process.env.APP_PUBLIC_URL || 'https://clsalva.github.io/agenda-todo/';
const ADMIN_SECRET = process.env.ADMIN_SECRET;

function requireAdmin(req, res, next){
  const secret = req.header('x-admin-secret') || req.query.secret;
  if(!ADMIN_SECRET || secret !== ADMIN_SECRET){
    return res.status(401).json({ ok:false, error:'Admin secret non valido' });
  }
  next();
}

function newUserToken(){
  return crypto.randomBytes(24).toString('base64url');
}

app.post('/api/admin/invite', requireAdmin, async (req, res) => {
  try{
    const label = req.body?.label || 'utente';
    const token = newUserToken();

    await pool.query(
      `insert into app_users(token,label) values($1,$2) on conflict(token) do nothing`,
      [token,label]
    );

    await pool.query(
      `insert into sync_state(token,data,updated_at)
       values($1,$2::jsonb,now())
       on conflict(token) do nothing`,
      [token, JSON.stringify({appointments:[], tasks:[]})]
    );

    await pool.query(
      `insert into invites(token,label) values($1,$2)`,
      [token,label]
    );

    const inviteUrl = `${APP_PUBLIC_URL.replace(/\/$/,'')}/?invite=${encodeURIComponent(token)}`;
    res.json({ ok:true, token, inviteUrl });
  }catch(err){
    console.error('Errore creazione invito', err);
    res.status(500).json({ ok:false, error:'Errore creazione invito' });
  }
});

app.get('/api/bootstrap', async (req, res) => {
  const token = req.query.token;
  if(!token) return res.status(400).json({ ok:false, error:'Token mancante' });

  const { rows } = await pool.query('select token from app_users where token=$1', [token]);
  if(rows.length === 0) return res.status(404).json({ ok:false, error:'Invito non valido' });

  await pool.query('update invites set used_at=coalesce(used_at,now()) where token=$1', [token]);

  res.json({
    ok:true,
    config:{
      backendUrl: process.env.PUBLIC_BACKEND_URL || 'https://agenda-push-backend.onrender.com',
      appToken: token,
      publicVapidKey: process.env.PUBLIC_VAPID_KEY
    }
  });
});

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

function allReminderItems(data) {
  const parsed = parseData(data);
  return [
    ...(parsed.appointments || []).map((i) => ({ ...i, kind: 'appuntamento' })),
    ...(parsed.tasks || []).map((i) => ({ ...i, kind: 'task' }))
  ];
}

function parseReminderAt(value) {
  if (!value) return null;
  if (/Z$|[+-]\d{2}:\d{2}$/.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const offsetMinutes = Number(process.env.LOCAL_TZ_OFFSET_MINUTES || 120);
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - offsetMinutes * 60 * 1000);
}

async function sendToSubscription(row, payload) {
  const subscription = typeof row.subscription === 'string' ? JSON.parse(row.subscription) : row.subscription;
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

async function notifyOtherDevices(token, sourceEndpoint) {
  const { rows } = await pool.query(
    'select endpoint, subscription from push_subscriptions where token = $1',
    [token]
  );
  const targets = sourceEndpoint ? rows.filter((r) => r.endpoint !== sourceEndpoint) : rows;
  if (targets.length === 0) return { subscriptions: rows.length, syncPushSent: 0 };

  const payload = JSON.stringify({
    type: 'sync',
    title: 'Agenda aggiornata',
    body: 'Sono disponibili aggiornamenti da un altro dispositivo.',
    url: './index.html',
    tag: 'agenda-sync'
  });
  const results = await Promise.all(targets.map((r) => sendToSubscription(r, payload)));
  return { subscriptions: rows.length, syncPushSent: results.filter((r) => r.ok).length };
}

app.get('/', (req, res) => {
  res.json({
    version: 'TEST-20260714-A',
    ts: new Date().toISOString()
  });
});

app.get('/api/items', requireAuth, async (req, res) => {

  const { rows } = await pool.query(
    'select data, updated_at from sync_state where token = $1',
    [req.token]
  );

  if(rows.length === 0){
    return res.json({
      ok: true,
      data: {
        appointments: [],
        tasks: []
      },
      updatedAt: null
    });
  }

  return res.json({
    ok: true,
    data: rows[0].data,
    updatedAt: rows[0].updated_at
  });
});

app.put('/api/items', requireAuth, async (req, res) => {

  console.log('=== PUT /api/items ===');
console.log('TOKEN:', req.token);
console.log(
  'APPOINTMENTS_RECEIVED:',
  (req.body.appointments || []).map(x => x.title)
);
console.log(
  'TASKS_RECEIVED:',
  (req.body.tasks || []).length
);
  
  const { appointments, tasks } = req.body || {};
  if (!Array.isArray(appointments) || !Array.isArray(tasks)) {
    return res.status(400).json({ ok: false, error: 'appointments e tasks devono essere array' });
  }

  const sourceEndpoint = req.header('x-source-endpoint') || '';
  const client = await pool.connect();
  let changedReminderIds = [];

  try {
    await client.query('begin');
    const { rows } = await client.query('select data from sync_state where token = $1 for update', [req.token]);

    const oldById = new Map(allReminderItems(rows[0]?.data).filter((i) => i.id).map((i) => [i.id, i]));
    const newItems = [...appointments, ...tasks].filter((i) => i && i.id);

    changedReminderIds = newItems
      .filter((item) => {
        const old = oldById.get(item.id);
        return old && (old.reminderAt || '') !== (item.reminderAt || '');
      })
      .map((item) => item.id);

    if (changedReminderIds.length > 0) {
      await client.query(
        'delete from sent_reminders where token = $1 and item_id = any($2::text[])',
        [req.token, changedReminderIds]
      );
    }

    await client.query(
      `insert into sync_state (token, data, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (token) do update set data = $2::jsonb, updated_at = now()`,
      [req.token, JSON.stringify({ appointments, tasks })]
    );

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    console.error('Errore PUT /api/items', err);
    res.status(500).json({ ok: false, error: 'Errore salvataggio dati' });
    return;
  } finally {
    client.release();
  }

  const syncPush = await notifyOtherDevices(req.token, sourceEndpoint);
  res.json({ ok: true, resetSentReminders: changedReminderIds.length, ...syncPush });
});

app.post('/api/subscribe', requireAuth, async (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return res.status(400).json({ ok: false, error: 'Subscription non valida' });
  }
  try {
    await pool.query(
      `insert into push_subscriptions (endpoint, token, subscription)
       values ($1, $2, $3::jsonb)
       on conflict (endpoint) do update set subscription = $3::jsonb, token = $2`,
      [subscription.endpoint, req.token, JSON.stringify(subscription)]
    );
    res.status(201).json({ ok: true, endpoint: subscription.endpoint });
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
  if (!publicVapidKey || !privateVapidKey) return res.status(500).json({ ok: false, error: 'VAPID non configurato' });
  try {
    const { rows } = await pool.query('select endpoint, subscription from push_subscriptions where token = $1', [req.token]);
    const payload = JSON.stringify({ title: req.body?.title || 'Agenda Todo', body: req.body?.body || 'Notifica di prova dal backend.', url: './index.html', tag: 'backend-test' });
    const results = await Promise.all(rows.map((r) => sendToSubscription(r, payload)));
    res.json({ ok: true, subscriptions: rows.length, sent: results.filter((r) => r.ok).length });
  } catch (err) {
    console.error('Errore POST /api/send-test', err);
    res.status(500).json({ ok: false, error: 'Errore invio' });
  }
});

app.get('/api/cron/check-reminders', requireCronSecret, async (req, res) => {
  if (!publicVapidKey || !privateVapidKey) return res.status(500).json({ ok: false, error: 'VAPID non configurato' });

  const debug = req.query.debug === '1';
  const now = Date.now();
  let remindersFound = 0, remindersAlreadySent = 0, remindersWithoutSubscriptions = 0, notificationsSent = 0;
  const details = [];

  try {
    const { rows: states } = await pool.query('select token, data from sync_state');
    for (const stateRow of states) {
      const due = allReminderItems(stateRow.data).filter((item) => {
        const reminderDate = parseReminderAt(item.reminderAt);
        return item.id && reminderDate && reminderDate.getTime() <= now;
      });
      remindersFound += due.length;
      if (due.length === 0) continue;

      const { rows: subs } = await pool.query('select endpoint, subscription from push_subscriptions where token = $1', [stateRow.token]);
      if (subs.length === 0) {
        remindersWithoutSubscriptions += due.length;
        if (debug) details.push({ token: stateRow.token, due: due.length, subscriptions: 0 });
        continue;
      }

      const { rows: already } = await pool.query('select item_id from sent_reminders where token = $1', [stateRow.token]);
      const alreadySet = new Set(already.map((r) => r.item_id));
      const toSend = due.filter((d) => !alreadySet.has(d.id));
      remindersAlreadySent += due.length - toSend.length;

      for (const item of toSend) {
        const payload = JSON.stringify({
          type: 'reminder',
          title: item.title || 'Promemoria',
          body: item.notes || (item.kind === 'appuntamento' ? 'Hai un appuntamento in agenda.' : 'Hai un task da completare.'),
          url: './index.html',
          tag: `reminder-${item.id}`
        });
        const results = await Promise.all(subs.map((s) => sendToSubscription(s, payload)));
        const okCount = results.filter((r) => r.ok).length;
        notificationsSent += okCount;
        if (okCount > 0) {
          await pool.query(
            `insert into sent_reminders (token, item_id, sent_at) values ($1, $2, now()) on conflict do nothing`,
            [stateRow.token, item.id]
          );
        }
        if (debug) details.push({ itemId: item.id, title: item.title, subscriptions: subs.length, sent: okCount });
      }
    }

    res.json({ ok: true, remindersFound, remindersAlreadySent, remindersWithoutSubscriptions, notificationsSent, remindersSent: notificationsSent, ...(debug ? { details } : {}) });
  } catch (err) {
    console.error('Errore GET /api/cron/check-reminders', err);
    res.status(500).json({ ok: false, error: 'Errore controllo reminder' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log('agenda-push-backend v2.4 in ascolto sulla porta', PORT));
