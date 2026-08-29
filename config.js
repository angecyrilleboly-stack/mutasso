// ============================================================
// MUTASSO PRO v6.2 — config.js
// Configuration centrale : lit .env (si présent) puis les
// variables d'environnement (Render/production).
// ============================================================
const fs = require('fs');
const path = require('path');

// Charge un fichier .env local sans dépendance externe
const FICHIER_ENV = path.join(__dirname, '.env');
if (fs.existsSync(FICHIER_ENV)) {
  fs.readFileSync(FICHIER_ENV, 'utf8').split(/\r?\n/).forEach(ligne => {
    const m = ligne.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  });
}

const config = {
  PORT: Number(process.env.PORT) || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  // PostgreSQL (Supabase). Si absent -> mode fichiers locaux (data/)
  DATABASE_URL: process.env.DATABASE_URL || '',
  DB_SSL: String(process.env.DB_SSL || 'true') === 'true',
  // Clé Gemini : variable d'environnement en production
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  // Notifications push (Web Push / VAPID)
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:contact@mutasso.app'
};

config.MODE_PG = !!config.DATABASE_URL;

module.exports = config;
