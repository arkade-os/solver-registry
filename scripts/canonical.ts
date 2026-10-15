// Fixture signing for tests; the digest and its verification live in the client.
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { cardDigest } from "../packages/discovery-client/src/canonical.ts";

export function signCard(card: Record<string, unknown>, privateKeyHex: string): string {
  return bytesToHex(schnorr.sign(cardDigest(card), hexToBytes(privateKeyHex)));
}
