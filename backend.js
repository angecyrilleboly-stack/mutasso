// ============================================================
// MUTASSO PRO v6.2 — backend.js
// Reproduction locale du fichier "backend.gs" (Google Apps Script).
// Chaque fonction garde le même nom et le même comportement.
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ouvrirClasseur, lireRegistre, ajouterAuRegistre, majEntreeRegistre, sauverRegistre, tablesDuClasseur } = require('./sheets');
const config = require('./config');
const store = require('./store');
const push = require('./push');
const { niveaux: log } = require('./logger');

// --- Constantes (ex-configuration.gs) ---
const SHEET_MEMBRES = "MEMBRES";
const SHEET_BUREAU = "BUREAU_MEMBRES";
const SHEET_POSTES = "BUREAU_POSTES";
const SHEET_MENSUEL = "COTISATIONS_MENSUELLES";
const SHEET_EXCEP = "COTISATIONS_EXCEPTIONNELLES";
const SHEET_DEPENSES = "DEPENSES";
const SHEET_REUNIONS = "REUNIONS";
const SHEET_INFOS = "ASSOC_INFOS";
const SHEET_TYPES_MENSUELS = "MENSUEL_TYPES";
const SHEET_TYPES_EXCEP = "EXCEP_TYPES";
const SHEET_ACCES_MEMBRES = "MEMBRES_ACCES";

// Feuilles du classeur d'UNE association (structure standard)
const TABLES_STANDARD = [
  { name: SHEET_MEMBRES, headers: ["ID", "Nom", "Prénom", "Contact", "Ville", "Sexe"] },
  { name: SHEET_BUREAU, headers: ["ID_Membre", "Nom_Complet", "Poste", "Date_Nomination"] },
  { name: SHEET_POSTES, headers: ["Libellé Poste"] },
  { name: SHEET_MENSUEL, headers: ["ID_Membre", "Nom_Complet", "Mois", "Année", "Montant", "Date_Paiement", "Type_Cotis"] },
  { name: SHEET_EXCEP, headers: ["ID_Membre", "Nom_Complet", "Motif", "Montant", "Date_Paiement"] },
  { name: SHEET_DEPENSES, headers: ["Motif", "Bénéficiaire", "Montant", "Date"] },
  { name: SHEET_REUNIONS, headers: ["ID", "Date", "Objet", "Presents_Bureau", "Invites", "Compte_Rendu", "Lieu", "Heure", "Heure_Fin"] },
  { name: SHEET_INFOS, headers: ["Nom", "Telephone", "Adresse", "Email", "Logo_URL"] },
  { name: SHEET_TYPES_MENSUELS, headers: ["Libellé Type", "Montant"] },
  { name: SHEET_TYPES_EXCEP, headers: ["Libellé", "Montant"] },
  { name: SHEET_ACCES_MEMBRES, headers: ["ID_Membre", "Nom_Complet", "Hash", "Sel"] }
];

// ============================================================
// COMPTES ASSOCIATIONS — multi-associations, données ISOLÉES
//  - Registre global : data/comptes.json
//    [{ id, email, hash, salt, nom, contact, logo, creeLe }]
//  - Chaque association travaille sur SON classeur :
//    data/comptes/<id>.json (membres, cotisations, dépenses…)
//  - Une association nouvellement inscrite démarre avec un
//    espace VIERGE : à elle de créer ses membres, etc.
// ============================================================
const TAILLE_LOGO_MAX = 2 * 1024 * 1024 * 1.4; // ~2 Mo une fois encodé en base64

// Validation du format de l'adresse email
function emailValide(e) {
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(e).trim());
}

// Comparaison à temps constant (anti-analyse temporelle)
function memesHash(a, b) {
  try {
    const ba = Buffer.from(String(a), 'hex'), bb = Buffer.from(String(b), 'hex');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch (e) { return false; }
}

// Protection contre les tentatives de connexion répétées (brute force)
// 5 échecs sur un email -> blocage 10 minutes (réinitialisé au redémarrage)
const tentativesConnexion = {};
const MAX_TENTATIVES = 5;
const DUREE_BLOCAGE_MS = 10 * 60 * 1000;

function normaliserEmail(e) { return String(e || '').toLowerCase().trim(); }

// Contexte de la requête courante : classeur + compte de
// l'association authentifiée. Les fonctions de données
// (getMembres, enregistrerMensuel…) lisent/écrivent uniquement
// dans CE classeur — jamais dans celui d'une autre association.
let SS = null;
let compteActif = null;
// Session MEMBRE (espace personnel en lecture seule) :
// renseigné quand le jeton correspond à l'accès d'un adhérent.
let accesMembre = null;

function hashMdp(mdp, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(mdp), salt, 32).toString('hex');
  return { salt, hash };
}

// Token de session propre à chaque compte (change si le mot de
// passe change : les autres sessions sont alors déconnectées)
function tokenPour(entree) {
  return crypto.createHash('sha256').update(entree.id + '|' + entree.hash).digest('hex');
}

// Token d'un ESPACE MEMBRE : "M|compte|membre|signature".
// La signature dépend du hash du mot de passe du membre : elle
// change (et déconnecte les sessions) si le mot de passe change.
function tokenMembrePour(idCompte, idMembre, hash) {
  const sig = crypto.createHash('sha256').update(idCompte + '|M|' + idMembre + '|' + hash).digest('hex');
  return 'M|' + idCompte + '|' + idMembre + '|' + sig;
}

// Mot de passe temporaire lisible (sans caractères ambigus 0/O/1/I)
function mdpAleatoire() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rnd = crypto.randomBytes(8);
  let m = '';
  for (let i = 0; i < 8; i++) m += chars[rnd[i] % chars.length];
  return m;
}

// Cherche, dans le classeur d'une association, l'accès membre
// dont le mot de passe correspond (connexion : email de
// l'association + mot de passe personnel du membre).
async function chercherAccesMembre(idCompte, mdp) {
  await ouvrirClasseur(idCompte);
  const tables = tablesDuClasseur(idCompte) || {};
  const lignes = (tables[SHEET_ACCES_MEMBRES] || []).slice(1);
  if (!lignes.length) return null;
  const membres = (tables[SHEET_MEMBRES] || []).slice(1);
  for (const r of lignes) {
    if (!r || !r[0] || !r[2] || !r[3]) continue;
    const { hash } = hashMdp(mdp, r[3].toString());
    if (!memesHash(hash, r[2].toString())) continue;
    const mRow = membres.find(m => m && m[0] && m[0].toString() === r[0].toString());
    if (!mRow) continue; // adhérent retiré du registre : accès ignoré
    return {
      id: r[0].toString(), nom: mRow[1].toString(), prenom: mRow[2].toString(),
      token: tokenMembrePour(idCompte, r[0].toString(), r[2].toString())
    };
  }
  return null;
}

function infosPubliques(e) {
  return { id: e.id, email: e.email, nom: e.nom, contact: e.contact || "", logo: e.logo || "" };
}

async function compteExiste() { return (await lireRegistre()).length > 0; }

async function creerCompte(d) {
  if (!d.email || !d.mdp || !d.nom) return { status: "error", msg: "Nom, email et mot de passe obligatoires." };
  if (String(d.mdp).length < 6) return { status: "error", msg: "Mot de passe : 6 caractères minimum." };
  if (d.logo && String(d.logo).length > TAILLE_LOGO_MAX) return { status: "error", msg: "Logo trop volumineux (2 Mo maximum)." };
  const email = normaliserEmail(d.email);
  if (!emailValide(email)) return { status: "error", msg: "Adresse email invalide." };
  if ((await lireRegistre()).some(c => c.email === email)) return { status: "error", msg: "Un compte existe déjà avec cet email." };
  const { salt, hash } = hashMdp(d.mdp);
  const entree = {
    id: "C-" + Date.now().toString(36).toUpperCase() + "-" + Math.floor(Math.random() * 900 + 100),
    email: email, hash: hash, salt: salt,
    nom: d.nom, contact: d.contact || "", logo: d.logo || "",
    creeLe: new Date().toISOString()
  };
  ajouterAuRegistre(entree);
  // Espace de données VIERGE, propre à cette association
  await activerCompte(entree.id);
  saveAssocInfos({ nom: d.nom, tel: d.contact || "", adresse: "", email: email, logo: d.logo || "" });
  log.info("Association inscrite", { evenement: "inscription", compteId: entree.id, email: email, nom: d.nom });
  return { status: "success", msg: "Compte créé ! Votre espace est prêt.", token: tokenPour(entree), infos: infosPubliques(entree) };
}



// ---- SUPER ADMINISTRATEUR -----------------------------------
// Le super admin supervise TOUTES les associations de l'application.
// Liste : variable SUPER_ADMIN_EMAILS (env, séparée virgules) UNION
// paramètre « super_admins » en base ; à défaut, le compte le plus
// ancien (le fondateur de l'application) est super admin.
async function listeSuperAdmins() {
  const emails = [];
  if (config.SUPER_ADMIN_EMAILS) {
    config.SUPER_ADMIN_EMAILS.split(',').forEach(e => { const n = normaliserEmail(e); if (n && !emails.includes(n)) emails.push(n); });
  }
  try {
    const v = store.pgLireParam ? await store.pgLireParam('super_admins') : null;
    if (v) JSON.parse(v).forEach(e => { const n = normaliserEmail(e); if (n && !emails.includes(n)) emails.push(n); });
  } catch (e) { /* mode fichiers ou absent */ }
  if (!emails.length) {
    const reg = await lireRegistre();
    if (reg.length) emails.push(reg[0].email); // compte fondateur
  }
  return emails;
}

async function estSuperAdmin(email) {
  return (await listeSuperAdmins()).includes(normaliserEmail(email));
}

// Tableau de bord GLOBAL du super admin : toutes les associations,
// leur effectif, leurs finances et leurs appareils notifiés.
async function getVueGlobale() {
  if (!compteActif || !(await estSuperAdmin(compteActif.email))) {
    return { status: "error", msg: "Réservé au super administrateur." };
  }
  const reg = await lireRegistre();
  const associations = [];
  for (const c of reg) {
    const tables = (await ouvrirClasseur(c.id), tablesDuClasseur(c.id)) || {};
    const nbLignes = (t) => Array.isArray(t) ? Math.max(0, t.length - 1) : 0;
    const mens = tables[SHEET_MENSUEL] || [];
    const exc = tables[SHEET_EXCEP] || [];
    const dep = tables[SHEET_DEPENSES] || [];
    const somme = (t, col) => t.slice(1).reduce((a, r) => a + (Number(r[col]) || 0), 0);
    associations.push({
      id: c.id, nom: c.nom, email: c.email, contact: c.contact || '',
      creeLe: c.creeLe || '',
      nbMembres: nbLignes(tables[SHEET_MEMBRES]),
      nbMens: nbLignes(mens), nbExc: nbLignes(exc), nbDep: nbLignes(dep),
      totalEntrees: somme(mens, 4) + somme(exc, 3),
      totalDepenses: somme(dep, 2),
      caisse: somme(mens, 4) + somme(exc, 3) - somme(dep, 2)
    });
  }
  return {
    status: "success",
    nbAssociations: associations.length,
    totalMembres: associations.reduce((a, x) => a + x.nbMembres, 0),
    totalCotisations: associations.reduce((a, x) => a + x.nbMens + x.nbExc, 0),
    totalCaisse: associations.reduce((a, x) => a + x.caisse, 0),
    associations: associations
  };
}

