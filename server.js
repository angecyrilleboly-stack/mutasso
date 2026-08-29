// ============================================================
// MUTASSO PRO v6.2 — server.js
// Serveur web Express :
//  - sert l'interface (public/)
//  - expose les fonctions backend via POST /api/<fonction>
//  - mode stockage : FICHIERS locaux ou POSTGRESQL (Supabase)
//    selon la variable DATABASE_URL (voir config.js / .env)
// Départ : npm start  →  http://localhost:3000
// ============================================================
const express = require('express');
const path = require('path');
const config = require('./config');
const store = require('./store');
const { flushPersistence } = require('./sheets');
const backend = require('./backend');

const app = express();

// Les PV PDF et logos transitent en base64 dans le corps des requêtes
app.use(express.json({ limit: '60mb' }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Équivalent de doGet() : affiche l'application
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Sonde de santé (utilisée par Render)
app.get('/api/health', (req, res) => res.json({ ok: true, mode: config.MODE_PG ? 'postgres' : 'fichiers', v: 'v63nocache' }));

// PV PDF stockés en base (mode PostgreSQL) — /fichiers/<compte>/<nom>
app.get('/fichiers/:compte/:nom', async (req, res) => {
  try {
    const b64 = await store.pgLireFichier(req.params.compte, req.params.nom);
    if (!b64) return res.status(404).send('Fichier introuvable');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + req.params.nom + '"');
    res.send(Buffer.from(b64, 'base64'));
  } catch (e) {
    res.status(500).send('Erreur de lecture du fichier');
  }
});

// Pont google.script.run -> fonctions du backend (voir public/gas-bridge.js)
// Ces fonctions sont accessibles sans être connecté :
const FNS_PUBLIQUES = new Set(['compteExiste', 'creerCompte', 'connexion', 'debugCompte', 'resetMdp']);
app.post('/api/:fn', async (req, res) => {
  const fn = backend[req.params.fn];
  if (typeof fn !== 'function') {
    return res.status(404).json({ __error: 'Fonction inconnue : ' + req.params.fn });
  }
  if (!FNS_PUBLIQUES.has(req.params.fn)) {
    // Chaque appel travaille sur le classeur de l'association
    // authentifiée : ses données sont isolées des autres comptes.
    const idCompte = await backend.verifierToken(req.get('X-Auth-Token') || '');
    if (!idCompte || !(await backend.activerCompte(idCompte))) {
      return res.status(401).json({ __error: 'Session invalide ou expirée.', __auth: true });
    }
  }
  let args = Array.isArray(req.body) ? req.body
    : (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) ? [req.body]
    : [];
  try {
    const result = await fn(...args);
    // Persiste les modifications en base (mode PostgreSQL)
    await flushPersistence();
    res.json(result === undefined ? null : result);
  } catch (e) {
    res.status(500).json({ __error: String((e && e.message) || e) });
  }
});

// Départ : connexion à la base si configurée, puis écoute

// TEMPORAIRE
app.get('/api/debug-login', async (req, res) => {
  try {
    const crypto = require('crypto');
    const r = await store.pgLireRegistre();
    const c = r.find(x => x.email === 'angecyrilleboly@gmail.com');
    if (!c) return res.json({err:'not found', n: r.length, emails: r.map(x=>x.email)});
    const h = crypto.scryptSync(String('Cyrille@edi20'), c.salt, 32).toString('hex');
    res.json({ salt_len: c.salt.length, salt_pfx: c.salt.substring(0,16), db_pfx: c.hash.substring(0,16), calc_pfx: h.substring(0,16), match: h === c.hash, node: process.version });
  } catch(e) { res.json({err: e.message}); }
});


app.get('/api/debug-lire', async (req, res) => {
  try {
    const { lireRegistre } = require('./sheets');
    const r = await lireRegistre();
    const c = r.find(x => x.email === 'angecyrilleboly@gmail.com');
    if (!c) return res.json({err:'not found via lireRegistre', n: r.length, emails: r.map(x=>x.email)});
    res.json({ found: true, salt_pfx: c.salt.substring(0,16), hash_pfx: c.hash.substring(0,16) });
  } catch(e) { res.json({err: e.message, stack: e.stack}); }
});
(async () => {
  try {
    const etat = await store.initStore();
    console.log('MUTASSO PRO v6.2 — stockage : ' + etat.mode);
    app.listen(config.PORT, '0.0.0.0', () => {
      console.log('MUTASSO PRO v6.2 -> http://localhost:' + config.PORT);
    });
  } catch (e) {
    console.error('Impossible de démarrer (base de données ?) :', e.message);
    process.exit(1);
  }
})();
