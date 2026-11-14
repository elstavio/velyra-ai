// Déclarations minimales pour des dépendances optionnelles chargées dynamiquement (voir services/extract.ts).
// Ces paquets ne sont pas toujours installés (environnements sans accès au registre npm) ; le code gère
// leur absence proprement à l'exécution. On ne type pas finement leur API : les usages passent par `any`.
declare module 'pdf-parse';
declare module 'mammoth';
