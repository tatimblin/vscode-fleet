import { defineConfig } from "vite";

const pkg = await import("./package.json", { with: { type: "json" } }).then((m) => m.default);

/**
 * Everything monaco-vscode-api must be resolved exactly once: two copies of
 * any of these packages in the module graph means two service registries and
 * an unbootable workbench, hence the dedupe + optimizeDeps lists below.
 */
const vscodeDeps = Object.keys(pkg.dependencies).filter(
	(name) =>
		name.startsWith("@codingame/monaco-vscode-") || name === "vscode" || name === "monaco-editor"
);

export default defineConfig({
	// The standalone workbench page is served from /fleet-demo/ (the iframe src
	// used by <fleet-demo> and by wrangler pages dev / production alike).
	base: "/fleet-demo/",
	build: {
		// esnext: monaco-vscode-api ships top-level await; downlevelling breaks it.
		target: "esnext",
		// The built page is a site asset, served by Astro's public/ passthrough.
		// It is gitignored and rebuilt by `bun run build:fleet-demo`.
		outDir: "../../public/fleet-demo",
		emptyOutDir: true
	},
	worker: {
		// The extension host / textmate / editor workers are ESM.
		format: "es"
	},
	plugins: [
		{
			// Required by monaco-vscode-api: its css must be importable as a string
			// (the library injects it into the page / webview shadow roots itself).
			name: "load-vscode-css-as-string",
			enforce: "pre",
			async resolveId(source, importer, options) {
				const resolved = await this.resolve(source, importer, options);
				if (resolved == null) return undefined;
				if (
					resolved.id.match(/node_modules\/(@codingame\/monaco-vscode|vscode|monaco-editor).*\.css$/)
				) {
					return { ...resolved, id: resolved.id + "?inline" };
				}
				return undefined;
			}
		}
	],
	optimizeDeps: {
		include: [
			...vscodeDeps,
			"@codingame/monaco-vscode-api/extensions",
			"@codingame/monaco-vscode-api",
			"@codingame/monaco-vscode-api/monaco",
			"vscode/localExtensionHost"
		]
	},
	resolve: {
		dedupe: ["vscode", ...vscodeDeps]
	}
});
