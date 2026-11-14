import { HttpError } from './util.js';

/**
 * Couche de validation générique des corps JSON (défense en profondeur).
 *
 * Pourquoi ceci et pas un filtre de motifs (anti-SQLi/XSS) générique sur le contenu :
 * Velyra AI est un assistant IA — les messages de conversation, documents, mémoires, invites d'agents et
 * contenus de publication DOIVENT pouvoir contenir n'importe quel texte libre, y compris du code, des
 * extraits SQL, du HTML/JS (un utilisateur légitime peut demander « explique une injection SQL avec
 * DROP TABLE » ou « écris-moi une balise <script> »). Un filtre de motifs sur le CONTENU bloquerait donc
 * l'usage normal du produit. La protection contre l'injection vient d'ailleurs, déjà en place dans tout le
 * code : requêtes SQL exclusivement paramétrées ($1, $2…, jamais de concaténation), et chaque champ
 * structurel (email, pays, devise, canal, identifiants…) validé côté serveur par une liste blanche de
 * formats/valeurs (voir lib/util.ts `str`/`int`/`bad`), ce qui est structurellement plus sûr qu'une liste
 * noire de motifs. Ce module filtre donc uniquement la STRUCTURE des corps JSON entrants, jamais leur
 * contenu textuel :
 *  - clés de pollution de prototype (`__proto__`, `constructor`, `prototype`) à n'importe quelle profondeur ;
 *  - profondeur/nombre de clés/longueur de tableau excessifs (défense contre l'épuisement de ressources par
 *    un JSON pathologique, en plus de la limite de taille déjà en place sur le corps brut).
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 12;
const MAX_KEYS_PER_OBJECT = 500;
const MAX_ARRAY_LENGTH = 5000;

export function assertSafeJsonStructure(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) throw new HttpError(400, 'invalid_body', 'Corps de requête trop profondément imbriqué');
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) throw new HttpError(400, 'invalid_body', 'Tableau trop volumineux dans le corps de requête');
    for (const v of value) assertSafeJsonStructure(v, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > MAX_KEYS_PER_OBJECT) throw new HttpError(400, 'invalid_body', 'Trop de champs dans le corps de requête');
    for (const k of keys) {
      if (DANGEROUS_KEYS.has(k)) throw new HttpError(400, 'invalid_body', 'Champ non autorisé dans le corps de requête');
      assertSafeJsonStructure((value as Record<string, unknown>)[k], depth + 1);
    }
  }
}
