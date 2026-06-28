# Backend push per Agenda Todo PWA

Backend Node.js minimale, pensato per Railway, che gestisce:
- chiavi VAPID da variabili d'ambiente
- endpoint `/subscribe` per salvare le subscription del browser
- endpoint `/send` per inviare notifiche Web Push

## File principali
- `package.json`: dipendenze e script `npm start`
- `index.js`: server Express + web-push
- `.gitignore`: ignora `node_modules` e `.env`

## Variabili d'ambiente su Railway
- `PUBLIC_VAPID_KEY`
- `PRIVATE_VAPID_KEY`
- `PORT` (Railway di solito la imposta da solo, ma nel codice viene letta)

## Uso locale

```bash
npm install
npm start
```

## Test invio push

```bash
curl -X POST https://TUO-DOMINIO-RAILWAY/send \
  -H "Content-Type: application/json" \
  -d '{"title":"Promemoria Agenda","body":"Test push da Railway"}'
```