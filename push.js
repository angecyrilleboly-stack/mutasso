// ============================================================
// MUTASSO PRO v6.2 — push.js
// Notifications push (Web Push / protocole VAPID) :
//  - chaque appareil connecté (admin OU membre) s'abonne
//  - un événement (nouvelle cotisation exceptionnelle…) est
//    envoyé à TOUS les appareils abonnés de l'association
//  - clés VAPID : variables d'environnement si fournies, sinon
//    générées une fois puis persistées (PG ou fichier local)
//  - abonnements : table abonnements_push (PG) ou data/push.json
// ============================================================
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');

const webpush = require('web-push');
const PUSH_FILE = path.join(__dirname, 'data', 'push.json');
const VAPID_FILE = path.join(__dirname, 'data', 'vapid.json');

// Abonnements en mémoire (mode fichiers)
let abosFichiers = null;
function lireAbosFichiers() {
  try { return JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8')); }
  catch (e) { return []; }
}

/* ============ Clés VAPID ============ */
let clesVAPID = null;

async function chargerCles() {
  if (config.MODE_PG) {
    const v = await store.pgLireParam('vapid');
    return v ? JSON.parse(v) : null;
  }
  try { return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); }
  catch (e) { return null; }
}

async function sauverCles(cles) {
  if (config.MODE_PG) { await store.pgEcrireParam('vapid', JSON.stringify(cles)); return; }
  fs.mkdirSync(path.dirname(VAPID_FILE), { recursive: true });
  fs.writeFileSync(VAPID_FILE, JSON.stringify(cles, null, 2));
}

// Initialise les clés (env > persistées > générées) et web-push.
// Retourne false seulement si l'initialisation a échoué.
async function initialiser() {
  if (clesVAPID) return true;
  try {
    if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
      clesVAPID = { publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY };
    } else {
      clesVAPID = await chargerCles();
      if (!clesVAPID || !clesVAPID.publicKey) {
        // Premier démarrage : génération puis persistance — les
        // abonnements existants resteraient valides aux redémarrages
        clesVAPID = webpush.generateVAPIDKeys();
        await sauverCles(clesVAPID);
      }
    }
    webpush.setVapidDetails(config.VAPID_SUBJECT, clesVAPID.publicKey, clesVAPID.privateKey);
    return true;
  } catch (e) { clesVAPID = null; return false; }
}

// Clé publique transmise au navigateur pour l'abonnement
async function clePublique() {
  const ok = await initialiser();
  return { status: 'success', cle: ok && clesVAPID ? clesVAPID.publicKey : '' };
}

/* ============ Abonnements ============ */
// Enregistre l'abonnement d'un appareil pour une association.
// role : 'membre' (destinataire des notifications) ou 'admin'
// (le gestionnaire enregistre les événements, il n'est pas notifié).
async function abonner(subscription, idCompte, role) {
  if (!subscription || !subscription.endpoint) return { status: 'error', msg: 'Abonnement invalide.' };
  if (config.MODE_PG) {
    await store.pgAjouterAbonnementPush(idCompte, subscription.endpoint, subscription.keys || {}, role || 'membre');
  } else {
    if (abosFichiers === null) abosFichiers = lireAbosFichiers();
    abosFichiers = abosFichiers.filter(a => a.endpoint !== subscription.endpoint);
    abosFichiers.push({ compteId: idCompte, endpoint: subscription.endpoint, keys: subscription.keys || {}, role: role || 'membre' });
    fs.mkdirSync(path.dirname(PUSH_FILE), { recursive: true });
    fs.writeFileSync(PUSH_FILE, JSON.stringify(abosFichiers, null, 2));
  }
  return { status: 'success', msg: 'Notifications activées sur cet appareil.' };
}

// Liste les abonnements d'une association (les deux modes).
// role facultatif : limite aux abonnements de ce rôle.
async function lister(idCompte, role) {
  if (config.MODE_PG) return store.pgListerAbonnementsPush(idCompte, role);
  if (abosFichiers === null) abosFichiers = lireAbosFichiers();
  return abosFichiers.filter(a => a.compteId === idCompte && (!role || a.role === role));
}

// Nettoie un abonnement invalide (appareil désinstallé, etc.)
async function retirer(endpoint) {
  if (config.MODE_PG) { await store.pgSupprimerAbonnementPush(endpoint); return; }
  if (abosFichiers === null) abosFichiers = lireAbosFichiers();
  abosFichiers = abosFichiers.filter(a => a.endpoint !== endpoint);
  fs.mkdirSync(path.dirname(PUSH_FILE), { recursive: true });
  fs.writeFileSync(PUSH_FILE, JSON.stringify(abosFichiers, null, 2));
}

// Envoie une notification à tous les APPAREILS DES MEMBRES d'une
// association (le gestionnaire enregistre l'événement : il n'est
// pas destinataire). Chaque association ne notifie que SES membres.
async function notifierTous(idCompte, titre, corps) {
  if (!(await initialiser())) return { envoyees: 0 };
  const abos = await lister(idCompte, 'membre');
  const payload = JSON.stringify({ title: titre, body: corps, tag: 'mutasso-' + Date.now() });
  let envoyees = 0;
  await Promise.all(abos.map(async a => {
    try {
      await webpush.sendNotification({ endpoint: a.endpoint, keys: a.keys }, payload);
      envoyees++;
    } catch (e) {
      // 404/410 : abonnement expiré -> on le retire
      if (e.statusCode === 404 || e.statusCode === 410) await retirer(a.endpoint).catch(() => {});
    }
  }));
  return { envoyees: envoyees, total: abos.length };
}

// Envoie une notification à UN seul appareil (test personnel).
async function notifierAppareil(subscription, titre, corps) {
  if (!(await initialiser())) return false;
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: subscription.keys || {} },
      JSON.stringify({ title: titre, body: corps, tag: 'mutasso-test' })
    );
    return true;
  } catch (e) { return false; }
}

module.exports = { initialiser, clePublique, abonner, notifierTous, notifierAppareil };
