// BIP340 card signatures over canonical JSON. noble is pure JS (no eval, no
// Node built-ins), so this stays as portable as the rest of the package.
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    // Null prototype: on `{}` a parsed "__proto__" key would set the prototype and drop out of the digest.
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) out[key] = canonicalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function cardDigest(card: Record<string, unknown>): Uint8Array {
  const { sig: _sig, ...rest } = card;
  return sha256(utf8ToBytes(JSON.stringify(canonicalize(rest))));
}

/** Whether `sig` is `discovery_pubkey`'s signature over the card. Malformed input is `false`, never a throw. */
export function verifyCardSig(card: { discovery_pubkey?: string; sig?: string }): boolean {
  if (!card.sig || !card.discovery_pubkey) return false;
  try {
    return schnorr.verify(hexToBytes(card.sig), cardDigest(card), hexToBytes(card.discovery_pubkey));
  } catch {
    return false;
  }
}
