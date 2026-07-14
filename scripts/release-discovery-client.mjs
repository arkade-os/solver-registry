#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_TYPES = new Set(["patch", "minor", "major"]);
const bump = process.argv[2];
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const packageDir = resolve(rootDir, "packages/discovery-client");
const packageJson = resolve(packageDir, "package.json");

function usage() {
  console.error("Usage: npm run release:client -- <patch|minor|major>");
}

function run(command, args, cwd = rootDir) {
  const where = relative(rootDir, cwd) || ".";
  console.log(`\n$ (${where}) ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args, cwd = rootDir) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function assertCleanGitTree() {
  const status = capture("git", ["status", "--porcelain"], rootDir);
  if (status !== "") {
    console.error("Release requires a clean git tree. Commit or stash changes first.");
    console.error(status);
    process.exit(1);
  }
}

function assertOnMaster() {
  const branch = capture("git", ["branch", "--show-current"], rootDir);
  if (branch !== "master") {
    console.error(`Release must be run from master, got ${branch || "detached HEAD"}.`);
    process.exit(1);
  }
}

function readPackageVersion() {
  return JSON.parse(readFileSync(packageJson, "utf8")).version;
}

if (!RELEASE_TYPES.has(bump)) {
  usage();
  process.exit(1);
}

assertCleanGitTree();
assertOnMaster();

run("npm", ["test"], packageDir);
run("npm", ["run", "typecheck"], packageDir);
run("npm", ["run", "build"], packageDir);
run("npm", ["version", bump, "--no-git-tag-version"], packageDir);

const version = readPackageVersion();
const tag = `solver-discovery-v${version}`;
const existingTag = capture("git", ["tag", "--list", tag], rootDir);
if (existingTag !== "") {
  console.error(`Tag ${tag} already exists. Refusing to publish the same version twice.`);
  process.exit(1);
}

run("npm", ["publish", "--access", "public"], packageDir);

const versionFiles = [
  "packages/discovery-client/package.json",
  "packages/discovery-client/package-lock.json",
].filter((file) => existsSync(resolve(rootDir, file)));

run("git", ["add", ...versionFiles], rootDir);
run("git", ["commit", "-m", `Release solver discovery v${version}`], rootDir);
run("git", ["tag", tag], rootDir);
run("git", ["push", "origin", "master"], rootDir);
run("git", ["push", "origin", tag], rootDir);

console.log(`\nPublished @arkade-os/solver-discovery v${version}.`);
console.log(`Pushed master and ${tag}.`);
