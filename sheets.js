// ============================================================
// MUTASSO PRO v6.2 — sheets.js
// Émulation de Google Sheets avec DEUX modes de persistance :
//  - FICHIERS (local) : data/comptes.json + data/comptes/<id>.json
//  - POSTGRES (Supabase, si DATABASE_URL) : tables comptes /
//    classeurs / fichiers — voir store.js
// Dans les deux cas, les opérations se font en mémoire (mêmes
// classes Sheet/Range que toujours) puis sont persistées :
// immédiatement (fichiers) ou au flush de fin de requête (PG).
// ============================================================
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');

const DATA_DIR = path.join(__dirname, 'data');
const COMPTES_DIR = path.join(DATA_DIR, 'comptes');
const REGISTRE_FILE = path.join(DATA_DIR, 'comptes.json');

/* ============ Registre global des comptes ============ */
let registre = null;           // cache mémoire
let registreSale = false;

async function lireRegistre() {
  if (registre) return registre;
  if (config.MODE_PG) {
    registre = await store.pgLireRegistre();
  } else {
    try { registre = JSON.parse(fs.readFileSync(REGISTRE_FILE, 'utf8')); }
    catch (e) { registre = []; }
  }
  return registre;
}

async function sauverRegistre() {
  if (!registre) return;
  if (config.MODE_PG) { registreSale = true; marquerFlushGlobal(); }
  else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REGISTRE_FILE, JSON.stringify(registre, null, 2));
  }
}

function ajouterAuRegistre(entree) { registre.push(entree); sauverRegistre(); return entree; }
function majEntreeRegistre(entree) {
  const i = registre.findIndex(e => e.id === entree.id);
  if (i >= 0) registre[i] = entree;
  sauverRegistre();
}
function marquerFlushGlobal() {
  if (!config.MODE_PG) return;
  registreSale = true;
  flushNecessaire = true;
}

/* ============ Classeur d'une association ============ */
// Cache mémoire : compteId -> { tables, sale, fichier }
const cacheClasseurs = new Map();
let flushNecessaire = false;

class Range {
  constructor(classeur, sheet, row, col, numRows, numCols) {
    this.classeur = classeur; this.sheet = sheet;
    this.row = row; this.col = col;
    this.numRows = numRows; this.numCols = numCols;
  }
  getValues() {
    const rows = this.sheet._rows();
    const values = [];
    for (let i = 0; i < this.numRows; i++) {
      const r = this.row - 1 + i;
      const src = rows[r] || [];
      const line = [];
      for (let j = 0; j < this.numCols; j++) {
        const c = this.col - 1 + j;
        line.push(c < src.length ? src[c] : "");
      }
      values.push(line);
    }
    return values;
  }
  setValues(values) {
    const rows = this.sheet._rows();
    for (let i = 0; i < this.numRows; i++) {
      const r = this.row - 1 + i;
      while (rows.length <= r) rows.push([]);
      for (let j = 0; j < this.numCols; j++) {
        rows[r][this.col - 1 + j] = values[i][j];
      }
    }
    this.classeur.enregistrer();
    return this;
  }
  setBackground() { return this; }
  setFontColor() { return this; }
  setFontWeight() { return this; }
}

class Sheet {
  constructor(classeur, name) { this.classeur = classeur; this.name = name; }
  _rows() {
    const t = this.classeur.load();
    if (!t[this.name]) { t[this.name] = []; this.classeur.enregistrer(); }
    return t[this.name];
  }
  getLastRow() { return this._rows().length; }
  getDataRange() {
    const values = this._rows().map(r => r.slice());
    return { getValues: () => values };
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new Range(this.classeur, this, row, col, numRows, numCols);
  }
  appendRow(row) { this._rows().push(row.slice()); this.classeur.enregistrer(); }
  deleteRow(pos) { this._rows().splice(pos - 1, 1); this.classeur.enregistrer(); }
  deleteRows(start, num) { this._rows().splice(start - 1, num); this.classeur.enregistrer(); }
}

// Ouvre (ou recharge) le classeur d'une association.
// - mode fichiers : data/comptes/<id>.json
// - mode postgres : hydrate depuis la table classeurs
async function ouvrirClasseur(compteId) {
  const enCache = cacheClasseurs.get(compteId);
  if (enCache) return enCache.SS;

  const classeur = {
    compteId: compteId,
    tables: null,
    fichier: path.join(COMPTES_DIR, compteId + '.json'),
    load() {
      if (this.tables) return this.tables;
      try { this.tables = JSON.parse(fs.readFileSync(this.fichier, 'utf8')); }
      catch (e) { this.tables = {}; }
      return this.tables;
    },
    enregistrer() {
      if (config.MODE_PG) { this.sale = true; flushNecessaire = true; }
      else {
        fs.mkdirSync(path.dirname(this.fichier), { recursive: true });
        fs.writeFileSync(this.fichier, JSON.stringify(this.tables, null, 2));
      }
    },
    sale: false
  };

  if (config.MODE_PG) {
    const data = await store.pgLireClasseur(compteId);
    classeur.tables = data || {};
  }

  const SS = {
    getSheetByName(name) {
      const t = classeur.load();
      return t[name] ? new Sheet(classeur, name) : null;
    },
    insertSheet(name) {
      const t = classeur.load();
      if (!t[name]) { t[name] = []; classeur.enregistrer(); }
      return new Sheet(classeur, name);
    }
  };
  cacheClasseurs.set(compteId, { classeur, SS });
  return SS;
}

// Persiste les classeurs modifiés (appelé après chaque requête).
async function flushPersistence() {
  if (!config.MODE_PG || !flushNecessaire) return;
  flushNecessaire = false;
  for (const { classeur } of cacheClasseurs.values()) {
    if (classeur.sale) {
      classeur.sale = false;
      await store.pgEcrireClasseur(classeur.compteId, classeur.tables);
    }
  }
  if (registreSale) {
    registreSale = false;
    await store.pgSauverRegistre(registre);
  }
}

module.exports = { ouvrirClasseur, lireRegistre, sauverRegistre, ajouterAuRegistre, majEntreeRegistre, flushPersistence, tablesDuClasseur, COMPTES_DIR };

// Tables brutes d'un classeur en cache (après chargement)
function tablesDuClasseur(compteId) {
  const c = cacheClasseurs.get(compteId);
  return c ? c.classeur.load() : null;
}
