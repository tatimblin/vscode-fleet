import * as esbuild from "esbuild";

/**
 * Two bundles from one source tree.
 *
 * VS Code loads a different entry point depending on where it is running: the
 * desktop app loads `main` (Node extension host), and vscode.dev / the
 * monaco-vscode-api embed used by the blog post loads `browser` (a Web Worker
 * extension host). Both entries wrap the same `src/common/` core, so the demo
 * cannot drift between the two surfaces.
 *
 * Why the flags are what they are:
 *
 *   format: "cjs"   — the extension host `require()`s the entry file and reads
 *                     `module.exports.activate`. An ESM bundle exports nothing
 *                     it can see, and the extension silently never activates.
 *                     This applies to the *web* build too: the worker host uses
 *                     its own AMD/CJS-style loader, not native ESM.
 *
 *   external:       — `vscode` is injected by the host at load time and exists
 *   ["vscode"]        on no disk anywhere. Bundling it fails resolution; marking
 *                     it external leaves the `require("vscode")` call for the
 *                     host to satisfy.
 *
 *   platform        — "node" for desktop, "browser" for the worker build. The
 *                     browser platform is the actual guard rail: if any file
 *                     reachable from src/common ever imports `fs`, `path` or
 *                     another Node builtin, this build fails loudly here rather
 *                     than at runtime inside a worker where the only symptom is
 *                     an extension that never appears.
 */

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const webOnly = process.argv.includes("--web-only");

/** @type {import("esbuild").BuildOptions} */
const shared = {
	bundle: true,
	format: "cjs",
	external: ["vscode"],
	// Match the `engines.vscode` floor: VS Code 1.100 ships a modern Electron and
	// a modern worker runtime, so downlevelling further only makes the output
	// harder to read in the debugger.
	target: "es2022",
	minify: production,
	sourcemap: !production,
	logLevel: "info"
};

/** @type {import("esbuild").BuildOptions[]} */
const builds = [
	{
		...shared,
		entryPoints: ["src/web/extension.ts"],
		outfile: "dist/web/extension.js",
		platform: "browser"
	}
];

if (!webOnly) {
	builds.unshift({
		...shared,
		entryPoints: ["src/node/extension.ts"],
		outfile: "dist/node/extension.js",
		platform: "node"
	});
}

if (watch) {
	// Watch mode has to keep every context alive for the process lifetime;
	// awaiting them sequentially with `.watch()` never resolves, which is fine
	// because there is nothing to do afterwards.
	const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
	await Promise.all(contexts.map((context) => context.watch()));
} else {
	await Promise.all(builds.map((options) => esbuild.build(options)));
}
