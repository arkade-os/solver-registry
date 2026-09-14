// The index URLs this registry publishes on GitHub Pages. Data only:
// `discover()` still takes the registries to follow — overrides and opt-out are
// the caller's policy, not the format's.
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
