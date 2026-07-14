import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The library must bundle for browsers and Expo / React Native (Hermes), which
// have no Node built-ins and no `eval` / `new Function`. This guard enforces
// that contract on the shipped source so a regression can't slip into CI.

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /from\s+["']node:/, why: "imports a Node built-in" },
  { pattern: /\brequire\s*\(/, why: "uses CommonJS require()" },
  { pattern: /new\s+Function\s*\(/, why: "uses new Function (breaks Hermes / strict CSP)" },
  { pattern: /(^|[^.\w])eval\s*\(/, why: "uses eval (breaks Hermes / strict CSP)" },
  { pattern: /\bBuffer\b/, why: "uses Node Buffer" },
  { pattern: /\bprocess\.\b/, why: "uses Node process" },
  { pattern: /\b__dirname\b|\b__filename\b/, why: "uses CommonJS module globals" },
];

const ALLOWED_EXTERNAL_IMPORTS: Record<string, Set<string>> = {
  "react.ts": new Set(["react"]),
};

test("source files exist to check", () => {
  assert.ok(files.length >= 5, `expected several src files, found ${files.join(", ")}`);
});

for (const file of files) {
  const code = readFileSync(join(srcDir, file), "utf8");
  test(`portability: ${file} avoids non-portable APIs`, () => {
    for (const { pattern, why } of FORBIDDEN) {
      assert.doesNotMatch(code, pattern, `${file} ${why}`);
    }
  });
  test(`portability: ${file} has only dependency-free relative imports`, () => {
    const importRe = /(?:import|export)[^"']*from\s+["']([^"']+)["']/g;
    for (const m of code.matchAll(importRe)) {
      const spec = m[1];
      if (ALLOWED_EXTERNAL_IMPORTS[file]?.has(spec)) continue;
      assert.ok(spec.startsWith("./") || spec.startsWith("../"), `${file} imports non-relative "${spec}"`);
      assert.ok(spec.endsWith(".ts"), `${file} import "${spec}" should carry the .ts extension`);
    }
  });
}
