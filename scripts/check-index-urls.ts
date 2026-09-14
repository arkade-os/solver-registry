// HEADs every published index URL so a 404 or a moved base is caught by CI.
// Kept out of `pnpm test`, which stays offline; see .github/workflows/index-urls.yml.
import { NETWORKS } from "../packages/discovery-client/src/types.ts";
import { defaultRegistryUrls } from "../packages/discovery-client/src/registries.ts";

let failed = false;
for (const network of NETWORKS) {
  for (const url of defaultRegistryUrls(network)) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      console.log(`${res.status} ${url}`);
      if (!res.ok) failed = true;
    } catch (e) {
      console.error(`unreachable ${url}: ${(e as Error).message}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error("\nOne or more published index URLs are not reachable.");
  process.exit(1);
}
