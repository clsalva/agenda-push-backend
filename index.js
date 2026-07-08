const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('ATTENZIONE: DATABASE_URL non impostata. Il backend non potrà salvare nulla.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase')
    ? { rejectUnauthorized: false }
    : undefined
});

module.exports = pool;
