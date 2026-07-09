// Canonical JSON serialization and BIP340 helpers shared by the reducer and tests.
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";

// Per spec: the card serialized with `sig` removed, keys sorted lexicographically,
// no whitespace, UTF-8. Applied recursively so nested objects (e.g. markets[]) are
// also key-sorted, since a byte-identical hash requires a fully deterministic tree.
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(card: Record<string, unknown>): string {
  const { sig: _sig, ...rest } = card;
  return JSON.stringify(canonicalize(rest));
}

export function sha256(data: string): Buffer {
  return createHash("sha256").update(data, "utf8").digest();
}

export function cardDigest(card: Record<string, unknown>): Buffer {
  return sha256(canonicalJson(card));
}

export function verifyCardSig(card: {
  sig?: string;
  discovery_pubkey?: string;
}): boolean {
  if (!card.sig || !card.discovery_pubkey) return false;
  const digest = cardDigest(card as Record<string, unknown>);
  try {
    return schnorr.verify(card.sig, digest, card.discovery_pubkey);
  } catch {
    return false;
  }
}

// Used only by tests/fixture generation to produce a valid signed card fixture.
export function signCard(
  card: Record<string, unknown>,
  privateKeyHex: string,
): string {
  const digest = cardDigest(card);
  const sig = schnorr.sign(digest, privateKeyHex);
  return Buffer.from(sig).toString("hex");
}
