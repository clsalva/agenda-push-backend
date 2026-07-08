# Copia questi valori nelle "Environment Variables" di Render.
# Non caricare mai un file .env reale su GitHub.

# Connessione al database Postgres di Supabase (Settings -> Database -> Connection string -> URI)
DATABASE_URL=postgres://postgres:PASSWORD@db.xxxxxxxxxxxx.supabase.co:5432/postgres

# Chiavi VAPID: generale UNA VOLTA in locale con:
#   npx web-push generate-vapid-keys
# La publicKey va anche incollata nel frontend (index.html).
PUBLIC_VAPID_KEY=
PRIVATE_VAPID_KEY=
VAPID_SUBJECT=mailto:tuonome@example.com

# Segreto che protegge i tuoi dati. Inventane uno lungo e casuale
# (es. con: openssl rand -hex 24) e usalo IDENTICO nel frontend.
APP_TOKEN=

# Segreto separato, usato solo dal servizio di cron esterno per
# chiamare /api/cron/check-reminders. Anche questo: openssl rand -hex 24
CRON_SECRET=

# Origine autorizzata a chiamare questo backend (la tua PWA su GitHub Pages)
ALLOWED_ORIGIN=https://clsalva.github.io
