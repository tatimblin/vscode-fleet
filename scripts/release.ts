#!/usr/bin/env bun
/**
 * Cut a GitHub Release of @tristimb/fleet-demo.
 *
 *   bun run release 0.2.0           # bump, build, test, pack, tag, push, release
 *   bun run release 0.2.0 --dry-run # everything up to and including the pack
 *
 * There is no npm publish: consumers install the release asset by URL,
 *   "@tristimb/fleet-demo": "https://github.com/tatimblin/vscode-fleet/releases/download/v0.2.0/tristimb-fleet-demo-0.2.0.tgz"
 * Runs locally on purpose — it needs nothing but bun, npm, git and an authed gh.
 */
import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const version = args.find((arg) => !arg.startsWith("--"));
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
	console.error("usage: bun run release <semver> [--dry-run]");
	process.exit(1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const demoDir = `${root}demo`;
const pkgPath = `${demoDir}/package.json`;
const tag = `v${version}`;
const asset = `tristimb-fleet-demo-${version}.tgz`;

$.cwd(root);

const dirty = (await $`git status --porcelain`.text()).trim();
if (dirty && !dryRun) {
	console.error("working tree is dirty; commit or stash first");
	process.exit(1);
}

// 1. Bump (text replace, so the file's formatting survives).
const before = readFileSync(pkgPath, "utf8");
const after = before.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`);
writeFileSync(pkgPath, after);

// 2. Build and test.
await $`bun install --frozen-lockfile`;
await $`bun run build`;
await $`bun run test`;

// 3. Pack demo/ (dist + the element source; see "files" in demo/package.json).
await $`rm -f ${asset}`.cwd(demoDir);
await $`npm pack`.cwd(demoDir);
console.log(`packed demo/${asset}`);

if (dryRun) {
	console.log("dry run: not committing, tagging or releasing");
	process.exit(0);
}

// 4. Commit, tag, push, release.
if (before !== after) await $`git commit -am ${`release: ${tag}`}`;
await $`git tag ${tag}`;
await $`git push origin HEAD ${tag}`;
await $`gh release create ${tag} ${`demo/${asset}`} --title ${tag} --notes ${`Install with:\n\n"@tristimb/fleet-demo": "https://github.com/tatimblin/vscode-fleet/releases/download/${tag}/${asset}"`}`;
console.log(`released ${tag}`);
