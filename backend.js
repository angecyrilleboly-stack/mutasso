// ============================================================
// MUTASSO PRO v6.2 — backend.js
// Reproduction locale du fichier "backend.gs" (Google Apps Script).
// Chaque fonction garde le même nom et le même comportement.
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ouvrirClasseur, lireRegistre, ajouterAuRegistre, majEntreeRegistre, tablesDuClasseur } = require('./sheets');
const config = require('./config');
const store = require('./store');

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
  { name: SHEET_TYPES_EXCEP, headers: ["Libellé", "Montant"] }
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
  return { status: "success", msg: "Compte créé ! Votre espace est prêt.", token: tokenPour(entree), infos: infosPubliques(entree) };
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
  if (!memesHash(hash, entree.hash)) {
    const nb = (etat ? etat.nb : 0) + 1;
    tentativesConnexion[emailNorm] = { nb: nb, bloqueJusqu: nb >= MAX_TENTATIVES ? Date.now() + DUREE_BLOCAGE_MS : 0 };
    if (nb >= MAX_TENTATIVES) return { status: "error", msg: "Trop de tentatives échouées. Compte bloqué 10 minutes." };
    return { status: "error", msg: `Email ou mot de passe incorrect. (${MAX_TENTATIVES - nb} tentative(s) restante(s))` };
  }
  delete tentativesConnexion[emailNorm];
  return { status: "success", msg: "Connexion réussie !", token: tokenPour(entree), infos: infosPubliques(entree) };
}

// Retourne l'id du compte correspondant au token, sinon null
async function verifierToken(token) {
  if (!token) return null;
  const entree = (await lireRegistre()).find(c => memesHash(tokenPour(c), token));
  return entree ? entree.id : null;
}

// Bascule le contexte de données sur l'association donnée.
// Si son classeur est neuf, les feuilles standard sont créées.
// NB : toutes les opérations feuilles sont synchrones, le
// basculement par requête est donc sans risque de mélange.
async function activerCompte(id) {
  const entree = (await lireRegistre()).find(c => c.id === id);
  if (!entree) return false;
  compteActif = entree;
  SS = await ouvrirClasseur(entree.id);
  const brut = tablesDuClasseur(entree.id) || {};
  let complet = TABLES_STANDARD.every(t => brut[t.name]);
  // Migration : anciens classeurs REUNIONS sans la colonne Heure_Fin
  if (brut.REUNIONS && brut.REUNIONS[0] && brut.REUNIONS[0].length < 9) complet = false;
  if (!complet) { initialiserMUTASSO(); seedDefaults(); }
  return true;
}

function infosCompte() { return compteActif ? infosPubliques(compteActif) : null; }

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

function getMembres() { const s = SS.getSheetByName(SHEET_MEMBRES); const v = s.getDataRange().getValues(); return v.length <= 1 ? [] : v.slice(1).filter(r => r[0] !== "").map(row => ({ id: row[0].toString(), nom: row[1].toString(), prenom: row[2].toString(), contact: row[3].toString(), ville: row[4].toString(), sexe: row[5].toString() })); }

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

// Contacts des membres indexés par identifiant (pour l'envoi WhatsApp)
function contactsParId() {
  const s = SS.getSheetByName(SHEET_MEMBRES);
  const map = {};
  if (!s || s.getLastRow() <= 1) return map;
  s.getDataRange().getValues().slice(1).forEach(r => { map[String(r[0])] = String(r[3] || ''); });
  return map;
}

function getMensuels(m, a) { const s = SS.getSheetByName(SHEET_MENSUEL); if (s.getLastRow() <= 1) return []; let d = s.getDataRange().getValues().slice(1).reverse();
  if (m) d = d.filter(r => r[2] === m); if (a) d = d.filter(r => r[3].toString() === a.toString());
  const contacts = contactsParId();
  return d.map(r => ({ nom: r[1], periode: r[2]+" "+r[3], montant: r[4], date: r[5] instanceof Date ? r[5].toLocaleDateString('fr-FR') : r[5], contact: contacts[String(r[0])] || '' }));
}

