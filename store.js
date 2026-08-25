// ============================================================
// MUTASSO PRO v6.2 — store.js
// Couche de persistance PostgreSQL (Supabase) :
//  - comptes  : registre des associations inscrites
//  - classeurs: le "classeur" JSON de chaque association
//  - fichiers : les PV PDF (base64) — ils survivent aux
//               redéploiements Render
// Les tables sont créées automatiquement au démarrage.
// Si DATABASE_URL est absent, l'application fonctionne en
// mode fichiers locaux (voir sheets.js) — rien à installer.
// ============================================================
const { Pool } = require('pg');
const config = require('./config');

let pool = null;

async function initStore() {
  if (!config.MODE_PG) return { mode: 'fichiers' };
  pool = new Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DB_SSL ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000
  });
  // Tables créées automatiquement (idempotent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS comptes (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      nom TEXT,
      contact TEXT,
      logo TEXT,
      creee_le TEXT
    );
    CREATE TABLE IF NOT EXISTS classeurs (
      compte_id TEXT PRIMARY KEY,
      data JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fichiers (
      compte_id TEXT NOT NULL,
      nom TEXT NOT NULL,
      contenu TEXT NOT NULL,
      PRIMARY KEY (compte_id, nom)
    );
  `);
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM comptes');
  console.log('Base PostgreSQL connectée (' + r.rows[0].n + ' compte(s) enregistré(s)).');
  return { mode: 'postgres' };
}

async function fermerStore() { if (pool) await pool.end().catch(() => {}); }

/* ============ Registre des comptes ============ */
async function pgLireRegistre() {
  const r = await pool.query('SELECT * FROM comptes ORDER BY creee_le');
  return r.rows.map(l => ({
    id: l.id, email: l.email, hash: l.hash, salt: l.salt,
    nom: l.nom || '', contact: l.contact || '', logo: l.logo || '',
    creeLe: l.creee_le || ''
  }));
}

async function pgSauverRegistre(liste) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM comptes');
    for (const e of liste) {
      await client.query(
        'INSERT INTO comptes (id, email, hash, salt, nom, contact, logo, creee_le) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [e.id, e.email, e.hash, e.salt, e.nom || '', e.contact || '', e.logo || '', e.creeLe || '']
      );
    }
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

/* ============ Classeurs (une ligne JSONB par association) ============ */
async function pgLireClasseur(compteId) {
  const r = await pool.query('SELECT data FROM classeurs WHERE compte_id = $1', [compteId]);
  return r.rows.length ? r.rows[0].data : null;
}

async function pgEcrireClasseur(compteId, tables) {
  await pool.query(
    `INSERT INTO classeurs (compte_id, data) VALUES ($1, $2)
     ON CONFLICT (compte_id) DO UPDATE SET data = EXCLUDED.data`,
    [compteId, JSON.stringify(tables)]
  );
}

/* ============ Fichiers (PV PDF en base64) ============ */
async function pgEnregistrerFichier(compteId, nom, base64) {
  await pool.query(
    `INSERT INTO fichiers (compte_id, nom, contenu) VALUES ($1, $2, $3)
     ON CONFLICT (compte_id, nom) DO UPDATE SET contenu = EXCLUDED.contenu`,
    [compteId, nom, base64]
  );
}

async function pgLireFichier(compteId, nom) {
  const r = await pool.query('SELECT contenu FROM fichiers WHERE compte_id = $1 AND nom = $2', [compteId, nom]);
  return r.rows.length ? r.rows[0].contenu : null;
}

module.exports = { initStore, fermerStore, pgLireRegistre, pgSauverRegistre, pgLireClasseur, pgEcrireClasseur, pgEnregistrerFichier, pgLireFichier };