// Réinitialise le mot de passe d'une association (super admin).
// Le nouveau mot de passe n'est montré qu'une fois.
async function reinitialiserMdpAssociation(idCompte) {
  if (!compteActif || !(await estSuperAdmin(compteActif.email))) {
    return { status: "error", msg: "Réservé au super administrateur." };
  }
  const reg = await lireRegistre();
  const entree = reg.find(c => c.id === idCompte);
  if (!entree) return { status: "error", msg: "Association introuvable." };
  const mdp = mdpAleatoire();
  const { salt, hash } = hashMdp(mdp);
  entree.hash = hash; entree.salt = salt;
  majEntreeRegistre(entree);
  log.warn("Mot de passe association réinitialisé", { evenement: "reset_mdp_association", cible: idCompte, par: compteActif.id });
  return { status: "success", msg: "Nouveau mot de passe généré pour " + entree.nom + ".", mdp: mdp, email: entree.email };
}

// Supprime définitivement une association et toutes ses données.
async function supprimerAssociation(idCompte) {
  if (!compteActif || !(await estSuperAdmin(compteActif.email))) {
    return { status: "error", msg: "Réservé au super administrateur." };
  }
  if (idCompte === compteActif.id) return { status: "error", msg: "Impossible de supprimer votre propre association depuis ici." };
  const reg = await lireRegistre();
  const entree = reg.find(c => c.id === idCompte);
  if (!entree) return { status: "error", msg: "Association introuvable." };
  if (config.MODE_PG) {
    await store.pgSupprimerAbonnementPushCompte(idCompte).catch(() => {});
    await store.pgSupprimerClasseur(idCompte).catch(() => {});
  } else {
    try { require('fs').unlinkSync(path.join(__dirname, 'data', 'comptes', idCompte + '.json')); } catch (e) {}
  }
  // Retire l'association du registre (en place) et persiste
  reg.splice(reg.indexOf(entree), 1);
  if (config.MODE_PG) await store.pgSauverRegistre(reg);
  else sauverRegistre();
  log.error('ASSOCIATION SUPPRIMÉE par le super admin', { evenement: 'suppression_association', cible: idCompte, nom: entree.nom, par: compteActif.id });
  return { status: 'success', msg: 'Association ' + entree.nom + ' supprimée avec toutes ses données.' };
}

async function connexion(email, mdp) {
  const emailNorm = normaliserEmail(email);
  const etat = tentativesConnexion[emailNorm];
  if (etat && etat.bloqueJusqu > Date.now()) {
    const mn = Math.ceil((etat.bloqueJusqu - Date.now()) / 60000);
    return { status: "error", msg: `Trop de tentatives échouées. Réessayez dans ${mn} minute(s).` };
  }
  const entree = (await lireRegistre()).find(c => c.email === emailNorm);
  if (!entree) return { status: "error", msg: "Email ou mot de passe incorrect." };
  const { hash } = hashMdp(mdp, entree.salt);
  if (memesHash(hash, entree.hash)) {
    delete tentativesConnexion[emailNorm];
    const superAdmin = await estSuperAdmin(entree.email);
    const role = superAdmin ? "superadmin" : "admin";
    log.info("Connexion gestionnaire", { evenement: "connexion", compteId: entree.id, role: role });
    return { status: "success", msg: "Connexion réussie !", token: tokenPour(entree), infos: { ...infosPubliques(entree), role: role } };
  }
  // Espace membre : même email (celui de l'association), mais mot
  // de passe personnel remis par le gestionnaire.
  const acces = await chercherAccesMembre(entree.id, mdp);
  if (acces) {
    delete tentativesConnexion[emailNorm];
    log.info("Connexion membre", { evenement: "connexion", compteId: entree.id, role: "membre", membreId: acces.id });
    return {
      status: "success", msg: "Bienvenue " + acces.prenom + " !", token: acces.token,
      infos: { ...infosPubliques(entree), role: "membre", membre: { id: acces.id, nom: acces.nom, prenom: acces.prenom } }
    };
  }
  const nb = (etat ? etat.nb : 0) + 1;
  tentativesConnexion[emailNorm] = { nb: nb, bloqueJusqu: nb >= MAX_TENTATIVES ? Date.now() + DUREE_BLOCAGE_MS : 0 };
  if (nb >= MAX_TENTATIVES) return { status: "error", msg: "Trop de tentatives échouées. Compte bloqué 10 minutes." };
  return { status: "error", msg: `Email ou mot de passe incorrect. (${MAX_TENTATIVES - nb} tentative(s) restante(s))` };
}

// Retourne l'id du compte correspondant au token, sinon null
async function verifierToken(token) {
  const s = await verifierSession(token);
  return s ? s.idCompte : null;
}

// Valide un jeton de session (admin OU membre) et décrit la
// session : { idCompte, role, idMembre } — sinon null.
async function verifierSession(token) {
  if (!token) return null;
  // Session administrateur (jeton sha256 hexa)
  const entree = (await lireRegistre()).find(c => memesHash(tokenPour(c), token));
  if (entree) return { idCompte: entree.id, role: "admin", idMembre: null };
  // Session membre : jeton « M|compte|membre|signature »
  if (String(token).startsWith('M|')) {
    const p = String(token).split('|');
    if (p.length !== 4) return null;
    const idCompte = p[1], idMembre = p[2], sig = p[3];
    const compte = (await lireRegistre()).find(c => c.id === idCompte);
    if (!compte) return null;
    await ouvrirClasseur(idCompte);
    const tables = tablesDuClasseur(idCompte) || {};
    const lignes = (tables[SHEET_ACCES_MEMBRES] || []);
    for (let i = 1; i < lignes.length; i++) {
      const r = lignes[i];
      if (r && r[0] && r[0].toString() === idMembre && r[2]) {
        const attendu = crypto.createHash('sha256').update(idCompte + '|M|' + idMembre + '|' + r[2].toString()).digest('hex');
        return memesHash(attendu, sig) ? { idCompte: idCompte, role: "membre", idMembre: idMembre } : null;
      }
    }
  }
  return null;
}

// Bascule le contexte de données sur l'association donnée.
// Si son classeur est neuf, les feuilles standard sont créées.
// idMembre (optionnel) : la session ouverte est l'ESPACE MEMBRE
// de cet adhérent (lecture seule, données filtrées sur lui).
// NB : toutes les opérations feuilles sont synchrones, le
// basculement par requête est donc sans risque de mélange.
async function activerCompte(id, idMembre) {
  const entree = (await lireRegistre()).find(c => c.id === id);
  if (!entree) return false;
  compteActif = entree;
  accesMembre = null;
  SS = await ouvrirClasseur(entree.id);
  const brut = tablesDuClasseur(entree.id) || {};
  let complet = TABLES_STANDARD.every(t => brut[t.name]);
  // Migration : anciens classeurs REUNIONS sans la colonne Heure_Fin
  if (brut.REUNIONS && brut.REUNIONS[0] && brut.REUNIONS[0].length < 9) complet = false;
  if (!complet) { initialiserMUTASSO(); seedDefaults(); }
  if (idMembre) {
    const m = getMembres().find(x => x.id === String(idMembre));
    if (!m) return false; // adhérent introuvable : session refusée
    accesMembre = { id: m.id, nom: m.nom, prenom: m.prenom };
  }
  return true;
}

// Infos de session : identité de l'association +, pour un membre,
// son rôle ("membre") et sa propre identité.
// Infos de session : identité de l'association + rôle. Le rôle
// superadmin est déterminé à chaque session (liste mutable).
async function infosCompte() {
  if (!compteActif) return null;
  const base = infosPubliques(compteActif);
  if (accesMembre) return { ...base, role: "membre", membre: accesMembre };
  const superAdmin = await estSuperAdmin(compteActif.email);
  return { ...base, role: superAdmin ? "superadmin" : "admin" };
}

// Modification de l'identité (nom, contact, logo) depuis Paramètres
function majIdentite(d) {
  if (!compteActif) return { status: "error", msg: "Aucun compte actif." };
  if (d.logo && String(d.logo).length > TAILLE_LOGO_MAX) return { status: "error", msg: "Logo trop volumineux (2 Mo maximum)." };
  const e = compteActif;
  if (d.nom !== undefined && d.nom !== "") e.nom = d.nom;
  if (d.contact !== undefined) e.contact = d.contact;
  if (d.supprimerLogo) e.logo = "";
  else if (d.logo) e.logo = d.logo;
  majEntreeRegistre(e);
  const anciennes = getAssocInfos();
  saveAssocInfos({ nom: e.nom, tel: e.contact, adresse: anciennes.adresse || "", email: e.email, logo: e.logo });
  return { status: "success", msg: "Identité mise à jour !", infos: infosPubliques(e) };
}

// Changement de mot de passe (retourne un nouveau token de session)
function majMotDePasse(ancien, nouveau) {
  if (!compteActif) return { status: "error", msg: "Aucun compte actif." };
  const e = compteActif;
  const { hash } = hashMdp(ancien, e.salt);
  if (!memesHash(hash, e.hash)) return { status: "error", msg: "Ancien mot de passe incorrect." };
  if (String(nouveau).length < 6) return { status: "error", msg: "Nouveau mot de passe : 6 caractères minimum." };
  const nh = hashMdp(nouveau);
  e.hash = nh.hash; e.salt = nh.salt;
  majEntreeRegistre(e);
  return { status: "success", msg: "Mot de passe mis à jour !", token: tokenPour(e) };
}

/* ============================================================
// ESPACES MEMBRES — accès en lecture seule
//   - Le gestionnaire (admin) génère un mot de passe remis au
//     membre ; le membre se connecte avec l'email de
//     l'association + ce mot de passe, et peut le changer.
//   - Feuille MEMBRES_ACCES : [ID_Membre, Nom_Complet, Hash, Sel]
// ============================================================ */

// Identifiants des membres disposant d'un accès actif
function idsAccesMembres() {
  const s = SS.getSheetByName(SHEET_ACCES_MEMBRES);
  if (!s || s.getLastRow() <= 1) return [];
  return s.getDataRange().getValues().slice(1).filter(r => r[0]).map(r => r[0].toString());
}

// Génère (ou renouvelle) le mot de passe de l'espace d'un membre.
// Le mot de passe en clair n'est montré QU'UNE fois au gestionnaire.
function genererMdpMembre(idMembre) {
  const m = getMembres().find(x => x.id === String(idMembre));
  if (!m) return { status: "error", msg: "Membre introuvable." };
  const mdp = mdpAleatoire();
  const { salt, hash } = hashMdp(mdp);
  const s = SS.getSheetByName(SHEET_ACCES_MEMBRES);
  const data = s.getDataRange().getValues();
  const ligne = data.findIndex((r, i) => i > 0 && r[0] && r[0].toString() === String(idMembre));
  const nomComplet = (m.prenom + " " + m.nom).trim();
  if (ligne > 0) s.getRange(ligne + 1, 1, 1, 4).setValues([[m.id, nomComplet, hash, salt]]);
  else s.appendRow([m.id, nomComplet, hash, salt]);
  log.info("Accès membre généré", { evenement: "acces_membre", compteId: compteActif ? compteActif.id : null, membreId: m.id });
  return {
    status: "success",
    msg: "Mot de passe généré pour " + nomComplet + ".",
    mdp: mdp, email: compteActif ? compteActif.email : "", nom: m.nom, prenom: m.prenom
  };
}

