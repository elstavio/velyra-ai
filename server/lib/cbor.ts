/**
 * Décodeur CBOR minimal (RFC 8949), suffisant pour WebAuthn : entiers, chaînes d'octets/texte, tableaux et
 * tables (longueur définie uniquement — c'est exactement ce que produisent les navigateurs pour
 * attestationObject et les clés publiques COSE ; pas d'indéfini, de date, de bignum ni de tag exotique).
 * Zero dépendance : évite d'ajouter une bibliothèque CBOR tierce pour ce seul besoin.
 */
class Cursor {
  constructor(public buf: Buffer, public pos = 0) {}
  u8() { return this.buf[this.pos++]; }
  bytes(n: number) { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
}

function readLength(c: Cursor, info: number): number {
  if (info < 24) return info;
  if (info === 24) return c.u8();
  if (info === 25) { const b = c.bytes(2); return b.readUInt16BE(0); }
  if (info === 26) { const b = c.bytes(4); return b.readUInt32BE(0); }
  if (info === 27) { const b = c.bytes(8); const n = b.readBigUInt64BE(0); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR : entier trop grand'); return Number(n); }
  throw new Error('CBOR : longueur indéfinie non prise en charge');
}

function decodeOne(c: Cursor): unknown {
  if (c.pos >= c.buf.length) throw new Error('CBOR : fin de flux inattendue');
  const first = c.u8();
  const major = first >> 5, info = first & 0x1f;
  switch (major) {
    case 0: return readLength(c, info); // unsigned int
    case 1: return -1 - readLength(c, info); // negative int
    case 2: return Buffer.from(c.bytes(readLength(c, info))); // byte string
    case 3: return c.bytes(readLength(c, info)).toString('utf8'); // text string
    case 4: { const n = readLength(c, info); const arr: unknown[] = []; for (let i = 0; i < n; i++) arr.push(decodeOne(c)); return arr; }
    case 5: { const n = readLength(c, info); const map = new Map<unknown, unknown>(); for (let i = 0; i < n; i++) { const k = decodeOne(c); const v = decodeOne(c); map.set(k, v); } return map; }
    case 6: { readLength(c, info); return decodeOne(c); } // tag : on ignore le tag, on décode la valeur
    case 7:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      throw new Error('CBOR : type simple/flottant non pris en charge');
    default:
      throw new Error('CBOR : type majeur invalide');
  }
}

/** Décode la première valeur CBOR en tête du buffer et retourne aussi l'offset de fin (utile quand d'autres octets suivent). */
export function cborDecodeWithOffset(buf: Buffer): { value: unknown; offset: number } {
  const c = new Cursor(buf);
  const value = decodeOne(c);
  return { value, offset: c.pos };
}
export function cborDecode(buf: Buffer): unknown {
  return cborDecodeWithOffset(buf).value;
}
