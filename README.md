# MUTASSO PRO v6.2

Gestion complète d'associations et mutuelles : inscription/connexion par email,
membres, bureau (postes définis par l'association), cotisations mensuelles et
exceptionnelles, dépenses, reçus PDF, comptes rendus de réunion **rédigés par
l'IA (Gemini)**, rapports de gestion PDF, mode clair/sombre.

Chaque association inscrite dispose de **données totalement isolées**.

## Démarrage rapide (local)

```bash
npm install
cp .env.example .env   # renseignez GEMINI_API_KEY
npm start              # http://localhost:3000
```

Sans `DATABASE_URL`, l'application fonctionne en mode **fichiers locaux**
(`data/`) — aucune base à installer.

## Déploiement Render + Supabase

Voir **[DEPLOIEMENT-RENDER.md](DEPLOIEMENT-RENDER.md)** — mise en ligne en 4 étapes.
Le repo contient un `render.yaml` (blueprint) : Render configure le service
automatiquement, il ne reste qu'à définir `DATABASE_URL` et `GEMINI_API_KEY`.

## Architecture

| Fichier | Rôle |
|---|---|
| `server.js` | Serveur Express : interface + API `POST /api/<fonction>` + sonde `/api/health` |
| `config.js` | Configuration (lit `.env` puis l'environnement) |
| `store.js` | Persistance PostgreSQL (Supabase) : comptes, classeurs, fichiers — tables auto-créées |
| `sheets.js` | Émulation Google Sheets (double mode fichiers/PostgreSQL) |
| `backend.js` | Toutes les fonctions métier (mêmes noms que le Google Apps Script d'origine) |
| `public/index.html` | Interface complète (Tailwind, Lucide, Chart.js, html2pdf) |
| `public/gas-bridge.js` | Émulation `google.script.run` (XHR + token de session) |
| `migrer-vers-supabase.js` | Migration des données locales vers Supabase (`npm run migrer`) |

## Sécurité

- Mots de passe hachés (scrypt + sel), comparaisons à temps constant
- Token de session par compte, invalidé au changement de mot de passe
- Blocage 10 min après 5 tentatives de connexion échouées
- Isolation stricte des données par association (token → classeur dédié)
- Emails normalisés : pas de doublon d'inscription

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | URI PostgreSQL Supabase (mode en ligne) — vide = mode fichiers |
| `GEMINI_API_KEY` | Clé Google AI Studio (comptes rendus et rapports IA) |
| `PORT` | Port d'écoute (fourni par Render en production) |