// Retire l'accès de l'espace membre (le mot de passe ne marche plus)
function supprimerAccesMembre(idMembre) {
  const s = SS.getSheetByName(SHEET_ACCES_MEMBRES);
  const data = s.getDataRange().getValues();
  const ligne = data.findIndex((r, i) => i > 0 && r[0] && r[0].toString() === String(idMembre));
  if (ligne < 0) return { status: "error", msg: "Ce membre n'a pas d'accès actif." };
  s.deleteRow(ligne + 1);
  return { status: "success", msg: "Accès membre révoqué." };
}

// Le membre change lui-même son mot de passe (nouveau jeton renvoyé)
function majMotDePasseMembre(ancien, nouveau) {
  if (!accesMembre || !compteActif) return { status: "error", msg: "Aucun espace membre actif." };
  if (String(nouveau).length < 6) return { status: "error", msg: "Nouveau mot de passe : 6 caractères minimum." };
  const s = SS.getSheetByName(SHEET_ACCES_MEMBRES);
  const data = s.getDataRange().getValues();
  const ligne = data.findIndex((r, i) => i > 0 && r[0] && r[0].toString() === accesMembre.id);
  if (ligne < 0) return { status: "error", msg: "Accès introuvable." };
  const { hash } = hashMdp(ancien, data[ligne][3].toString());
  if (!memesHash(hash, data[ligne][2].toString())) return { status: "error", msg: "Ancien mot de passe incorrect." };
  const nh = hashMdp(nouveau);
  s.getRange(ligne + 1, 3, 1, 2).setValues([[nh.hash, nh.salt]]);
  return { status: "success", msg: "Mot de passe mis à jour !", token: tokenMembrePour(compteActif.id, accesMembre.id, nh.hash) };
}

/* ============================================================
// NOTIFICATIONS PUSH (Web Push / VAPID)
//   - l'appareil demande la clé publique puis s'abonne
//   - les événements (cotisation exceptionnelle…) notifient
//     tous les appareils abonnés de l'association
// ============================================================ */
async function clePubliquePush() { return push.clePublique(); }

async function abonnerPush(subscription) {
  if (!compteActif) return { status: "error", msg: "Aucun compte actif." };
  // Rôle de la session : seuls les MEMBRES reçoivent les
  // notifications d'événements (le gestionnaire les émet).
  return push.abonner(subscription, compteActif.id, accesMembre ? "membre" : "admin");
}

// Test personnel : notifie UNIQUEMENT l'appareil qui demande
// (retour immédiat pour vérifier que les notifications marchent)
async function testPushPerso(subscription) {
  if (!subscription || !subscription.endpoint) return { status: "error", msg: "Abonnement invalide." };
  const ok = await push.notifierAppareil(subscription,
    'MUTASSO — Test réussi',
    'Vous serez alerté des événements de l\'association (cotisations exceptionnelles…).');
  return ok
    ? { status: "success", msg: "Notification de test envoyée." }
    : { status: "error", msg: "Envoi impossible — réessayez." };
}

// Combien d'appareils MEMBRES recevront les notifications de
// l'association (diagnostic affiché au gestionnaire)
async function compterAbonnementsMembres() {
  if (!compteActif) return { status: "error", nb: 0 };
  return { status: "success", nb: await push.compter(compteActif.id, 'membre') };
}

function getMembres() {
  const s = SS.getSheetByName(SHEET_MEMBRES); const v = s.getDataRange().getValues();
  if (v.length <= 1) return [];
  // Sécurité : une session MEMBRE ne voit pas les contacts des
  // autres adhérents (l'interface membre n'utilise que noms/sexe).
  return v.slice(1).filter(r => r[0] !== "").map(row => {
    const m = { id: row[0].toString(), nom: row[1].toString(), prenom: row[2].toString(), contact: row[3].toString(), ville: row[4].toString(), sexe: row[5].toString() };
    if (accesMembre) m.contact = '';
    return m;
  });
}

function getDashboardStats() {
  const sumCol = (n, c) => { const s = SS.getSheetByName(n); if (!s || s.getLastRow() <= 1) return 0; return s.getRange(2, c, s.getLastRow()-1, 1).getValues().reduce((acc, v) => acc + (Number(v[0]) || 0), 0); };
  const tIn = sumCol(SHEET_MENSUEL, 5) + sumCol(SHEET_EXCEP, 4);
  const tOut = sumCol(SHEET_DEPENSES, 3);
  return { totalMembres: Math.max(0, SS.getSheetByName(SHEET_MEMBRES).getLastRow() - 1), caisse: tIn - tOut };
}

function getChartData() {
  const year = new Date().getFullYear(); let income = Array(12).fill(0); let expenses = Array(12).fill(0);
  const getMonthIndex = (d) => { if(!d) return -1; if(typeof d === 'string' && d.includes('/')) { const p = d.split('/'); if(p[2] == year) return parseInt(p[1], 10) - 1; } else if (d instanceof Date) { if(d.getFullYear() === year) return d.getMonth(); } return -1; };
  const sMens = SS.getSheetByName(SHEET_MENSUEL).getDataRange().getValues().slice(1); sMens.forEach(r => { const m = getMonthIndex(r[5]); if(m>=0) income[m] += (Number(r[4])||0); });
  const sExc = SS.getSheetByName(SHEET_EXCEP).getDataRange().getValues().slice(1); sExc.forEach(r => { const m = getMonthIndex(r[4]); if(m>=0) income[m] += (Number(r[3])||0); });
  const sDep = SS.getSheetByName(SHEET_DEPENSES).getDataRange().getValues().slice(1); sDep.forEach(r => { const m = getMonthIndex(r[3]); if(m>=0) expenses[m] += (Number(r[2])||0); });
  return { income, expenses };
}

function getEtatPaiements(type, param1, param2) {
  const membres = getMembres();
  if (type === 'mensuel') {
    const s = SS.getSheetByName(SHEET_MENSUEL);
    if (s.getLastRow() <= 1) return membres.map(u => ({ ...u, aPaye: false }));
    const p = s.getDataRange().getValues().slice(1).filter(r => r[2] === param1 && r[3].toString() === param2.toString()).map(r => r[0].toString());
    return membres.map(u => ({ ...u, aPaye: p.includes(u.id) }));
  } else {
    const s = SS.getSheetByName(SHEET_EXCEP);
    if (s.getLastRow() <= 1) return membres.map(u => ({ ...u, aPaye: false }));
    const p = s.getDataRange().getValues().slice(1).filter(r => r[2].toString().toUpperCase() === param1.toUpperCase()).map(r => r[0].toString());
    return membres.map(u => ({ ...u, aPaye: p.includes(u.id) }));
  }
}

function getMembreProfile(idMembre) {
  // Sécurité : une session MEMBRE ne peut consulter que SA propre
  // fiche — l'identifiant demandé est ignoré et remplacé par le sien.
  if (accesMembre) idMembre = accesMembre.id;
  const membres = SS.getSheetByName(SHEET_MEMBRES).getDataRange().getValues().slice(1); const mRow = membres.find(r => r[0].toString() === idMembre.toString()); if(!mRow) return null;
  const info = { id: mRow[0], nom: mRow[1], prenom: mRow[2], contact: mRow[3], ville: mRow[4], sexe: mRow[5] };
  const mens = SS.getSheetByName(SHEET_MENSUEL).getDataRange().getValues().slice(1); const histMens = mens.filter(r => r[0].toString() === idMembre.toString()).map(r => ({ mois: r[2], annee: r[3], montant: r[4], datePaiement: r[5] instanceof Date ? r[5].toLocaleDateString('fr-FR') : r[5] })).reverse();
  const exc = SS.getSheetByName(SHEET_EXCEP).getDataRange().getValues().slice(1); const histExc = exc.filter(r => r[0].toString() === idMembre.toString()).map(r => ({ motif: r[2], montant: r[3], datePaiement: r[4] instanceof Date ? r[4].toLocaleDateString('fr-FR') : r[4] })).reverse();
  return { info: info, mensuels: histMens, exceps: histExc };
}

// Google Sheets convertissait automatiquement "2026-08-19" en date affichée
// "19/08/2026" ; on reproduit ce comportement pour l'affichage local.
function formatDateFR(d) {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const p = d.split('-');
    return p[2] + '/' + p[1] + '/' + p[0];
  }
  return d;
}

function getReunions() { const s = SS.getSheetByName(SHEET_REUNIONS);
  if (s.getLastRow() <= 1) return []; return s.getDataRange().getValues().slice(1).reverse().map(r => ({ id: r[0], date: r[1] instanceof Date ? r[1].toLocaleDateString('fr-FR') : formatDateFR(r[1]), objet: r[2], presents: r[3] || "", invites: r[4] || "", fileUrl: r[5] || "", lieu: r[6] || "", heure: r[7] || "", heureFin: r[8] || "" }));
}

function enregistrerReunion(d) {
  const s = SS.getSheetByName(SHEET_REUNIONS);
  const data = s.getDataRange().getValues();
  const row = [d.id || "R-"+Math.floor(Math.random()*9000+1000), d.date, d.objet, d.presents, d.invites, d.fileUrl, d.lieu || "", d.heure || "", d.heureFin || ""];

  if (d.id) {
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === d.id) {
        s.getRange(i + 1, 1, 1, 9).setValues([row]);
        return { status: "success", msg: "Compte rendu mis à jour !" };
      }
    }
  }
  s.appendRow(row);
  return { status: "success", msg: "Nouveau compte rendu archivé !" };
}

function supprimerReunion(id) {
  const s = SS.getSheetByName(SHEET_REUNIONS);
  const data = s.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      s.deleteRow(i + 1);
      return { status: "success", msg: "Réunion supprimée." };
    }
  }
}

// Contacts des membres indexés par identifiant
function contactsParId() {
  const s = SS.getSheetByName(SHEET_MEMBRES);
  const map = {};
  if (!s || s.getLastRow() <= 1) return map;
  s.getDataRange().getValues().slice(1).forEach(r => { map[String(r[0])] = String(r[3] || ''); });
  return map;
}

function getMensuels(m, a) { const s = SS.getSheetByName(SHEET_MENSUEL); if (s.getLastRow() <= 1) return []; let d = s.getDataRange().getValues().slice(1).reverse();
  if (accesMembre) d = d.filter(r => r[0].toString() === accesMembre.id);
  if (m) d = d.filter(r => r[2] === m); if (a) d = d.filter(r => r[3].toString() === a.toString());
  const contacts = contactsParId();
  return d.map(r => ({ nom: r[1], periode: r[2]+" "+r[3], montant: r[4], date: r[5] instanceof Date ? r[5].toLocaleDateString('fr-FR') : r[5], contact: contacts[String(r[0])] || '' }));
}

function getExceps(m) { const s = SS.getSheetByName(SHEET_EXCEP); if (s.getLastRow() <= 1) return []; let d = s.getDataRange().getValues().slice(1).reverse();
  if (accesMembre) d = d.filter(r => r[0].toString() === accesMembre.id);
  if (m) d = d.filter(r => r[2].toString().toUpperCase() === m.toUpperCase());
  const contacts = contactsParId();
  return d.map(r => ({ nom: r[1], motif: r[2], montant: r[3], date: r[4] instanceof Date ? r[4].toLocaleDateString('fr-FR') : r[4], contact: contacts[String(r[0])] || '' }));
}

function getDepenses() { const s = SS.getSheetByName(SHEET_DEPENSES); if (s.getLastRow() <= 1) return [];
  return s.getDataRange().getValues().slice(1).reverse().map(r => ({ motif: r[0], beneficiaire: r[1], montant: r[2], date: r[3] instanceof Date ? r[3].toLocaleDateString('fr-FR') : r[3] }));
}

