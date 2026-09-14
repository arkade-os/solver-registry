import { test } from "node:test";
import assert from "node:assert/strict";
import { NETWORKS } from "../src/types.ts";
import { REGISTRY_BASE_URL, REGISTRY_INDEX_URLS, defaultRegistryUrls, registryIndexUrl } from "../src/registries.ts";

test("REGISTRY_INDEX_URLS covers exactly NETWORKS, and has no testnet entry", () => {
  assert.deepEqual(Object.keys(REGISTRY_INDEX_URLS).sort(), [...NETWORKS].sort());
  assert.equal(Object.hasOwn(REGISTRY_INDEX_URLS, "testnet"), false);
});

test("every published index URL is <base>/<network>.json", () => {
  for (const network of NETWORKS) {
    assert.equal(registryIndexUrl(network), `${REGISTRY_BASE_URL}/${network}.json`);
  }
});

test("defaultRegistryUrls is the single published URL per network — the source discover() defaults to", () => {
  for (const network of NETWORKS) {
    assert.deepEqual(defaultRegistryUrls(network), [registryIndexUrl(network)]);
  }
});
