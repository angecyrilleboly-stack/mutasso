# Déploiement MUTASSO — Render + Supabase

Mise en ligne en 4 étapes (compte gratuit suffisant).

## 1. Créer la base sur Supabase

1. https://supabase.com → **New project** (ex. nom : `mutasso`, région Europe)
2. Une fois le projet prêt : **Project Settings → Database → Connection string → URI**
3. Copiez l'URI et remplacez `[YOUR-PASSWORD]` par le mot de passe choisi à la création :
   `postgresql://postgres.xxxx:VOTRE_MOT_DE_PASSE@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`

> Rien d'autre à faire : les tables (`comptes`, `classeurs`, `fichiers`) sont créées
> automatiquement au premier démarrage de l'application.

## 2. Créer le service sur Render

1. https://render.com → **New → Web Service**
2. Connectez le dépôt GitHub `mutasso`
3. Render lit le fichier `render.yaml` du repo : Runtime **Node**, plan **Free**, région **Frankfurt**, build `npm install`, start `node server.js`, sonde `/api/health`
4. Avant de créer, renseignez les **variables d'environnement** :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | l'URI Supabase de l'étape 1 |
| `GEMINI_API_KEY` | votre clé Google AI Studio (pour les comptes rendus IA) |

5. **Create Web Service** → attendez le build → ouvrez l'URL `https://mutasso-xxxx.onrender.com`

## 3. (Optionnel) Migrer vos données locales en ligne

Sur votre PC, renseignez `DATABASE_URL` dans le fichier `.env` du projet puis :

```bash
npm run migrer
```

Tous vos comptes, membres, cotisations et PV locaux sont copiés vers Supabase.

## 4. C'est en ligne

- L'écran d'inscription/connexion s'affiche sur l'URL publique
- Chaque association inscrite obtient son espace isolé
- Les PV PDF sont stockés **en base** : ils survivent aux redéploiements

## Notes

- Plan Free Render : le service s'endort après ~15 min d'inactivité (première connexion ~30 s)
- Une seule instance en plan Free : cohérence des données garantie
- Le mode local (fichiers) continue de fonctionner sans `DATABASE_URL` — idéal pour le développement