function ajouterMembre(d) { SS.getSheetByName(SHEET_MEMBRES).appendRow(["M-"+Math.floor(Math.random()*9000+1000), d.nom.toUpperCase(), d.prenom, d.contact, d.ville, d.sexe]); return {status:"success", msg:"Membre ajouté !"};
}

// Corrige les informations d'un membre existant (identifié par son ID).
// Le nom est aussi répercuté dans les feuilles de cotisations pour
// que les historiques restent cohérents.
function modifierMembre(d) {
  if (accesMembre) return { status: "error", msg: "Action réservée au gestionnaire." };
  if (!d.id) return { status: "error", msg: "Membre introuvable." };
  if (!d.nom || !d.prenom || !d.contact) return { status: "error", msg: "Nom, prénom et contact obligatoires." };
  const s = SS.getSheetByName(SHEET_MEMBRES);
  const valeurs = s.getDataRange().getValues();
  const ligne = valeurs.findIndex((r, i) => i > 0 && r[0] && r[0].toString() === d.id);
  if (ligne < 0) return { status: "error", msg: "Membre introuvable." };
  const ancienNom = valeurs[ligne][1] ? valeurs[ligne][1].toString() : "";
  s.getRange(ligne + 1, 1, 1, 6).setValues([[d.id, d.nom.toUpperCase(), d.prenom, d.contact, d.ville || "", d.sexe || "M"]]);
  // Met à jour le nom affiché dans les historiques de cotisations
  const nouveauNom = d.nom.toUpperCase();
  [[SHEET_MENSUEL, 1], [SHEET_EXCEP, 1]].forEach(([feuille, colNom]) => {
    const f = SS.getSheetByName(feuille);
    if (!f || f.getLastRow() <= 1) return;
    const vals = f.getDataRange().getValues();
    for (let i = 1; i < vals.length; i++) {
      if (vals[i][0] && vals[i][0].toString() === d.id && vals[i][colNom] !== nouveauNom) {
        f.getRange(i + 1, colNom + 1, 1, 1).setValues([[nouveauNom]]);
      }
    }
  });
  return { status: "success", msg: "Informations de " + ancienNom + " mises à jour !" };
}

function enregistrerMensuel(d) { SS.getSheetByName(SHEET_MENSUEL).appendRow([d.idMembre, d.nomMembre.toUpperCase(), d.mois, d.annee, d.montant, new Date().toLocaleDateString('fr-FR'), d.typeCotis]); log.info("Mensualité encaissée", { evenement: "encaissement_mensuel", compteId: compteActif ? compteActif.id : null, membreId: d.idMembre, mois: d.mois, annee: d.annee, montant: Number(d.montant) || 0 }); return {status:"success", msg:"Paiement enregistré !"};
}

function enregistrerExcep(d) {
  SS.getSheetByName(SHEET_EXCEP).appendRow([d.idMembre, d.nomMembre.toUpperCase(), d.motif.toUpperCase(), d.montant, new Date().toLocaleDateString('fr-FR')]);
  // Notification push aux MEMBRES (nom de la cotisation + montant).
  // Attendue : le résultat est compté dans la réponse (diagnostic).
  const nomAssoc = compteActif ? (getAssocInfos().nom || "L'association") : '';
  const envoi = push.notifierTous(compteActif ? compteActif.id : null,
    'Nouvelle cotisation exceptionnelle',
    `${nomAssoc} : ${String(d.motif).toUpperCase()} — ${Number(d.montant).toLocaleString('fr-FR')} FCFA`)
    .catch(e => { log.error('Échec d\'envoi des notifications (cotisation exceptionnelle)', { error: { message: e && e.message } }); return { envoyees: 0 }; });
  return envoi.then(r => { log.info("Cotisation exceptionnelle encaissée", { evenement: "encaissement_excep", compteId: compteActif ? compteActif.id : null, membreId: d.idMembre, motif: String(d.motif || "").toUpperCase(), montant: Number(d.montant) || 0, membresNotifies: r.envoyees || 0 }); return {status:"success", msg:"Cotisation enregistrée !", membresNotifies: r.envoyees || 0}; });
}

// Sortie de caisse : objet + date + somme. La date saisie (format
// input date yyyy-mm-dd) est convertie en jj/mm/aaaa, comme tout
// l'historique ; sans date -> jour de l'enregistrement.
function enregistrerDepense(d) {
  const date = d.date ? formatDateFR(d.date) : new Date().toLocaleDateString('fr-FR');
  SS.getSheetByName(SHEET_DEPENSES).appendRow([d.motif.toUpperCase(), "", d.montant, date]);
  // Notification push aux MEMBRES (objet + somme de la sortie).
  const nomAssoc = compteActif ? (getAssocInfos().nom || "L'association") : '';
  const envoi = push.notifierTous(compteActif ? compteActif.id : null,
    "Nouvelle sortie d'argent",
    `${nomAssoc} : ${String(d.motif).toUpperCase()} — ${Number(d.montant).toLocaleString('fr-FR')} FCFA`)
    .catch(e => { log.error('Échec d\'envoi des notifications (sortie d\'argent)', { error: { message: e && e.message } }); return { envoyees: 0 }; });
  return envoi.then(r => { log.info("Sortie d'argent validée", { evenement: "sortie", compteId: compteActif ? compteActif.id : null, objet: String(d.motif || "").toUpperCase(), montant: Number(d.montant) || 0, membresNotifies: r.envoyees || 0 }); return {status:"success", msg:"Sortie validée !", membresNotifies: r.envoyees || 0}; });
}

function getTypesExcep() { const s = SS.getSheetByName(SHEET_TYPES_EXCEP);
  if (!s || s.getLastRow() <= 1) return []; return s.getDataRange().getValues().slice(1).map((r, i) => ({ id: i + 2, label: r[0].toString().toUpperCase(), montant: r[1] }));
}

function enregistrerTypeExcep(d) {
  const s = SS.getSheetByName(SHEET_TYPES_EXCEP);
  const row = [d.label.toUpperCase(), d.montant];
  if (d.id) {
    // Modification d'un motif existant : pas de notification
    s.getRange(d.id, 1, 1, 2).setValues([row]);
    return { status: "success", msg: "Motif sauvegardé !" };
  }
  // NOUVEL événement de cotisation créé : les MEMBRES sont prévenus
  // (nom de la cotisation + montant à participer).
  s.appendRow(row);
  const nomAssoc = compteActif ? (getAssocInfos().nom || "L'association") : '';
  const envoi = push.notifierTous(compteActif ? compteActif.id : null,
    'Nouvelle cotisation exceptionnelle',
    `${nomAssoc} : ${String(d.label).toUpperCase()} — ${Number(d.montant).toLocaleString('fr-FR')} FCFA. Pensez à votre participation.`)
    .catch(e => { log.error('Échec d\'envoi des notifications (nouveau motif)', { error: { message: e && e.message } }); return { envoyees: 0 }; });
  return envoi.then(r => ({ status: "success", msg: "Motif sauvegardé !", membresNotifies: r.envoyees || 0 }));
}

// Mensualité UNIQUE : un seul montant pour toute l'association,
// libellé fixe « MENSUALITÉ ». getMensualiteConfig normalise au
// passage les anciennes listes de types (une ligne conservée).
function getMensualiteConfig() {
  const s = SS.getSheetByName(SHEET_TYPES_MENSUELS);
  const rows = s.getDataRange().getValues().slice(1).filter(r => r[0] !== "");
  if (!rows.length) return null;
  const montant = Number(rows[0][1]) || 0;
  if (rows.length > 1 || rows[0][0] !== "MENSUALITÉ") {
    if (s.getLastRow() > 1) s.deleteRows(2, s.getLastRow() - 1);
    s.getRange(2, 1, 1, 2).setValues([["MENSUALITÉ", montant]]);
  }
  return { label: "MENSUALITÉ", montant: montant };
}

function majMontantMensualite(montant) {
  const m = Number(montant);
  if (!m || m <= 0) return { status: "error", msg: "Montant invalide." };
  const s = SS.getSheetByName(SHEET_TYPES_MENSUELS);
  if (s.getLastRow() > 1) s.deleteRows(2, s.getLastRow() - 1);
  if (s.getLastRow() === 1) s.appendRow(["MENSUALITÉ", m]);
  else s.getRange(2, 1, 1, 2).setValues([["MENSUALITÉ", m]]);
  return { status: "success", msg: "Montant de la mensualité enregistré !" };
}

function getTypesMensuels() { const s = SS.getSheetByName(SHEET_TYPES_MENSUELS); if (s.getLastRow() <= 1) return [];
  return s.getDataRange().getValues().slice(1).map((r, i) => ({ id: i + 2, label: r[0], montant: r[1] }));
}

function enregistrerTypeMensuel(d) { const s = SS.getSheetByName(SHEET_TYPES_MENSUELS); if (d.id) { s.getRange(d.id, 1, 1, 2).setValues([[d.label.toUpperCase(), d.montant]]); } else { s.appendRow([d.label.toUpperCase(), d.montant]);
  } return { status: "success", msg: "Mensualité configurée !" }; }

function getAssocInfos() { const s = SS.getSheetByName(SHEET_INFOS);
  const d = s.getDataRange().getValues(); if (d.length <= 1) return { nom: "", tel: "", adresse: "", email: "", logo: "" };
  return { nom: d[1][0]||"", tel: d[1][1]||"", adresse: d[1][2]||"", email: d[1][3]||"", logo: d[1][4]||"" }; }

function saveAssocInfos(d) {
  // Garde-fou : sans classeur actif (contexte de la requête), on ne
  // écrit JAMAIS — cela éviterait d'écraser la fiche d'une AUTRE
  // association avec un classeur resté en mémoire.
  if (!SS) return { status: "error", msg: "Aucun espace actif." };
  const s = SS.getSheetByName(SHEET_INFOS);
  if (s.getLastRow() > 1) s.deleteRows(2, s.getLastRow() - 1); s.appendRow([d.nom, d.tel, d.adresse, d.email, d.logo]);
  return { status: "success", msg: "Identité mise à jour !" };
}

function getBureau() { const v = SS.getSheetByName(SHEET_BUREAU).getDataRange().getValues();
  return v.length <= 1 ? [] : v.slice(1).map(r => ({ nom: r[1], poste: r[2] }));
}

// Postes du bureau : définis par CHAQUE association selon sa
// propre composition (Président, Imam, Sages, Commissaire…)
function getPostes() { const s = SS.getSheetByName(SHEET_POSTES); if (s.getLastRow() <= 1) return [];
  return s.getDataRange().getValues().slice(1).map((r, i) => ({ id: i + 2, label: r[0] })).filter(p => p.label !== ""); }

function enregistrerPoste(d) {
  const s = SS.getSheetByName(SHEET_POSTES);
  const nouveau = String(d.label).toUpperCase();
  if (d.id) {
    const data = s.getDataRange().getValues();
    const ancien = data[d.id - 1] ? data[d.id - 1][0] : null;
    s.getRange(d.id, 1, 1, 1).setValues([[nouveau]]);
    // Les nominations déjà enregistrées suivent le renommage
    if (ancien && ancien !== nouveau) {
      const b = SS.getSheetByName(SHEET_BUREAU);
      const bd = b.getDataRange().getValues();
      for (let i = 1; i < bd.length; i++) {
        if (bd[i][2] === ancien) b.getRange(i + 1, 3, 1, 1).setValues([[nouveau]]);
      }
    }
  } else {
    s.appendRow([nouveau]);
  }
  return { status: "success", msg: "Poste enregistré !" };
}

