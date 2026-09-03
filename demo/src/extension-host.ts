import type * as vscode from "vscode";
import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";

// The extension manifest, verbatim from the extension package. Imported at
// build time so the contributes block (views container, tree view, custom
// editor, commands, walkthrough, configuration) that vsce would package is
// exactly what the embedded workbench registers — no hand-maintained copy.
import fleetManifest from "../../fleet-extension/package.json" with { type: "json" };

// The extension's BUILT web bundle, as a string. This is the same artifact the
// .vsix packages (`browser` in the manifest → dist/web/extension.js), so the
// embed runs what a real vscode.dev install would run. `?raw` makes Vite inline
// the file's text into this chunk instead of trying to parse it as a module —
// necessary because the bundle is CommonJS (`format: "cjs"`, see the
// extension's esbuild.mjs) and expects the classic (module, exports, require)
// environment of a VS Code extension host.
import fleetExtensionSource from "../../fleet-extension/dist/web/extension.js?raw";

// The extension's static assets, emitted as hashed site assets by Vite and
// re-registered under the extension's virtual location below so manifest
// references like `media/fleet.svg` resolve inside the workbench.
import fleetIconUrl from "../../fleet-extension/media/fleet.svg?url";
import step1Url from "../../fleet-extension/media/walkthrough/step-1.md?url";
import step2Url from "../../fleet-extension/media/walkthrough/step-2.md?url";
import step3Url from "../../fleet-extension/media/walkthrough/step-3.md?url";
import step4Url from "../../fleet-extension/media/walkthrough/step-4.md?url";

type ExtensionManifest = Parameters<typeof registerExtension>[0];

interface FleetExtensionExports {
	activate?: (context: vscode.ExtensionContext) => void;
	deactivate?: () => void;
}

/**
 * Register the fleet extension's manifest with the workbench and run its real
 * web bundle against the `getApi()` extension API.
 *
 * ## Why evaluate the CJS bundle instead of importing the TS source
 *
 * The alternative bridge — importing packages/fleet-extension/src/web/
 * extension.ts and letting Vite bundle it with `vscode` aliased to the API —
 * would couple this package to the extension's TypeScript config and would
 * ship a *different* artifact than the .vsix. Evaluating the built bundle
 * keeps `dist/web/extension.js` the single source of truth: the exact bytes
 * vsce packages are the exact bytes the blog post runs.
 *
 * The bundle is CommonJS with `external: ["vscode"]`, i.e. it expects to be
 * `require()`d by an extension host that provides the `vscode` module. We
 * reproduce that contract explicitly: `new Function("module", "exports",
 * "require", code)` gives the bundle the three CJS globals it closes over,
 * and our `require` returns the live extension API for "vscode" (and throws
 * for anything else — the browser-platform esbuild pass guarantees nothing
 * else is required). This is an eval of first-party code we built ourselves,
 * not of anything remote or user-supplied.
 */
export async function activateFleetExtension(): Promise<typeof vscode> {
	// registerExtension wants only manifest fields. Crucially, `main`/`browser`
	// must NOT be forwarded: the virtual extension location has no file at
	// dist/web/extension.js, and a manifest that names an entry point makes the
	// worker extension host try (and fail) to load it. We run the code
	// ourselves on the LocalProcess host instead, so the manifest we register
	// is contributions-only.
	const {
		main: _main,
		browser: _browser,
		scripts: _scripts,
		devDependencies: _devDependencies,
		...manifest
	} = fleetManifest;

	const { getApi, registerFileUrl, whenReady } = registerExtension(
		manifest as ExtensionManifest,
		ExtensionHostKind.LocalProcess
	);

	// Map the manifest's asset paths onto the hashed URLs Vite emitted, so
	// manifest references resolve against the extension's virtual location.
	// URLs must be absolute for URI.parse on the workbench side. The icon is
	// what puts the car glyph on the Fleet activity-bar entry. The walkthrough
	// media is registered for completeness, but note that monaco-vscode-api
	// 36.2.7 stubs the walkthroughs extension point (its handler is a no-op),
	// so the walkthrough itself cannot appear in the embed regardless — it
	// remains a real feature of the .vsix in actual VS Code / vscode-test-web.
	const absolute = (url: string) => new URL(url, window.location.href).toString();
	registerFileUrl("media/fleet.svg", absolute(fleetIconUrl), "image/svg+xml");
	registerFileUrl("media/walkthrough/step-1.md", absolute(step1Url), "text/markdown");
	registerFileUrl("media/walkthrough/step-2.md", absolute(step2Url), "text/markdown");
	registerFileUrl("media/walkthrough/step-3.md", absolute(step3Url), "text/markdown");
	registerFileUrl("media/walkthrough/step-4.md", absolute(step4Url), "text/markdown");

	await whenReady();
	const api = await getApi();

	const cjsModule: { exports: FleetExtensionExports } = { exports: {} };
	const cjsRequire = (specifier: string): unknown => {
		if (specifier === "vscode") return api;
		throw new Error(`fleet-demo: the extension bundle required "${specifier}" — ` +
			`only "vscode" is external in its esbuild config, so this should be impossible.`);
	};
	const runBundle = new Function("module", "exports", "require", fleetExtensionSource) as (
		module: { exports: FleetExtensionExports },
		exports: FleetExtensionExports,
		require: (specifier: string) => unknown
	) => void;
	runBundle(cjsModule, cjsModule.exports, cjsRequire);

	if (typeof cjsModule.exports.activate !== "function") {
		throw new Error("fleet-demo: dist/web/extension.js did not export activate()");
	}

	// The extension only reads `context.subscriptions` (see activateCommon in
	// packages/fleet-extension/src/common/extension.ts), so the synthetic
	// context stays honest and minimal. The page's lifetime is the demo's
	// lifetime — the iframe is torn down wholesale — so nothing ever disposes
	// these subscriptions individually.
	const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
	cjsModule.exports.activate(context);

	return api;
}
