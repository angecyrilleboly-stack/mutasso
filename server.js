// ============================================================
// MUTASSO PRO v6.2 — server.js
// Serveur web Express :
//  - sert l'interface (public/)
//  - expose les fonctions backend via POST /api/<fonction>
//  - mode stockage : FICHIERS locaux ou POSTGRESQL (Supabase)
//    selon la variable DATABASE_URL (voir config.js / .env)
// Sécurité & observabilité :
//  - requestId unique par requête (propagé via X-Request-Id)
//  - middleware de logging : méthode, URL, statut, durée, utilisateur
//  - handler global d'erreurs : JSON cohérent, aucune stack trace
//    en production, alerte monitoring sur les erreurs non attendues
//  - health check avec test de base de données
// Départ : npm start  →  http://localhost:3000
// ============================================================
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const store = require('./store');
const { flushPersistence } = require('./sheets');
const backend = require('./backend');
const { erreurs, AppError } = require('./errors');
const { niveaux: log, definirContexte, envoyerMonitoring } = require('./logger');

const app = express();

// Les PV PDF et logos transitent en base64 dans le corps des requêtes
app.use(express.json({ limit: '60mb' }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// En-têtes de sécurité de base
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ---- Observabilité : requestId + contexte + journal de requête ----
app.use((req, res, next) => {
  req.id = (req.get('X-Request-Id') || 'req_' + crypto.randomUUID()).slice(0, 64);
  res.setHeader('X-Request-Id', req.id);
  req.debut = Date.now();
  req.utilisateur = null; // renseigné après authentification
  definirContexte({ request: { id: req.id, method: req.method, url: req.originalUrl } });
  res.on('finish', () => {
    const dureeMs = Date.now() - req.debut;
    const statut = res.statusCode;
    const silence = req.path === '/api/health' || req.path === '/health' || !req.path.startsWith('/api');
    const champs = { response: { statut, dureeMs }, utilisateur: req.utilisateur };
    // Requête lente (> 5 s) : niveau warn, sinon selon statut
    if (dureeMs > 5000) log.warn('Requête lente', champs);
    else if (statut >= 500) log.error('Requête en erreur 5xx', champs);
    else if (!silence) log.info('Requête traitée', champs);
    else log.debug('Requête traitée', champs);
    definirContexte({});
  });
  next();
});

// Équivalent de doGet() : affiche l'application
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- Health check (avec test de base de données) ----
async function sondeSante(req, res) {
  const etat = { ok: true, mode: config.MODE_PG ? 'postgres' : 'fichiers', uptimeS: Math.round(process.uptime()) };
  if (config.MODE_PG) {
    try {
      await store.pingBdd();
      etat.db = 'up';
    } catch (e) {
      etat.db = 'down';
      log.error('Health check : base de données injoignable', { error: { message: e.message } });
    }
  } else {
    etat.db = 'n/a';
  }
  res.json(etat);
}
app.get('/health', sondeSante);
app.get('/api/health', sondeSante);

// PV PDF stockés en base (mode PostgreSQL) — /fichiers/<compte>/<nom>
app.get('/fichiers/:compte/:nom', async (req, res) => {
  try {
    const b64 = await store.pgLireFichier(req.params.compte, req.params.nom);
    if (!b64) return res.status(404).send('Fichier introuvable');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + req.params.nom + '"');
    res.send(Buffer.from(b64, 'base64'));
  } catch (e) {
    repondreErreur(req, res, erreurs.interne(e, 'Erreur de lecture du fichier'));
  }
});

// ---- Réponse d'erreur cohérente (toutes les routes API) ----
function repondreErreur(req, res, err) {
  const appErr = err instanceof AppError ? err : erreurs.interne(err);
  if (!appErr.isOperational) {
    envoyerMonitoring(appErr, {
      request: { id: req.id, method: req.method, url: req.originalUrl },
      utilisateur: req.utilisateur,
      cause: appErr.cause ? { message: appErr.cause.message, stack: appErr.cause.stack } : undefined
    });
    log.error('Erreur non opérationnelle', {
      error: { code: appErr.code, message: appErr.message },
      cause: appErr.cause ? { message: appErr.cause.message, stack: appErr.cause.stack } : undefined
    });
  } else {
    log.info('Erreur opérationnelle', { error: { code: appErr.code, message: appErr.message }, statut: appErr.statusCode });
  }
  const corps = {
    __error: config.NODE_ENV === 'production' && !appErr.isOperational
      ? 'Erreur interne du serveur.'           // aucun détail interne en production
      : appErr.message,
    error: { code: appErr.code, message: config.NODE_ENV === 'production' && !appErr.isOperational ? 'Erreur interne du serveur.' : appErr.message },
    requestId: req.id,
    ...appErr.details
  };
  res.status(appErr.statusCode).json(corps);
}

// Pont google.script.run -> fonctions du backend (voir public/gas-bridge.js)
// Ces fonctions sont accessibles sans être connecté :
const FNS_PUBLIQUES = new Set(['compteExiste', 'creerCompte', 'connexion']);
// Session MEMBRE (espace personnel en lecture seule) : ces
// fonctions de gestion lui sont interdites côté serveur.
const FNS_RESERVEES_ADMIN = new Set([
  'ajouterMembre', 'modifierMembre', 'genererMdpMembre', 'supprimerAccesMembre',
  'enregistrerMensuel', 'enregistrerExcep', 'enregistrerDepense',
  'majMontantMensualite', 'enregistrerTypeMensuel', 'supprimerTypeMensuel',
  'enregistrerTypeExcep', 'supprimerTypeExcep',
  'nommerMembre', 'enregistrerPoste', 'supprimerPoste',
  'enregistrerReunion', 'supprimerReunion', 'uploadFileToDrive',
  'majIdentite', 'majMotDePasse', 'saveAssocInfos'
]);
app.post('/api/:fn', async (req, res) => {
  const fn = backend[req.params.fn];
  if (typeof fn !== 'function') {
    return repondreErreur(req, res, erreurs.introuvable('Fonction inconnue : ' + req.params.fn));
  }
  if (!FNS_PUBLIQUES.has(req.params.fn)) {
    // Chaque appel travaille sur le classeur de l'association
    // authentifiée : ses données sont isolées des autres comptes.
    // Un jeton MEMBRE ouvre le même classeur, mais en lecture
    // seule (accesMembre) et filtré sur ses propres cotisations.
    const session = await backend.verifierSession(req.get('X-Auth-Token') || '');
    if (!session || !(await backend.activerCompte(session.idCompte, session.idMembre))) {
      return repondreErreur(req, res, erreurs.nonAutorise());
    }
    req.utilisateur = { userId: session.idCompte, role: session.role, membreId: session.idMembre };
    definirContexte({ request: { id: req.id, method: req.method, url: req.originalUrl }, ...req.utilisateur });
    if (session.role === 'membre' && FNS_RESERVEES_ADMIN.has(req.params.fn)) {
      return repondreErreur(req, res, erreurs.interdit('Action réservée au gestionnaire de l\'association.', { __auth: false }));
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
    repondreErreur(req, res, e);
  }
});

// Handler global (erreurs Express hors routes API)
app.use((err, req, res, next) => {
  repondreErreur(req, res, err);
});

// Départ : connexion à la base si configurée, puis écoute

(async () => {
  try {
    const etat = await store.initStore();
    log.info('Démarrage MUTASSO PRO v6.2', { mode: etat.mode });
    // Prépare les clés VAPID (générées/persistées au 1er démarrage)
    const push = require('./push');
    await push.initialiser().catch(() => {});
    app.listen(config.PORT, '0.0.0.0', () => {
      log.info('Serveur à l\'écoute', { port: config.PORT, url: 'http://localhost:' + config.PORT });
    });
  } catch (e) {
    log.error('Impossible de démarrer (base de données ?)', { error: { message: e.message } });
    process.exit(1);
  }
})();