function supprimerPoste(id) { SS.getSheetByName(SHEET_POSTES).deleteRow(id); return { status: "success", msg: "Poste supprimé." }; }

function nommerMembre(d) { SS.getSheetByName(SHEET_BUREAU).appendRow([d.idMembre, d.nomMembre.toUpperCase(), d.poste, new Date().toLocaleDateString('fr-FR')]);
  return { status: "success", msg: "Nomination réussie !" }; }

function supprimerTypeExcep(id) { SS.getSheetByName(SHEET_TYPES_EXCEP).deleteRow(id); return { status: "success", msg: "Motif supprimé." }; }

function supprimerTypeMensuel(id) { SS.getSheetByName(SHEET_TYPES_MENSUELS).deleteRow(id); return { status: "success", msg: "Supprimée." }; }

// Équivalent de DriveApp — stockage des PV PDF :
//  - mode PostgreSQL (Render/Supabase) : en base (table fichiers),
//    servis par /fichiers/<compte>/<nom> — ils survivent aux
//    redéploiements.
//  - mode fichiers local : uploads/MUTASSO_PV/<id>/
async function uploadFileToDrive(fileData, fileName) {
  try {
    const bytes = Buffer.from(fileData.split(',')[1], 'base64');
    const dossierCompte = compteActif ? compteActif.id : 'commun';
    const safeName = String(fileName).replace(/[^\w.\-]/g, '_');
    if (config.MODE_PG) {
      await store.pgEnregistrerFichier(dossierCompte, safeName, bytes.toString('base64'));
      return '/fichiers/' + dossierCompte + '/' + encodeURIComponent(safeName);
    }
    const dir = path.join(__dirname, 'uploads', 'MUTASSO_PV', dossierCompte);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safeName), bytes);
    return '/uploads/MUTASSO_PV/' + dossierCompte + '/' + encodeURIComponent(safeName);
  } catch (err) {
    return "Erreur_Drive : " + err.message;
  }
}

// --- FONCTION SPÉCIALE JUSTE POUR DÉBLOQUER L'AUTORISATION ---
// (Google uniquement : inutile en local, conservée pour mémoire)
function autoriserDrive() {}

// Clé API Gemini : variable d'environnement en production
// (GEMINI_API_KEY dans .env en local, ou dans Render)
const GEMINI_API_KEY = config.GEMINI_API_KEY;

async function genererPV_IA(notes, objet, date) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY;

  let nomAssoc = "l'Association";
  try { nomAssoc = getAssocInfos().nom || "l'Association"; } catch(e) {}

  const prompt = `Tu es le Secrétaire Général de l'association "${nomAssoc}". Tu rédiges le CORPS du compte rendu officiel de la réunion :
- Ordre du jour (fixé par le secrétaire, à respecter TEL QUEL) : ${objet}
- Date : ${date}
- Notes brutes du secrétaire : ${notes}

RÈGLE ABSOLUE DE FIDÉLITÉ AU CONTENU : les notes sont ta SEULE source d'information. Tu reformules et tu formalises ce qu'elles contiennent, mais tu n'ajoutes RIEN : aucun fait, aucune décision, aucun montant, aucune date, aucun nom, aucun événement et aucune heure qui ne figurent pas explicitement dans les notes. Si une information manque, tu t'abstiens — jamais de remplissage plausible.

STRUCTURE IMPOSÉE :
1. Ne répète ni le titre, ni l'ordre du jour, ni les informations de séance (date, lieu, heures, présidence, présents) : tout est déjà affiché par l'application. Commence directement par la première section.
2. Une section par point de l'ordre du jour, DANS L'ORDRE donné : « I. », « II. », « III. » … (autant de sections que de points). Chaque titre de section est le libellé du point correspondant, en chiffre romain suivi du libellé en majuscules (ex. : « I. COTISATIONS »), seul sur sa ligne. Chaque section : 1 à 3 paragraphes denses, compacts et justifiés — jamais une phrase par ligne.
3. Si les notes contiennent des éléments qui ne correspondent à aucun point de l'ordre du jour, regroupe-les dans une dernière section « DIVERS ». Si un point de l'ordre du jour n'a aucun écho dans les notes, écris uniquement : « Ce point n'a pas fait l'objet de développements particuliers. »
4. Ne conclus par AUCUNE formule de levée de séance (elle est ajoutée automatiquement par l'application).

STYLE (registre administratif soutenu) :
- Passé composé à la troisième personne : « … a informé l'assistance que… », « il a été rappelé que… », « il a été décidé que… ».
- Vocabulaire administratif précis : diligences, requête, exhorter, instruire, désigner, conformément aux textes, porté à la connaissance.
- Connecteurs logiques : Tout d'abord, Ensuite, Par ailleurs, En outre, Néanmoins, Enfin.
- Réutilise les noms propres EXACTS des notes, orthographe identique.
- Espaces insécables avant les doubles ponctuations (; : ! ?), pas d'espace avant la virgule ou le point, guillemets français (« ») uniquement.
- INTERDIT : markdown (*, **, #), guillemets anglais, langage familier, abréviations non standard.

Rédige le corps du compte rendu :`;

  const payload = { "contents": [{ "parts": [{ "text": prompt }] }] };

  try {
    // Équivalent local de UrlFetchApp.fetch
    const response = await fetch(url, { method: "post", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = JSON.parse(await response.text());
    if (result.error) return "Erreur_IA : " + result.error.message;
    // Normalisation typographique : guillemets français obligatoires
    return result.candidates[0].content.parts[0].text
      .replace(/\s*"\s*([^"\n]+?)\s*"\s*/g, ' « $1 » ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  } catch (e) {
    return "Erreur_Serveur_IA : " + e.toString();
  }
}

// ============================================================
// RAPPORTS DE GESTION (à ce jour / sur période)
// ============================================================
const MOIS_ADMIN = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

