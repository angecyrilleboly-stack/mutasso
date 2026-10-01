// ============================================================
// MUTASSO PRO v6.2 — api/index.js
// Point d'entrée Vercel (serverless) : expose l'application
// Express de server.js. Sur Vercel, server.js ne fait PAS
// d'app.listen (process.env.VERCEL) — la plateforme gère le
// serveur HTTP et appelle ce module par requête.
// ============================================================
const app = require('../server');
module.exports = app;
