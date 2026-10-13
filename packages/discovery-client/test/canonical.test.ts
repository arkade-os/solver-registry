import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCardSig } from "../src/canonical.ts";
import { KEYS, makeMarket, signed } from "./helpers.ts";

test("verifyCardSig: the signer's card verifies in any key order; tampered or malformed is false, never a throw", () => {
  const card = signed({ version: 0, name: "alice", discovery_pubkey: KEYS[0].pk, markets: [makeMarket()] });
  assert.equal(verifyCardSig(card), true);
  const { sig, markets, ...rest } = card;
  assert.equal(verifyCardSig({ markets, sig, ...rest }), true);

  assert.equal(verifyCardSig({ ...card, name: "bob" }), false);
  assert.equal(verifyCardSig({ ...card, discovery_pubkey: KEYS[1].pk }), false);
  assert.equal(verifyCardSig({ ...card, sig: "zz" }), false);
  assert.equal(verifyCardSig({ ...card, sig: undefined }), false);
  assert.equal(verifyCardSig({ ...card, discovery_pubkey: 7 as never }), false);
});