// Appel Gemini mutualisé (utilisé par genererPV_IA et genererRapportIA)
async function appelerGemini(prompt) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY;
  const payload = { "contents": [{ "parts": [{ "text": prompt }] }] };
  const response = await fetch(url, { method: "post", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = JSON.parse(await response.text());
  if (result.error) return "Erreur_IA : " + result.error.message;
  return result.candidates[0].content.parts[0].text
    .replace(/\s*"\s*([^"\n]+?)\s*"\s*/g, ' « $1 » ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// --- Rapport À CE JOUR : situation de chaque adhérent ---
function getRapportJour() {
  const membres = getMembres();
  const now = new Date();
  const moisCourant = MOIS_ADMIN[now.getMonth()];
  const annee = now.getFullYear();

  const etatMens = getEtatPaiements('mensuel', moisCourant, String(annee));
  const aJour = etatMens.filter(x => x.aPaye).map(x => x.id);
  const nonAJour = etatMens.filter(x => !x.aPaye).map(x => x.id);

  const events = getTypesExcep().map(t => {
    const payeurs = getEtatPaiements('excep', t.label, null).filter(x => x.aPaye).map(x => x.id);
    return { label: t.label, montant: Number(t.montant) || 0, payeurs: payeurs, nbPayeurs: payeurs.length };
  });

  const mens = SS.getSheetByName(SHEET_MENSUEL).getDataRange().getValues().slice(1).filter(r => r[0] !== "");
  const exc = SS.getSheetByName(SHEET_EXCEP).getDataRange().getValues().slice(1).filter(r => r[0] !== "");
  const dep = SS.getSheetByName(SHEET_DEPENSES).getDataRange().getValues().slice(1).filter(r => r[0] !== "");
  const totMens = mens.reduce((a, r) => a + (Number(r[4]) || 0), 0);
  const totExc = exc.reduce((a, r) => a + (Number(r[3]) || 0), 0);
  const totDep = dep.reduce((a, r) => a + (Number(r[2]) || 0), 0);
  const cfg = getMensualiteConfig();

  return {
    type: "jour", genereLe: now.toLocaleDateString('fr-FR'),
    moisCourant: moisCourant, anneeCourante: annee,
    effectif: membres.length, mensualiteMontant: cfg ? cfg.montant : 0,
    membres: membres.map(m => ({ id: m.id, nom: m.nom + ' ' + m.prenom })),
    aJour: aJour, nonAJour: nonAJour,
    events: events,
    finances: { nbMens: mens.length, totMens: totMens, nbExc: exc.length, totExc: totExc, nbDep: dep.length, totDep: totDep, solde: totMens + totExc - totDep }
  };
}

// --- Rapport sur PÉRIODE : bilan financier entre deux mois ---
function getRapportPeriode(m1, a1, m2, a2) {
  const k1 = a1 * 12 + (m1 - 1), k2 = a2 * 12 + (m2 - 1);
  if (k2 < k1) return { status: "error", msg: "Période invalide : la fin précède le début." };
  const cle = d => { const p = String(d).split('/'); return p.length === 3 ? (Number(p[2]) * 12) + (Number(p[1]) - 1) : -1; };
  const dans = d => { const k = cle(d); return k >= k1 && k <= k2; };

  const mens = SS.getSheetByName(SHEET_MENSUEL).getDataRange().getValues().slice(1).filter(r => r[0] !== "" && dans(r[5]));
  const exc = SS.getSheetByName(SHEET_EXCEP).getDataRange().getValues().slice(1).filter(r => r[0] !== "" && dans(r[4]));
  const dep = SS.getSheetByName(SHEET_DEPENSES).getDataRange().getValues().slice(1).filter(r => r[0] !== "" && dans(r[3]));

  // Détail mensuel et par motif
  const parMois = {};
  mens.forEach(r => { const k = String(r[2]) + ' ' + r[3]; if (!parMois[k]) parMois[k] = { nb: 0, total: 0 }; parMois[k].nb++; parMois[k].total += Number(r[4]) || 0; });
  const parMotif = {};
  exc.forEach(r => { const k = String(r[2]); if (!parMotif[k]) parMotif[k] = { nb: 0, total: 0 }; parMotif[k].nb++; parMotif[k].total += Number(r[3]) || 0; });

  const totMens = mens.reduce((a, r) => a + (Number(r[4]) || 0), 0);
  const totExc = exc.reduce((a, r) => a + (Number(r[3]) || 0), 0);
  const totDep = dep.reduce((a, r) => a + (Number(r[2]) || 0), 0);

  return {
    type: "periode", genereLe: new Date().toLocaleDateString('fr-FR'),
    debut: MOIS_ADMIN[m1 - 1] + ' ' + a1, fin: MOIS_ADMIN[m2 - 1] + ' ' + a2,
    effectif: getMembres().length,
    parMois: parMois, parMotif: parMotif,
    finances: { nbMens: mens.length, totMens: totMens, nbExc: exc.length, totExc: totExc, nbDep: dep.length, totDep: totDep, solde: totMens + totExc - totDep }
  };
}

/* ============================================================
// RAPPORT LIBRE — la demande est traitée comme un PROMPT :
//   chaque intention y est détectée (composition du bureau,
//   liste des adhérents, mensualités, retards, exceptionnelles,
//   dépenses, caisse/solde, période) et le document contient
//   EXACTEMENT les sections demandées — rien d'autre.
//   Aucune IA externe : analyse et rédaction par ce moteur.
// ============================================================ */
function sansAccent(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

// Analyse la demande : période visée + intentions reconnues
function analyserDemandeRapport(demande) {
  const t = sansAccent(demande);
  const auj = new Date();
  const nomsMois = MOIS_ADMIN.map(sansAccent);
  const abreges = ['janv', 'fev', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sept', 'oct', 'nov', 'dec'];

  // Mois cités, dans l'ordre d'apparition dans la phrase
  const moisCites = [];
  nomsMois.forEach((nom, i) => {
    if (new RegExp('\\b' + nom + '\\b').test(t) || new RegExp('\\b' + abreges[i] + '\\b').test(t)) {
      if (!moisCites.includes(i)) moisCites.push(i);
    }
  });
  const anneesCitees = [...t.matchAll(/\b(20\d{2})\b/g)].map(m => parseInt(m[1], 10));
  const annee = anneesCitees.length ? anneesCitees[0] : auj.getFullYear();

  let debut = null, fin = null, libelle = 'À CE JOUR';
  if (moisCites.length >= 2) {
    debut = { m: moisCites[0] + 1, a: annee };
    fin = { m: moisCites[1] + 1, a: annee };
    if (debut.m > fin.m) { const b = debut; debut = fin; fin = b; }
    libelle = MOIS_ADMIN[debut.m - 1].toUpperCase() + (debut.m === fin.m ? '' : ' — ' + MOIS_ADMIN[fin.m - 1].toUpperCase()) + ' ' + fin.a;
  } else if (moisCites.length === 1) {
    debut = fin = { m: moisCites[0] + 1, a: annee };
    libelle = MOIS_ADMIN[moisCites[0]].toUpperCase() + ' ' + annee;
  } else if (/(l'?)?annee derniere|precedente/.test(t)) {
    debut = { m: 1, a: auj.getFullYear() - 1 }; fin = { m: 12, a: auj.getFullYear() - 1 };
    libelle = 'ANNÉE ' + (auj.getFullYear() - 1);
  } else if (/cette annee|annee en cours|sur l'annee|de l'annee/.test(t)) {
    debut = { m: 1, a: auj.getFullYear() }; fin = { m: auj.getMonth() + 1, a: auj.getFullYear() };
    libelle = 'ANNÉE ' + auj.getFullYear();
  } else if (/ce mois|mois en cours|mensualite du mois/.test(t)) {
    debut = fin = { m: auj.getMonth() + 1, a: auj.getFullYear() };
    libelle = MOIS_ADMIN[auj.getMonth()].toUpperCase() + ' ' + auj.getFullYear();
  }

  // Intentions : chaque bloc demandé apparaîtra dans le document.
  // « membres du bureau » => bureau ; « membres » seul => effectif.
  const intents = {
    bureau: /bureau|comite|dirigeant|poste/.test(t),
    membres: (/\bmembres?\b|\badherents?\b|effectif/.test(t)) && !/bureau|comite|dirigeant/.test(t),
    mensuel: /mensual|mensuel/.test(t),
    excep: /exceptionnel|special|evenement/.test(t),
    depenses: /depense|sortie/.test(t),
    retards: /retard|impaye|reliquat|non payes|restant/.test(t),
    solde: /solde|caisse|tresorerie|bilan/.test(t)
  };
  // Aucune intention reconnue -> rapport de gestion général
  const general = !Object.values(intents).some(Boolean);
  if (general) { intents.mensuel = intents.excep = intents.depenses = intents.solde = true; }

  return { periode: debut ? { debut: debut, fin: fin } : null, libelle: libelle, intents: intents, general: general };
}

// Rédige la synthèse : un paragraphe par intention demandée,
// uniquement sur des chiffres réels.
function redigerSyntheseRapport(demande, C) {
  const F = n => Number(n || 0).toLocaleString('fr-FR');
  const I = C.intents;
  const p = [];

  p.push(`Le présent rapport est établi à la demande du Bureau de ${C.nomAssoc} et répond point par point à la requête suivante : « ${String(demande).trim()} ». ${C.periode ? 'Les données financières retenues couvrent la période de ' + C.debutLib + ' à ' + C.finLib + '.' : 'Les données financières retenues couvrent l\'ensemble des opérations enregistrées à ce jour.'} Il est rappelé que, conformément au règlement de l'association, toutes les cotisations — mensuelles et exceptionnelles — sont obligatoires et s'imposent à l'ensemble des membres.`);

  if (I.bureau) {
    if (C.bureau.length) {
      const enumeration = C.bureau.map(b => `le poste de ${b.poste} est occupé par ${b.nom}`).join(' ; ');
      p.push(`S'agissant de la gouvernance, le bureau compte actuellement ${C.bureau.length} membre${C.bureau.length > 1 ? 's' : ''} en fonction : ${enumeration}.`);
    } else {
      p.push(`Aucun membre du bureau n'est actuellement enregistré dans l'application ; il conviendra de régulariser la composition du comité.`);
    }
  }

  if (I.membres) {
    const villes = Object.keys(C.parVille).sort((a, b) => C.parVille[b] - C.parVille[a]).slice(0, 2)
      .map(v => `${v} (${C.parVille[v]})`).join(' et ');
    p.push(`L'effectif de l'association s'établit à ${C.effectif} membres enregistrés, dont ${C.nbHommes} hommes et ${C.nbFemmes} femmes${villes ? `, principalement résidant à ${villes}` : ''}.`);
  }

  if (I.mensuel || I.excep || I.solde || I.depenses) {
    if (C.fi.nbMens > 0 || C.fi.nbExc > 0) {
      let ph = `Au titre de la période, ${C.fi.nbMens} mensualités ont été encaissées pour un montant de ${F(C.fi.totMens)} FCFA`;
      if (C.fi.nbExc > 0) {
        const premiers = C.motifsDetail.slice(0, 2).map(e => `« ${e.label} » (${F(e.total)} FCFA pour ${e.nb} cotisation${e.nb > 1 ? 's' : ''})`).join(' et ');
        ph += `, auxquelles s'ajoutent ${C.fi.nbExc} cotisations exceptionnelles totalisant ${F(C.fi.totExc)} FCFA${C.motifsDetail.length ? ', dont ' + premiers : ''}`;
      }
      p.push(ph + '.');
    } else {
      p.push(`Aucune cotisation n'a été enregistrée sur la période considérée. Il appartiendra au Bureau de diligenter les relances nécessaires auprès des membres concernés.`);
    }
  }

  if (I.retards && C.retards && C.retards.total > 0) {
    p.push(`S'agissant de la mensualité de ${C.moisCourant}, ${C.retards.aJour} membres sur ${C.effectif} ont satisfait à leur obligation, soit un taux de recouvrement de ${C.retards.taux} % ; ${C.retards.total} membre${C.retards.total > 1 ? 's' : ''} reste${C.retards.total > 1 ? 'nt' : ''} redevable${C.retards.total > 1 ? 's' : ''} du montant obligatoire de ${F(C.mensualite)} FCFA et est invité${C.retards.total > 1 ? 's' : ''} à procéder à la régularisation sans délai. Le Bureau est prié de poursuivre les diligences de recouvrement engagées à cet effet.`);
  }

  if (I.depenses || I.solde || I.mensuel || I.excep) {
    let ph = '';
    if (C.fi.nbDep > 0) {
      ph = `Par ailleurs, ${C.fi.nbDep} sortie${C.fi.nbDep > 1 ? 's' : ''} de caisse ${C.fi.nbDep > 1 ? 'ont été' : 'a été'} opérée${C.fi.nbDep > 1 ? 's' : ''} pour ${F(C.fi.totDep)} FCFA${C.depensesTop ? ', principalement ' + C.depensesTop : ''}. `;
    }
    const entrees = C.fi.totMens + C.fi.totExc;
    ph += `Au total, les entrées de la période s'élèvent à ${F(entrees)} FCFA ; `;
    ph += C.fi.solde >= 0
      ? `la caisse présente un solde disponible de ${F(C.fi.solde)} FCFA, traduisant une gestion maîtrisée.`
      : `les sorties excèdent les entrées de ${F(Math.abs(C.fi.solde))} FCFA, situation qui appelle une vigilance particulière du Bureau.`;
    p.push(ph);
  }

  return p.join('\n\n');
}

// Contexte COMPLET de l'association (JSON) transmis à l'IA : elle
// n'a le droit d'utiliser QUE ces données — aucun chiffre inventé.
function contexteCompletRapport() {
  const infos = getAssocInfos();
  const membres = getMembres();
  const bureau = SS.getSheetByName(SHEET_BUREAU).getDataRange().getValues().slice(1)
    .filter(r => r[1] && String(r[1]).trim() !== "")
    .map(r => ({ nom: String(r[1]), poste: String(r[2] || ''), nommeLe: r[3] instanceof Date ? r[3].toLocaleDateString('fr-FR') : String(r[3] || '') }));
  const lignesMens = SS.getSheetByName(SHEET_MENSUEL).getDataRange().getValues().slice(1).filter(r => r[0] !== "");
  const lignesExc = SS.getSheetByName(SHEET_EXCEP).getDataRange().getValues().slice(1).filter(r => r[0] !== "");
  const lignesDep = SS.getSheetByName(SHEET_DEPENSES).getDataRange().getValues().slice(1).filter(r => r[0] !== "");
  const dFR = d => d instanceof Date ? d.toLocaleDateString('fr-FR') : String(d || '');

  const auj = new Date();
  const moisCourant = MOIS_ADMIN[auj.getMonth()] + ' ' + auj.getFullYear();
  const etat = getEtatPaiements('mensuel', MOIS_ADMIN[auj.getMonth()], String(auj.getFullYear()));
  const cfg = getMensualiteConfig();

  return {
    association: { nom: infos.nom, contact: infos.tel, email: infos.email, mensualite: cfg ? cfg.montant : 0, dateDuJour: auj.toLocaleDateString('fr-FR'), moisCourant: moisCourant,
      reglement: "Toutes les cotisations — mensuelles ET exceptionnelles — sont OBLIGATOIRES pour l'ensemble des membres, conformément au règlement de l'association." },
    effectif: membres.length,
    membres: membres.map(m => ({ nom: m.nom, prenom: m.prenom, contact: m.contact, ville: m.ville, sexe: m.sexe })),
    bureau: bureau,
    mensualites: lignesMens.map(r => ({ membre: String(r[1]), mois: String(r[2]), annee: String(r[3]), montant: Number(r[4]) || 0, payeLe: dFR(r[5]) })),
    exceptionnelles: lignesExc.map(r => ({ membre: String(r[1]), motif: String(r[2]), montant: Number(r[3]) || 0, payeLe: dFR(r[4]) })),
    depenses: lignesDep.map(r => ({ objet: String(r[0]), montant: Number(r[2]) || 0, date: dFR(r[3]) })),
    mensualitesMoisCourant: {
      aJour: etat.filter(x => x.aPaye).map(x => x.nom + ' ' + x.prenom),
      enRetard: etat.filter(x => !x.aPaye).map(x => x.nom + ' ' + x.prenom)
    },
    // AGRÉGATS OFFICIELS calculés par l'application : exacts par
    // construction — l'IA doit les reprendre tels quels pour tout
    // total ou classement (elle ne sait pas sommer 400+ lignes).
    agregats: {
      cotisationsTotalesParMembre: (function () {
        const t = {};
        lignesMens.forEach(r => { const n = String(r[1]); t[n] = t[n] || { mensuelles: 0, exceptionnelles: 0 }; t[n].mensuelles += Number(r[4]) || 0; });
        lignesExc.forEach(r => { const n = String(r[1]); t[n] = t[n] || { mensuelles: 0, exceptionnelles: 0 }; t[n].exceptionnelles += Number(r[3]) || 0; });
        return Object.keys(t).map(n => ({ membre: n, mensuelles: t[n].mensuelles, exceptionnelles: t[n].exceptionnelles, total: t[n].mensuelles + t[n].exceptionnelles }))
          .sort((a, b) => b.total - a.total);
      })(),
      mensualitesParMois: (function () {
        const t = {};
        lignesMens.forEach(r => { const k = String(r[2]) + ' ' + r[3]; t[k] = t[k] || { paiements: 0, total: 0 }; t[k].paiements++; t[k].total += Number(r[4]) || 0; });
        return t;
      })(),
      exceptionnellesParMotif: (function () {
        const t = {};
        lignesExc.forEach(r => { const k = String(r[2]); t[k] = t[k] || { cotisations: 0, total: 0 }; t[k].cotisations++; t[k].total += Number(r[3]) || 0; });
        return t;
      })(),
      depensesParObjet: (function () {
        const t = {};
        lignesDep.forEach(r => { const k = String(r[0]); t[k] = t[k] || { sorties: 0, total: 0 }; t[k].sorties++; t[k].total += Number(r[2]) || 0; });
        return t;
      })(),
      bilan: {
        totalMensuelles: lignesMens.reduce((a, r) => a + (Number(r[4]) || 0), 0),
        totalExceptionnelles: lignesExc.reduce((a, r) => a + (Number(r[3]) || 0), 0),
        totalDepenses: lignesDep.reduce((a, r) => a + (Number(r[2]) || 0), 0),
        nbPaiementsMensuels: lignesMens.length, nbExceptionnelles: lignesExc.length, nbDepenses: lignesDep.length
      }
    }
  };
}

// Appelle Gemini en imposant une réponse JSON strict.
async function appelerGeminiJSON(prompt) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      response_mime_type: "application/json"
    }
  };
  const response = await fetch(url, { method: "post", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = JSON.parse(await response.text());
  if (result.error) throw new Error(result.error.message);
  const texte = result.candidates[0].content.parts[0].text;
  return texte.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
}

// Le PROMPT pilote le rapport : l'IA structure la réponse à partir
// des données réelles ; en cas d'échec API, le moteur de règles
// (analyserDemandeRapport) prend le relais.
async function getRapportLibre(demande) {
  if (!demande || !String(demande).trim()) return { status: "error", msg: "Décrivez d'abord le rapport souhaité." };
  const auj = new Date();
  const infos = getAssocInfos();
  const nomAssoc = (infos.nom || "L'Association").toUpperCase();
  const contactAssoc = [infos.tel, infos.email].filter(Boolean).join(' • ');

  const commun = {
    status: "success", type: "libre",
    demande: String(demande).trim(),
    libellePeriode: 'SUR MESURE',
    genereLe: auj.toLocaleDateString('fr-FR'),
    nomAssoc: nomAssoc, contactAssoc: contactAssoc, logo: infos.logo || "",
    effectif: getMembres().length
  };

  try {
    if (!GEMINI_API_KEY) throw new Error('Clé IA absente');
    const ctx = contexteCompletRapport();
    const prompt = `Tu es le Secrétaire Général de l'association "${nomAssoc}". On te fournit les DONNÉES de l'association (JSON) et une DEMANDE en français. Produis UNIQUEMENT un JSON valide (aucun texte autour) exactement de cette forme :
{"synthese": "...", "sections": [{"titre": "I. ...", "entetes": ["...", "..."], "lignes": [["...", "..."], ...]}, ...]}

DEMANDE : ${String(demande).trim()}

RÈGLES ABSOLUES :
1. Le rapport répond EXACTEMENT à la demande : les sections correspondent précisément à ce qui est demandé, dans cet ordre. Si la demande porte sur une seule chose (ex : liste des membres du bureau), le rapport ne contient QUE cette chose.
2. N'utilise AUCUN nom, montant, date ou chiffre absent des DONNÉES. Aucune invention, aucune estimation.
3. CALCULS : pour TOUT total, classement, décompte ou moyenne globale, utilise les « agregats » fournis dans les DONNÉES — ils sont calculés par l'application et EXACTS : reprends leurs valeurs telles quelles, sans les recalculer ni les modifier. Les listes détaillées (mensualites, exceptionnelles, depenses) servent aux listes nominales et au filtrage par période. Un montant faux invalide le rapport entier.
4. RÈGLE DE FOND — OBLIGATION DE COTISER : conformément au règlement de l'association (voir association.reglement dans les DONNÉES), TOUTES les cotisations — mensuelles ET exceptionnelles — sont OBLIGATOIRES pour l'ensemble des membres. Le rapport doit refléter cette obligation : un membre n'ayant pas cotisé est un membre REDEVABLE (en retard de règlement, et non un simple « non-payeur » facultatif) ; la synthèse emploie le vocabulaire de l'obligation (redevable, régularisation, recouvrement, conformément au règlement) et, lorsque des membres n'ont pas cotisé, elle le souligne et invite explicitement à la régularisation.
5. "synthese" : 2 à 4 paragraphes denses en français administratif soutenu (passé composé, vocabulaire officiel : diligences, recouvrement, conformément…), qui répondent à la demande en reprenant les chiffres pertinents des données. Pas de titre dans la synthèse, pas de markdown.
6. "sections" : 1 à 6 sections. Titres numérotés en chiffres romains (I., II., III.…), en MAJUSCULES, décrivant leur contenu. 2 à 4 entetes de colonnes courts. Une ligne par élément pour une liste. Cellules = textes courts (montants au format "12 345 FCFA").
7. Si une période est déduisible de la demande (mois, année, intervalle), filtre les données datées en conséquence (dates "jj/mm/aaaa").
8. Réponds en JSON strict, sans balise markdown.

DONNÉES :
${JSON.stringify(ctx)}`;

    const brut = await appelerGeminiJSON(prompt);
    const r = JSON.parse(brut);
    if (!r || typeof r.synthese !== 'string' || !Array.isArray(r.sections) || !r.sections.length) throw new Error('Structure IA invalide');
    const romainsFixes = ['I', 'II', 'III', 'IV', 'V', 'VI'];
    const sections = r.sections.slice(0, 6).map((s, i) => ({
      titre: romainsFixes[i] + '. ' + String(s.titre || '').replace(/^(?:[IVXivx]+|\d+)\s*[.\-)]\s*/, '').replace(/^(?:SECTION|Section)\s*\d*\s*[.\-)]?\s*/i, '').trim(),
      entetes: Array.isArray(s.entetes) ? s.entetes.slice(0, 4).map(e => String(e)) : ['Désignation', 'Détail'],
      monetaire: /FCFA/i.test(JSON.stringify(s.lignes || []).slice(0, 400)),
      lignes: (Array.isArray(s.lignes) ? s.lignes : []).slice(0, 200).map(l => (Array.isArray(l) ? l : [l]).slice(0, 4).map(c => String(c)))
    })).filter(s => s.lignes.length);

    log.info("Rapport généré (IA)", { evenement: "rapport", compteId: compteActif ? compteActif.id : null, role: accesMembre ? 'membre' : 'admin', demande: String(demande).trim().slice(0, 120) });
    return { ...commun, moteur: 'ia', synthese: r.synthese.trim(), sections: sections, solde: '' };
  } catch (e) {
    log.warn('Rapport IA indisponible — repli sur le moteur de règles', { error: { message: e && e.message } });
    const r = getRapportLibreRegles(demande);
    return { ...r, moteur: 'regles' };
  }
}

// Moteur de REPLI (sans IA) : intentions détectées par règles
// sont produites (bureau, effectif, retards, finances, bilan).
function getRapportLibreRegles(demande) {
  if (!demande || !String(demande).trim()) return { status: "error", msg: "Décrivez d'abord le rapport souhaité." };
  const analyse = analyserDemandeRapport(demande);
  const I = analyse.intents;
  const auj = new Date();
  const infos = getAssocInfos();
  const nomAssoc = (infos.nom || "L'Association").toUpperCase();
  const contactAssoc = [infos.tel, infos.email].filter(Boolean).join(' • ');
  const membres = getMembres();
  const cfg = getMensualiteConfig();
  const F = n => Number(n || 0).toLocaleString('fr-FR');

  // --- Données financières sur la période ---
  let mens, exc, dep;
  if (analyse.periode) {
    const P = analyse.periode;
    const k1 = P.debut.a * 12 + (P.debut.m - 1), k2 = P.fin.a * 12 + (P.fin.m - 1);
    const cle = d => { const q = String(d).split('/'); return q.length === 3 ? (Number(q[2]) * 12) + (Number(q[1]) - 1) : -1; };
    const dans = d => { const k = cle(d); return k >= k1 && k <= k2; };
    mens = SS.getSheetByName(SHEET_MENSUEL).getDataRange().getValues().slice(1).filter(r => r[0] !== "" && dans(r[5]));
    exc = SS.getSheetByName(SHEET_EXCEP).getDataRange().getValues().slice(1).filter(r => r[0] !== "" && dans(r[4]));
    dep = SS.getSheetByName(SHEET_DEPENSES).getDataRange().getValues().slice(1).filter(r => r[0] !== "" && dans(r[3]));
  } else {
    mens = SS.getSheetByName(SHEET_MENSUEL).getDataRange().getValues().slice(1).filter(r => r[0] !== "");
    exc = SS.getSheetByName(SHEET_EXCEP).getDataRange().getValues().slice(1).filter(r => r[0] !== "");
    dep = SS.getSheetByName(SHEET_DEPENSES).getDataRange().getValues().slice(1).filter(r => r[0] !== "");
  }
  const totMens = mens.reduce((a, r) => a + (Number(r[4]) || 0), 0);
  const totExc = exc.reduce((a, r) => a + (Number(r[3]) || 0), 0);
  const totDep = dep.reduce((a, r) => a + (Number(r[2]) || 0), 0);
  const parMois = {};
  mens.forEach(r => { const k = String(r[2]) + ' ' + r[3]; if (!parMois[k]) parMois[k] = { nb: 0, total: 0 }; parMois[k].nb++; parMois[k].total += Number(r[4]) || 0; });
  const parMotif = {};
  exc.forEach(r => { const k = String(r[2]); if (!parMotif[k]) parMotif[k] = { nb: 0, total: 0 }; parMotif[k].nb++; parMotif[k].total += Number(r[3]) || 0; });
  const parDep = {};
  dep.forEach(r => { const k = String(r[0]); if (!parDep[k]) parDep[k] = { nb: 0, total: 0 }; parDep[k].nb++; parDep[k].total += Number(r[2]) || 0; });
  const motifsDetail = Object.keys(parMotif).map(k => ({ label: k, nb: parMotif[k].nb, total: parMotif[k].total }));
  const depensesTop = Object.keys(parDep).sort((a, b) => parDep[b].total - parDep[a].total).slice(0, 2)
    .map(k => `${k.toLowerCase()} (${F(parDep[k].total)} FCFA)`).join(' puis ');

  // --- Bureau et effectif (état actuel) ---
  const bureau = SS.getSheetByName(SHEET_BUREAU).getDataRange().getValues().slice(1)
    .filter(r => r[1] && String(r[1]).trim() !== "")
    .map(r => ({ nom: String(r[1]), poste: String(r[2] || ''), date: r[3] instanceof Date ? r[3].toLocaleDateString('fr-FR') : (String(r[3] || '')) }));
  const parVille = {};
  membres.forEach(m => { if (m.ville) parVille[m.ville] = (parVille[m.ville] || 0) + 1; });
  const nbHommes = membres.filter(m => m.sexe === 'M').length;

  // --- Retards du mois courant ---
  const moisCourant = MOIS_ADMIN[auj.getMonth()];
  const etat = getEtatPaiements('mensuel', moisCourant, String(auj.getFullYear()));
  const nbAJour = etat.filter(x => x.aPaye).length;
  const retardataires = etat.filter(x => !x.aPaye);
  const retards = { aJour: nbAJour, total: membres.length - nbAJour, taux: membres.length ? Math.round(nbAJour / membres.length * 100) : 0 };

  // --- Sections : uniquement ce que la demande mentionne ---
  const romains = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  const sections = [];
  let n = 0;
  if (I.bureau) {
    sections.push({
      titre: romains[n++] + '. COMPOSITION DU BUREAU',
      entetes: ['Membre', 'Poste', 'Nommé le'],
      lignes: bureau.length ? bureau.map(b => [b.nom.toUpperCase(), b.poste, b.date || '—']) : [['Aucun membre du bureau enregistré.', '—', '—']]
    });
  }
  if (I.membres) {
    sections.push({
      titre: romains[n++] + '. LISTE DES ADHÉRENTS',
      entetes: ['N°', 'Nom et prénoms', 'Contact', 'Ville'],
      lignes: membres.map((m, i) => [String(i + 1), (m.nom + ' ' + m.prenom).toUpperCase(), m.contact || '—', m.ville || '—'])
    });
  }
  if (I.retards) {
    sections.push({
      titre: romains[n++] + '. SITUATION DES RETARDS — MENSUALITÉ ' + moisCourant.toUpperCase() + ' ' + auj.getFullYear(),
      entetes: ['Membre en retard', 'Contact'],
      lignes: retardataires.length
        ? retardataires.map(x => [(x.nom + ' ' + x.prenom).toUpperCase(), x.contact || '—'])
        : [['Aucun retard constaté sur le mois en cours.', '—']]
    });
  }
  if (I.mensuel) sections.push({
    titre: romains[n++] + '. COTISATIONS MENSUELLES',
    entetes: ['Mois', 'Paiements — Encaissé'], monetaire: true,
    lignes: Object.keys(parMois).map(k => [k, parMois[k].nb + ' — ' + F(parMois[k].total) + ' FCFA'])
  });
  if (I.excep) sections.push({
    titre: romains[n++] + '. COTISATIONS EXCEPTIONNELLES',
    entetes: ['Événement', 'Cotisations — Encaissé'], monetaire: true,
    lignes: motifsDetail.map(e => [e.label.toUpperCase(), e.nb + ' — ' + F(e.total) + ' FCFA'])
  });
  if (I.depenses) sections.push({
    titre: romains[n++] + '. DÉPENSES',
    entetes: ['Objet', 'Sorties — Montant'], monetaire: true,
    lignes: Object.keys(parDep).map(k => [k.toUpperCase(), parDep[k].nb + ' — ' + F(parDep[k].total) + ' FCFA'])
  });
  if (I.solde || (!analyse.general && (I.mensuel || I.excep || I.depenses))) sections.push({
    titre: romains[n++] + '. BILAN FINANCIER' + (analyse.periode ? ' DE LA PÉRIODE' : ' DEPUIS LA CRÉATION'),
    entetes: ['Désignation', 'Montant'], monetaire: true,
    lignes: [
      ['Cotisations mensuelles (' + mens.length + ' paiements)', F(totMens) + ' FCFA'],
      ['Cotisations exceptionnelles (' + exc.length + ' cotisations)', F(totExc) + ' FCFA'],
      ['Total des entrées', F(totMens + totExc) + ' FCFA', true],
      ['Dépenses (' + dep.length + ' opérations)', '− ' + F(totDep) + ' FCFA'],
      ['SOLDE', F(totMens + totExc - totDep) + ' FCFA', true]
    ]
  });
  if (!sections.length) sections.push({ titre: 'I. RAPPORT', entetes: ['Désignation', 'Détail'], lignes: [['Effectif', membres.length + ' membres']] });

  const contexte = {
    nomAssoc: nomAssoc, effectif: membres.length, mensualite: cfg ? cfg.montant : 0,
    periode: analyse.periode, intents: I,
    debutLib: analyse.periode ? MOIS_ADMIN[analyse.periode.debut.m - 1].toLowerCase() + ' ' + analyse.periode.debut.a : '',
    finLib: analyse.periode ? MOIS_ADMIN[analyse.periode.fin.m - 1].toLowerCase() + ' ' + analyse.periode.fin.a : '',
    fi: { nbMens: mens.length, totMens: totMens, nbExc: exc.length, totExc: totExc, nbDep: dep.length, totDep: totDep, solde: totMens + totExc - totDep },
    motifsDetail: motifsDetail, depensesTop: depensesTop,
    bureau: bureau, parVille: parVille, nbHommes: nbHommes, nbFemmes: membres.length - nbHommes,
    retards: retards, moisCourant: moisCourant
  };

  return {
    status: "success",
    type: "libre",
    demande: String(demande).trim(),
    libellePeriode: analyse.libelle,
    genereLe: auj.toLocaleDateString('fr-FR'),
    nomAssoc: nomAssoc, contactAssoc: contactAssoc, logo: infos.logo || "",
    effectif: membres.length,
    synthese: redigerSyntheseRapport(demande, contexte),
    sections: sections,
    solde: F(totMens + totExc - totDep) + ' FCFA'
  };
}

// --- Synthèse rédigée par l'IA à partir des données du rapport ---
async function genererRapportIA(d) {
  let nomAssoc = "l'Association";
  try { nomAssoc = getAssocInfos().nom || nomAssoc; } catch (e) {}
  const F = n => Number(n || 0).toLocaleString('fr-FR');
  const lignes = [];
  let intro = "";

  if (d.type === "jour") {
    intro = `du rapport de gestion à ce jour (${d.genereLe})`;
    lignes.push(`- Effectif : ${d.effectif} membres ; mensualité unique : ${F(d.mensualiteMontant)} FCFA par mois.`);
    lignes.push(`- Mensualité ${d.moisCourant} ${d.anneeCourante} : ${d.aJour.length} membres à jour, ${d.nonAJour.length} en retard.`);
    d.events.forEach(e => lignes.push(`- Cotisation exceptionnelle « ${e.label} » (${F(e.montant)} FCFA) : ${e.nbPayeurs} payeurs sur ${d.effectif}.`));
    lignes.push(`- Bilan financier depuis la création : mensualités ${F(d.finances.totMens)} FCFA (${d.finances.nbMens} paiements), exceptionnelles ${F(d.finances.totExc)} FCFA (${d.finances.nbExc}), dépenses ${F(d.finances.totDep)} FCFA, SOLDE ${F(d.finances.solde)} FCFA.`);
  } else {
    intro = `du rapport de gestion de la période ${d.debut} à ${d.fin}`;
    lignes.push(`- Effectif : ${d.effectif} membres.`);
    Object.keys(d.parMois).forEach(k => lignes.push(`- ${k} : ${d.parMois[k].nb} mensualités, ${F(d.parMois[k].total)} FCFA.`));
    Object.keys(d.parMotif).forEach(k => lignes.push(`- Exceptionnelles « ${k} » : ${d.parMotif[k].nb} cotisations, ${F(d.parMotif[k].total)} FCFA.`));
    lignes.push(`- Dépenses de la période : ${F(d.finances.totDep)} FCFA ; SOLDE de la période : ${F(d.finances.solde)} FCFA.`);
  }

  const prompt = `Tu es le Secrétaire Général de l'association "${nomAssoc}". Rédige la SYNTHÈSE ${intro}, uniquement à partir des données chiffrées suivantes (n'invente RIEN, n'ajoute aucun chiffre ni fait absent) :
${lignes.join('\n')}

CONSIGNES :
- 3 à 4 paragraphes denses en registre administratif soutenu, prêts à être insérés dans un rapport officiel.
- Structure suggérée : situation générale des cotisations, puis points d'attention (retardataires, événements faiblement cotisés ou dépenses notables), puis conclusion sur la santé financière (solde).
- Réutilise uniquement les chiffres fournis, éventuellement en calculant des parts simples (pourcentages de taux de paiement).
- Pas de titre, pas de markdown (*, **, #), pas de guillemets anglais, pas de formule de levée de séance.
- Ne mentionne ni la date de génération, ni ton nom : commence directement par le premier paragraphe.

Rédige la synthèse :`;
  try {
    return await appelerGemini(prompt);
  } catch (e) {
    return "Erreur_Serveur_IA : " + e.toString();
  }
}

// Petite fonction pour tester l'appel à l'IA
async function testAutorisationIA() {
  return appelerGemini("Réponds uniquement : OK");
}

// --- Portage de configuration.gs : initialiserMUTASSO ---
// Crée les feuilles standard dans le classeur ACTIF (celui de
// l'association connectée) — sans toucher aux autres comptes.
function initialiserMUTASSO() {
  TABLES_STANDARD.forEach(t => {
    let sheet = SS.getSheetByName(t.name);
    if (!sheet) { sheet = SS.insertSheet(t.name); }
    sheet.getRange(1, 1, 1, t.headers.length).setValues([t.headers]).setBackground("#1e293b").setFontColor("white").setFontWeight("bold");
  });
  return "MUTASSO v6.2 Initialisé.";
}

// Confort local : une mensualité et un motif spécial par défaut
// pour que les menus soient utilisables immédiatement.
// Les POSTES ne sont PAS pré-remplis : chaque association définit
// sa propre composition de bureau (page Bureau).
function seedDefaults() {
  const tm = SS.getSheetByName(SHEET_TYPES_MENSUELS);
  if (tm.getLastRow() <= 1) tm.appendRow(["MENSUALITÉ", 1000]);
  const te = SS.getSheetByName(SHEET_TYPES_EXCEP);
  if (te.getLastRow() <= 1) te.appendRow(["AIDE SOCIALE", 5000]);
}

module.exports = {
  getMembres, getDashboardStats, getChartData, getEtatPaiements, getMembreProfile,
  getReunions, enregistrerReunion, supprimerReunion, getMensuels, getExceps, getDepenses,
  ajouterMembre, modifierMembre, enregistrerMensuel, enregistrerExcep, enregistrerDepense,
  getTypesExcep, enregistrerTypeExcep, getTypesMensuels, enregistrerTypeMensuel, getMensualiteConfig, majMontantMensualite,
  getAssocInfos, saveAssocInfos, getBureau, getPostes, nommerMembre, enregistrerPoste, supprimerPoste,
  supprimerTypeExcep, supprimerTypeMensuel, uploadFileToDrive, autoriserDrive,
  genererPV_IA, testAutorisationIA, initialiserMUTASSO, seedDefaults,
  getRapportJour, getRapportPeriode, getRapportLibre, genererRapportIA,
  compteExiste, creerCompte, connexion, verifierToken, verifierSession, activerCompte, infosCompte, majIdentite, majMotDePasse,
  genererMdpMembre, supprimerAccesMembre, majMotDePasseMembre, idsAccesMembres,
  clePubliquePush, abonnerPush, testPushPerso, compterAbonnementsMembres,
  getVueGlobale, reinitialiserMdpAssociation, supprimerAssociation
};
