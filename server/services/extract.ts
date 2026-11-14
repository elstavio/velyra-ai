import { bad } from '../lib/util.js';

/**
 * Extraction de texte depuis un fichier importé (PDF ou Word). Utilise pdf-parse et mammoth
 * (voir package.json). Ces paquets ne sont pas installés dans certains environnements de
 * développement isolés (sans accès au registre npm) : dans ce cas on échoue proprement avec un
 * message honnête plutôt que de prétendre avoir lu le fichier.
 */
const MAX_FILE_BYTES = 6_000_000;

export type SupportedMime = 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function missingModule(name: string): never {
  throw bad('extractor_unavailable', `Lecture indisponible : le module « ${name} » n'est pas installé sur ce serveur. Exécutez npm install puis redéployez.`);
}

export async function extractFromUpload(mime: unknown, filename: unknown, dataBase64: unknown): Promise<{ text: string; kind: 'pdf' | 'docx' }> {
  const type = String(mime ?? '').toLowerCase();
  const name = String(filename ?? 'document').toLowerCase();
  const b64 = String(dataBase64 ?? '');
  if (!b64) throw bad('file_required', 'Aucun fichier reçu');
  let buf: Buffer;
  try { buf = Buffer.from(b64, 'base64'); } catch { throw bad('invalid_file', 'Fichier illisible'); }
  if (!buf.length) throw bad('invalid_file', 'Fichier vide');
  if (buf.length > MAX_FILE_BYTES) throw bad('file_too_large', `Fichier trop volumineux (maximum ${Math.round(MAX_FILE_BYTES / 1_000_000)} Mo)`);

  const isPdf = type.includes('pdf') || name.endsWith('.pdf');
  const isDocx = type.includes('wordprocessingml') || name.endsWith('.docx');
  if (isPdf) {
    let pdfParse: any;
    try { ({ default: pdfParse } = await import('pdf-parse')); } catch { missingModule('pdf-parse'); }
    let out: any;
    try { out = await pdfParse(buf); } catch (e: any) { throw bad('extract_failed', `Impossible de lire ce PDF : ${String(e?.message ?? e).slice(0, 160)}`); }
    const text = String(out?.text ?? '').trim();
    if (!text) throw bad('extract_empty', 'Aucun texte trouvé dans ce PDF (image scannée sans reconnaissance de caractères non prise en charge).');
    return { text, kind: 'pdf' };
  }
  if (isDocx) {
    let mammoth: any;
    try { mammoth = await import('mammoth'); } catch { missingModule('mammoth'); }
    let out: any;
    try { out = await mammoth.extractRawText({ buffer: buf }); } catch (e: any) { throw bad('extract_failed', `Impossible de lire ce fichier Word : ${String(e?.message ?? e).slice(0, 160)}`); }
    const text = String(out?.value ?? '').trim();
    if (!text) throw bad('extract_empty', 'Aucun texte trouvé dans ce document Word.');
    return { text, kind: 'docx' };
  }
  throw bad('unsupported_type', 'Formats pris en charge : PDF (.pdf) et Word (.docx). Pour les autres formats, collez le texte directement.');
}
