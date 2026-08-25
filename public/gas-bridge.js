// ============================================================
// MUTASSO PRO v6.2 — gas-bridge.js
// Émulation locale de google.script.run : chaque appel
// google.script.run.withSuccessHandler(cb).maFonction(...)
// est transformé en POST /api/maFonction avec les arguments
// en JSON. Le token de session (si connecté) est envoyé dans
// l'en-tête X-Auth-Token ; une session invalide renvoie vers
// la page de connexion. (XMLHttpRequest : plus universel que
// fetch dans les webviews embarquées.)
// ============================================================
(function () {
  function Runner() {
    this._success = function () {};
    this._failure = function (err) { console.error('Erreur MUTASSO :', err); };
  }
  Runner.prototype.withSuccessHandler = function (cb) { this._success = cb; return this; };
  Runner.prototype.withFailureHandler = function (cb) { this._failure = cb; return this; };

  function callApi(name, args, onSuccess, onFailure) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/' + encodeURIComponent(name), true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      const token = localStorage.getItem('mutasso_token');
      if (token) xhr.setRequestHeader('X-Auth-Token', token);
      xhr.onload = function () {
        let res = null;
        try { res = JSON.parse(xhr.responseText); }
        catch (e) { onFailure('Réponse illisible (' + xhr.status + ')'); return; }
        if (res && res.__auth) {
          // Session expirée (ex: mot de passe changé ailleurs) -> reconnexion
          localStorage.removeItem('mutasso_token');
          location.reload();
          return;
        }
        if (res && res.__error) onFailure(res.__error);
        else onSuccess(res);
      };
      xhr.onerror = function () { onFailure('Réseau indisponible — le serveur est-il lancé ?'); };
      xhr.send(JSON.stringify(args));
    } catch (e) {
      onFailure(String(e));
    }
  }

  const handler = {
    get(target, prop) {
      if (prop in target) return target[prop];
      return function (...args) {
        callApi(String(prop), args, target._success, target._failure);
      };
    }
  };

  window.google = { script: { run: new Proxy(new Runner(), handler) } };
})();
