// ============================================================
// MUTASSO PRO — logger.js
// Logs structurés JSON (pino) + contexte de requête courant +
// hook de monitoring (Sentry chargé différément si disponible).
// Niveaux : error (bloquant) / warn (problème potentiel, requête
// > 5 s) / info (événement métier) / debug (détail dev) / trace.
// ============================================================
const pino = require('pino');
const config = require('./config');

const NIVEAU = process.env.LOG_LEVEL || (config.NODE_ENV === 'production' ? 'info' : 'debug');

const logger = pino({
  level: NIVEAU,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: 'mutasso-api', environment: config.NODE_ENV || 'development' },
  formatters: { level: label => ({ level: label }) }
});

// Contexte de la requête en cours (même mécanisme synchrone que le
// contexte de classeur du backend : requestId, utilisateur…).
let contexteRequete = {};
function definirContexte(c) { contexteRequete = c || {}; }
function contexteCourant() { return contexteRequete; }

// Journalise en fusionnant le contexte requête courant
function log(niveau, message, champs) {
  if (logger[niveau]) logger[niveau]({ ...contexteRequete, ...(champs || {}) }, message);
}

const niveaux = {};
['trace', 'debug', 'info', 'warn', 'error'].forEach(n => {
  niveaux[n] = (message, champs) => log(n, message, champs);
});

// ---- Monitoring des erreurs non opérationnelles ----
// Sentry est utilisé s'il est installé ET que SENTRY_DSN est défini
// (chargement différé : npm install @sentry/node + SENTRY_DSN=...).
// Sinon : journal d'alerte structuré (niveau error, alerte: true).
let sentryPrete = null; // null = non tenté, false = indisponible, true = active
function envoyerMonitoring(erreur, contexte) {
  try {
    if (sentryPrete !== false) {
      const sentry = require('@sentry/node');
      if (sentryPrete === null && process.env.SENTRY_DSN) {
        sentry.init({ dsn: process.env.SENTRY_DSN, environment: config.NODE_ENV });
        sentryPrete = true;
      } else if (sentryPrete === null) {
        sentryPrete = false;
      }
    }
    if (sentryPrete === true) {
      require('@sentry/node').captureException(erreur, { extra: contexte });
      return 'sentry';
    }
  } catch (e) { sentryPrete = false; }
  log('error', 'ALERTE ÉQUIPE — erreur non opérationnelle', {
    alerte: true,
    monitoring: 'sentry-non-configure',
    error: { code: erreur && erreur.code, name: erreur && erreur.name, message: erreur && erreur.message, stack: erreur && erreur.stack },
    ...contexte
  });
  return 'log';
}

module.exports = { logger, niveaux, definirContexte, contexteCourant, envoyerMonitoring, NIVEAU };
