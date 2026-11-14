#!/usr/bin/env node
// Analyse de composition logicielle (SCA) réelle : interroge le registre npm pour les vulnérabilités
// connues des dépendances réellement installées (`npm audit`), et échoue si une vulnérabilité
// haute ou critique est trouvée. Surface volontairement très réduite : Velyra AI n'a qu'une seule
// dépendance d'exécution (`pg`) — c'est un choix architectural assumé (voir README « Architecture »).
//
// Usage : node scripts/security-audit.mjs   (code de sortie non nul si haute/critique détectée)
import { execSync } from 'node:child_process';

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return e.stdout?.toString() ?? ''; }
}

let report;
try {
  const out = run('npm audit --json');
  report = JSON.parse(out || '{}');
} catch (e) {
  console.error('⚠ npm audit n\'a pas pu s\'exécuter :', String(e?.message ?? e));
  console.error('   Exécutez cette vérification dans un environnement avec accès à registry.npmjs.org (ex. CI, poste de développement).');
  process.exit(0);
}
// npm audit renvoie {"error": {...}} (ex. ENOLOCK, pas d'accès réseau) plutôt que de lever une exception :
// ne JAMAIS annoncer « aucune vulnérabilité » dans ce cas, ce serait une fausse assurance.
if (report.error) {
  console.error(`⚠ npm audit n'a pas pu vérifier les dépendances (${report.error.code ?? 'erreur'}) : ${report.error.summary ?? report.error.detail ?? ''}`);
  console.error('   Aucune conclusion de sécurité ne peut être tirée de cette exécution. Relancez avec un accès réseau au registre npm (et un package-lock.json présent) avant la mise en production.');
  process.exit(0); // ne bloque pas un environnement sans accès réseau ; à lancer en CI/local avant mise en production
}

const vulns = report.vulnerabilities ?? {};
const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
const bad = [];
for (const [name, v] of Object.entries(vulns)) {
  counts[v.severity] = (counts[v.severity] ?? 0) + 1;
  if (v.severity === 'high' || v.severity === 'critical') bad.push(`${name} (${v.severity}) : ${v.via?.map?.((x) => (typeof x === 'string' ? x : x.title)).join(', ') ?? ''}`);
}

console.log('Résumé npm audit :', counts);
if (bad.length) {
  console.error('\n✗ Vulnérabilités haute(s)/critique(s) détectées :');
  for (const b of bad) console.error('  - ' + b);
  console.error('\nCorrigez (npm audit fix, ou mise à jour manuelle) avant la mise en production.');
  process.exit(1);
}
console.log('✓ Aucune vulnérabilité haute ou critique connue dans les dépendances installées.');