function getExceps(m) { const s = SS.getSheetByName(SHEET_EXCEP); if (s.getLastRow() <= 1) return []; let d = s.getDataRange().getValues().slice(1).reverse();
  if (m) d = d.filter(r => r[2].toString().toUpperCase() === m.toUpperCase());
  const contacts = contactsParId();
  return d.map(r => ({ nom: r[1], motif: r[2], montant: r[3], date: r[4] instanceof Date ? r[4].toLocaleDateString('fr-FR') : r[4], contact: contacts[String(r[0])] || '' }));
}

function getDepenses() { const s = SS.getSheetByName(SHEET_DEPENSES); if (s.getLastRow() <= 1) return [];
  return s.getDataRange().getValues().slice(1).reverse().map(r => ({ motif: r[0], beneficiaire: r[1], montant: r[2], date: r[3] instanceof Date ? r[3].toLocaleDateString('fr-FR') : r[3] }));
}

function ajouterMembre(d) { SS.getSheetByName(SHEET_MEMBRES).appendRow(["M-"+Math.floor(Math.random()*9000+1000), d.nom.toUpperCase(), d.prenom, d.contact, d.ville, d.sexe]); return {status:"success", msg:"Membre ajouté !"};
}

function enregistrerMensuel(d) { SS.getSheetByName(SHEET_MENSUEL).appendRow([d.idMembre, d.nomMembre.toUpperCase(), d.mois, d.annee, d.montant, new Date().toLocaleDateString('fr-FR'), d.typeCotis]); return {status:"success", msg:"Paiement enregistré !"};
}

function enregistrerExcep(d) { SS.getSheetByName(SHEET_EXCEP).appendRow([d.idMembre, d.nomMembre.toUpperCase(), d.motif.toUpperCase(), d.montant, new Date().toLocaleDateString('fr-FR')]); return {status:"success", msg:"Cotisation enregistrée !"};
}

function enregistrerDepense(d) { SS.getSheetByName(SHEET_DEPENSES).appendRow([d.motif.toUpperCase(), d.beneficiaire, d.montant, new Date().toLocaleDateString('fr-FR')]); return {status:"success", msg:"Sortie validée !"}; }

function getTypesExcep() { const s = SS.getSheetByName(SHEET_TYPES_EXCEP);
  if (!s || s.getLastRow() <= 1) return []; return s.getDataRange().getValues().slice(1).map((r, i) => ({ id: i + 2, label: r[0].toString().toUpperCase(), montant: r[1] }));
}

function enregistrerTypeExcep(d) { const s = SS.getSheetByName(SHEET_TYPES_EXCEP); const row = [d.label.toUpperCase(), d.montant]; if (d.id) { s.getRange(d.id, 1, 1, 2).setValues([row]);
  } else { s.appendRow(row); } return { status: "success", msg: "Motif sauvegardé !" };
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

function saveAssocInfos(d) { const s = SS.getSheetByName(SHEET_INFOS);
  if (s.getLastRow() > 1) s.deleteRows(2, s.getLastRow() - 1); s.appendRow([d.nom, d.tel, d.adresse, d.email, d.logo]);
  return { status: "success", msg: "Identité mise à jour !" }; }

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
  ajouterMembre, enregistrerMensuel, enregistrerExcep, enregistrerDepense,
  getTypesExcep, enregistrerTypeExcep, getTypesMensuels, enregistrerTypeMensuel, getMensualiteConfig, majMontantMensualite,
  getAssocInfos, saveAssocInfos, getBureau, getPostes, nommerMembre, enregistrerPoste, supprimerPoste,
  supprimerTypeExcep, supprimerTypeMensuel, uploadFileToDrive, autoriserDrive,
  genererPV_IA, testAutorisationIA, initialiserMUTASSO, seedDefaults,
  getRapportJour, getRapportPeriode, genererRapportIA,
  compteExiste, creerCompte, connexion, verifierToken, activerCompte, infosCompte, majIdentite, majMotDePasse
};
