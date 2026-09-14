// The URLs this registry publishes on GitHub Pages — the source `discover()`
// reads when no `registries` list is passed.
import type { Network } from "./types.ts";

export const REGISTRY_BASE_URL = "https://arkade-os.github.io/solver-registry";

export const REGISTRY_INDEX_URLS = {
  bitcoin: `${REGISTRY_BASE_URL}/bitcoin.json`,
  signet: `${REGISTRY_BASE_URL}/signet.json`,
  mutinynet: `${REGISTRY_BASE_URL}/mutinynet.json`,
  regtest: `${REGISTRY_BASE_URL}/regtest.json`,
} as const satisfies Record<Network, string>;

export function registryIndexUrl(network: Network): string {
  return REGISTRY_INDEX_URLS[network];
}

/** The network's published index — what `discover()` reads when `registries` is omitted. */
export function defaultRegistryUrls(network: Network): string[] {
  return [registryIndexUrl(network)];
}
