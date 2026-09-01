// ============================================================
// MUTASSO PRO — errors.js
// Architecture d'erreurs à 3 couches :
//   AppError            (base : code, message, statusCode, isOperational)
//   OperationalError    (attendues : validation, introuvable, non autorisé)
//   NonOperationalError (bugs inattendus -> 500 + alerte monitoring)
// ============================================================
class AppError extends Error {
  constructor(code, message, statusCode, isOperational, details) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;                 // ex : MUT_AUTH_401
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details || {};     // champs additionnels de réponse
    Error.captureStackTrace && Error.captureStackTrace(this, this.constructor);
  }
  toJSON() {
    return { code: this.code, name: this.name, message: this.message };
  }
}

// Erreurs ATTENDUES : validation, ressource introuvable, accès refusé.
// Elles informent l'utilisateur — pas d'alerte équipe.
class OperationalError extends AppError {
  constructor(code, message, statusCode, details) {
    super(code, message, statusCode || 400, true, details);
  }
}

// Erreurs INATTENDUES : bugs, crashes. Toujours 500, jamais de détail
// interne en production, alerte monitoring systématique.
class NonOperationalError extends AppError {
  constructor(code, message, cause, details) {
    super(code, message || 'Erreur interne du serveur', 500, false, details);
    this.cause = cause;
  }
}

// Fabriques courantes
const erreurs = {
  validation: (message, details) => new OperationalError('MUT_VAL_400', message, 400, details),
  nonAutorise: (message, details) => new OperationalError('MUT_AUTH_401', message || 'Session invalide ou expirée.', 401, Object.assign({ __auth: true }, details)),
  interdit: (message, details) => new OperationalError('MUT_FORB_403', message || 'Action réservée au gestionnaire.', 403, details),
  introuvable: (message, details) => new OperationalError('MUT_NOTF_404', message || 'Ressource introuvable.', 404, details),
  interne: (cause, message, details) => new NonOperationalError('MUT_INT_500', message, cause, details)
};

module.exports = { AppError, OperationalError, NonOperationalError, erreurs };
