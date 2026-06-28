require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const webpush = require('web-push');

const app = express();

// Middleware base
app.use(cors());
app.use(bodyParser.json());

// Chiavi VAPID da variabili d'ambiente
const publicVapidKey = process.env.PUBLIC_VAPID_KEY;
const privateVapidKey = process.env.PRIVATE_VAPID_KEY;

if (!publicVapidKey || !privateVapidKey) {
  console.warn(
    'ATTENZIONE: PUBLIC_VAPID_KEY o PRIVATE_VAPID_KEY non impostate. Il backend non potrà inviare push.'
  );
}

if (publicVapidKey && privateVapidKey) {
  webpush.setVapidDetails(
    'mailto:agenda-todo@example.com',
    publicVapidKey,
    privateVapidKey
  );
}

// Storage in memoria delle subscription (solo per prova)
let subscriptions = [];

// Health check
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'agenda-push-backend',
    subscriptions: subscriptions.length
  });
});

// Salva una subscription dal browser
app.post('/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ ok: false, error: 'Subscription non valida' });
  }

  const exists = subscriptions.some(
    (sub) => sub.endpoint === subscription.endpoint
  );
  if (!exists) {
    subscriptions.push(subscription);
    console.log('Nuova subscription salvata:', subscription.endpoint);
  }

  res
    .status(201)
    .json({ ok: true, message: 'Subscription salvata', total: subscriptions.length });
});

// Invio push a tutte le subscription
app.post('/send', async (req, res) => {
  if (!publicVapidKey || !privateVapidKey) {
    return res.status(500).json({ ok: false, error: 'VAPID non configurato' });
  }

  const title = req.body.title || 'Agenda Todo';
  const body = req.body.body || 'Nuovo promemoria dalla tua PWA.';
  const url =
    req.body.url || 'https://clsalva.github.io/agenda-todo/';

  const payload = JSON.stringify({ title, body, url });

  console.log('Invio push a', subscriptions.length, 'subscription');

  try {
    await Promise.all(
      subscriptions.map((sub) =>
        webpush.sendNotification(sub, payload).catch((err) => {
          console.error('Errore push verso', sub.endpoint, err.message);
        })
      )
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Errore generale invio push', err);
    res.status(500).json({ ok: false, error: 'Invio push fallito' });
  }
});

// Porta: Railway imposta process.env.PORT
const PORT = process.env.PORT || 3000;

// IMPORTANTE: bind su 0.0.0.0 per Railway
app.listen(PORT, '0.0.0.0', () => {
  console.log('agenda-push-backend in ascolto sulla porta', PORT);
});