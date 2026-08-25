// ============================================================
// MUTASSO — migrer-vers-supabase.js
// Pousse les données LOCALES (data/comptes.json + classeurs)
// vers la base PostgreSQL Supabase (DATABASE_URL dans .env).
// Usage : renseignez DATABASE_URL dans .env puis lancez
//         npm run migrer
// Idempotent : les comptes déjà présents en base sont mis à jour.
// ============================================================
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');

(async () => {
  if (!config.MODE_PG) {
    console.error('DATABASE_URL manquant dans .env — rien à migrer.');
    process.exit(1);
  }
  await store.initStore();

  // 1) Registre des comptes
  const registreLocal = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'comptes.json'), 'utf8'));
  await store.pgSauverRegistre(registreLocal);
  console.log('✓ Registre migré :', registreLocal.length, 'compte(s)');

  // 2) Classeurs de chaque association
  for (const c of registreLocal) {
    const fichier = path.join(__dirname, 'data', 'comptes', c.id + '.json');
    if (!fs.existsSync(fichier)) { console.log('– Pas de classeur local pour', c.email); continue; }
    const data = JSON.parse(fs.readFileSync(fichier, 'utf8'));
    await store.pgEcrireClasseur(c.id, data);
    console.log('✓ Classeur migré :', c.email, '(' + Object.keys(data).length + ' feuilles)');
  }

  // 3) PV PDF stockés sur disque (s'ils existent)
  const racinePv = path.join(__dirname, 'uploads', 'MUTASSO_PV');
  if (fs.existsSync(racinePv)) {
    for (const compteId of fs.readdirSync(racinePv)) {
      const dossier = path.join(racinePv, compteId);
      if (!fs.statSync(dossier).isDirectory()) continue;
      for (const nom of fs.readdirSync(dossier)) {
        const b64 = fs.readFileSync(path.join(dossier, nom)).toString('base64');
        await store.pgEnregistrerFichier(compteId, nom, b64);
        console.log('✓ PV migré :', compteId + '/' + nom);
      }
    }
  }

  console.log('--- Migration terminée ---');
  await store.fermerStore();
  process.exit(0);
})().catch(e => { console.error('Erreur de migration :', e.message); process.exit(1); });
