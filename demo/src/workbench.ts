import * as monaco from "monaco-editor";
import {
	initialize as initializeMonacoService,
	getService,
	IWorkbenchLayoutService,
	LogLevel,
	type IWorkbenchConstructionOptions
} from "@codingame/monaco-vscode-api";
import getWorkbenchServiceOverride, {
	Parts
} from "@codingame/monaco-vscode-workbench-service-override";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import getConfigurationServiceOverride, {
	initUserConfiguration
} from "@codingame/monaco-vscode-configuration-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getExtensionServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getNotificationsServiceOverride from "@codingame/monaco-vscode-notifications-service-override";
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override";
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override";
import getLifecycleServiceOverride from "@codingame/monaco-vscode-lifecycle-service-override";
import getLogServiceOverride from "@codingame/monaco-vscode-log-service-override";
import getTerminalServiceOverride from "@codingame/monaco-vscode-terminal-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import {
	RegisteredFileSystemProvider,
	RegisteredMemoryFile,
	registerFileSystemOverlay
} from "@codingame/monaco-vscode-files-service-override";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import "vscode/localExtensionHost";

import { activateFleetExtension } from "./extension-host";

// ---------------------------------------------------------------------------
// Messaging back to <fleet-demo> (the page always lives in its iframe; when
// opened directly there is no listener and the posts are harmless no-ops).
// ---------------------------------------------------------------------------
function post(message: { type: string; pct?: number; message?: string }) {
	if (window.parent !== window) {
		// Origin-pinned rather than "*", so BOTH directions of this channel are
		// checked on both ends. `fleet-demo:error` carries the boot error's
		// own message — internal, stack-adjacent text — and a wildcard target
		// hands it to whatever document happens to be the parent, including
		// one that navigated cross-origin after embedding us. The embed is
		// same-origin by construction (element.ts mounts it at a site path),
		// so pinning costs nothing here.
		window.parent.postMessage(message, window.location.origin);
	}
}
const progress = (pct: number) => post({ type: "fleet-demo:progress", pct });

/** The live extension API, kept from activation so the reset path can use it. */
type FleetApi = Awaited<ReturnType<typeof activateFleetExtension>>;
let fleetApi: FleetApi | null = null;

/**
 * Below this, the workbench cannot afford an open sidebar: VS Code enforces a
 * ~300px minimum editor width, so at phone width the sidebar pushes the
 * editor and panel past the right edge of an iframe that does not scroll
 * horizontally — the CAN terminal renders, but where the reader cannot see
 * or reach it. 768 matches the breakpoint the old viewport gate drew the
 * same "too narrow for all three parts" line at.
 */
const NARROW_VIEWPORT_PX = 768;

/**
 * The layout the demo always opens in: Fleet view container showing, bottom
 * panel visible with real height.
 *
 * Shared by boot and reset on purpose — a reset that restored a layout the
 * boot never produced would be a second, drifting definition of "the demo".
 * (Fresh profiles start with the panel collapsed, so this is not a no-op even
 * on first boot: the CAN stream terminal needs somewhere visible to land.)
 */
async function applyDemoLayout(api: FleetApi) {
	const layoutService = await getService(IWorkbenchLayoutService);

	// setSize, not resizePart: resizePart takes a DELTA, so running it on every
	// reset would walk the panel taller and taller until it ate the editor.
	// Width is read back rather than invented — the panel spans the editor area
	// and nothing here means to change that.
	layoutService.setPartHidden(false, Parts.PANEL_PART);
	const panel = layoutService.getSize(Parts.PANEL_PART);
	layoutService.setSize(Parts.PANEL_PART, { width: panel.width, height: 260 });

	// Land the reader in the Fleet view container so the vehicle tree is the
	// first thing they see; this also un-hides the sidebar if they closed it.
	// (The manifest's walkthrough is NOT opened here: monaco-vscode-api 36.2.7
	// stubs the walkthroughs extension point — its handler is a no-op, so
	// extension-contributed walkthroughs can never register in the embed. The
	// contribution still works in real VS Code and vscode-test-web; the README
	// stands in as the demo's opening editor.)
	await api.commands.executeCommand("workbench.view.extension.fleet");
}

/**
 * The VIN of the vehicle the demo should open on: the one that is actually
 * moving, because a controls editor showing live speed and gear — and a CAN
 * stream carrying its frames — is the scene the poster advertises. Resolved
 * from the extension's own `fleet:` file system at runtime rather than
 * hardcoded, so the seed can renumber, reorder or re-trim its vehicles
 * without silently pointing the opening scene at a parked car (or at a VIN
 * that no longer exists). "Moving" is read from the same serialized
 * `state.json` a reader opens, not from a private simulator handle the demo
 * layer has no business holding.
 *
 * Returns `undefined` on any failure: both staged commands have their own
 * sane no-arg defaults (first vehicle / current bus target, which the
 * extension points at the driving vehicle), so a failed lookup degrades to
 * "almost certainly the same scene" instead of degrading to no scene.
 */
async function findDrivingVin(api: FleetApi): Promise<string | undefined> {
	try {
		const entries = await api.workspace.fs.readDirectory(api.Uri.parse("fleet:/"));
		const vins = entries
			.filter(([, kind]) => kind === api.FileType.Directory)
			.map(([name]) => name);
		const decoder = new TextDecoder();
		for (const vin of vins) {
			const bytes = await api.workspace.fs.readFile(api.Uri.parse(`fleet:/${vin}/state.json`));
			const state = JSON.parse(decoder.decode(bytes)) as {
				drive_state?: { speed_kph?: number };
			};
			if ((state.drive_state?.speed_kph ?? 0) > 0) return vin;
		}
		// No mover (a reshuffled seed could park everything): first vehicle,
		// so the scene still stages instead of quietly not opening anything.
		return vins[0];
	} catch (error) {
		console.warn("[fleet-demo] could not resolve the driving vehicle", error);
		return undefined;
	}
}

/**
 * Stage the scene the poster advertises: the moving vehicle's controls editor
 * in the editor area, its CAN stream running in the panel.
 *
 * This lives HERE, in the demo harness, and not in the extension's
 * activate(): an extension that force-opens a terminal and an editor the
 * moment it activates is obnoxious for anyone running it for real under F5
 * or from a .vsix. The embed is the one context where "boot into the demo's
 * best moment" is correct — a real reader landed on an empty workbench and
 * reported "I don't see any signals running in the terminal", because the
 * stream only existed behind a palette command they had no reason to know.
 *
 * Ordering, both halves deliberate:
 *   - callers run this AFTER the fleet tree has rendered rows (activation
 *     proof) and AFTER applyDemoLayout has un-collapsed the panel to 260px —
 *     `Pseudoterminal.open()` defers until the terminal is attached and
 *     sized, so a stream started into a collapsed panel would sit dark;
 *   - controls first, stream second, so the terminal's `show()` is the last
 *     focus move and the panel arrives live rather than buried.
 */
async function stageDemoScene(api: FleetApi) {
	// Narrow viewports only: collapse the sidebar so the editor and terminal
	// get the full frame width (see NARROW_VIEWPORT_PX for the failure this
	// prevents). One tap on the Fleet icon in the activity bar brings the
	// tree back. Desktop keeps the sidebar open — the vehicle tree is the
	// first thing the poster promises.
	if (window.innerWidth < NARROW_VIEWPORT_PX) {
		const layoutService = await getService(IWorkbenchLayoutService);
		layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
	}

	const vin = await findDrivingVin(api);
	await api.commands.executeCommand("fleet.openControls", vin);
	await api.commands.executeCommand("fleet.openCanStream", vin);
}

/**
 * Best-effort confirmation that the staged CAN pty really attached and wrote
 * its first output. "The command ran" is not "frames are flowing": the pty
 * only starts when VS Code attaches and sizes the terminal, and a break in
 * that deferral would leave a panel that LOOKS like a terminal and streams
 * nothing — exactly the complaint this staging exists to fix. The header
 * ("interface can0 …") renders via the DOM renderer (gpuAcceleration is
 * off), so its text is cheap to poll for. Bounded and non-fatal on purpose:
 * a silent stream is logged, never thrown — the workbench must still reach
 * ready without it.
 */
async function waitForCanStreamOutput(container: HTMLElement, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const rows = container.querySelector(".part.panel .xterm-rows");
		if (rows?.textContent?.includes("can0")) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	console.warn("[fleet-demo] the CAN stream produced no output in time");
}

/**
 * Handle `fleet-demo:reset` from the host page's chrome (see element.ts).
 *
 * Two halves, because the reader can wreck two different things: the
 * extension's own state (re-seeded by its real `fleet.reset` command, the same
 * one the palette and the view's welcome link run) and the workbench layout
 * (restored above). Restaging the opening scene covers the third: "I closed
 * every tab" leaves a workbench with nothing in it, which no amount of
 * re-seeding fixes — and reset staging the SAME scene boot stages keeps one
 * definition of "the demo" instead of a reset that lands somewhere boot
 * never produced (the old behaviour reopened the README here, an editor the
 * boot path no longer leads with).
 */
async function resetDemo(api: FleetApi) {
	await api.commands.executeCommand("fleet.reset");
	await applyDemoLayout(api);
	await stageDemoScene(api);
}

// Origin-pinned on this end too: the only window that may drive the workbench
// is the parent that embedded it, from this same origin.
window.addEventListener("message", (event: MessageEvent) => {
	if (event.origin !== window.location.origin) return;
	if (window.parent === window || event.source !== window.parent) return;
	if ((event.data as { type?: string } | null)?.type !== "fleet-demo:reset") return;
	if (fleetApi == null) return;
	resetDemo(fleetApi).catch((error) => console.error("[fleet-demo] reset failed", error));
});

async function boot() {
	progress(5);

	// --- workers -------------------------------------------------------------
	const workers: Partial<Record<string, () => Worker>> = {
		editorWorkerService: () =>
			new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), {
				type: "module"
			}),
		extensionHostWorkerMain: () =>
			new Worker(
				new URL("@codingame/monaco-vscode-api/workers/extensionHost.worker", import.meta.url),
				{ type: "module" }
			),
		TextMateWorker: () =>
			new Worker(
				new URL("@codingame/monaco-vscode-textmate-service-override/worker", import.meta.url),
				{ type: "module" }
			)
	};

	self.MonacoEnvironment = {
		getWorker(_, label) {
			const factory = workers[label];
			if (factory == null) throw new Error(`Unknown worker: ${label}`);
			return factory();
		}
	};

	// --- workspace (in-memory) ----------------------------------------------
	// A tiny memfs folder keeps the Explorer meaningful; the fleet: virtual
	// file system arrives when the extension activates. Opening fleet:/ as the
	// workspace instead would race the provider registration, so the folder
	// stays local and the Fleet activity-bar view carries the demo.
	const fsProvider = new RegisteredFileSystemProvider(false);
	fsProvider.registerFile(
		new RegisteredMemoryFile(
			monaco.Uri.file("/workspace/README.md"),
			[
				"# Fleet demo",
				"",
				"This is real VS Code running in your browser, with a fleet-management",
				"extension installed. Open the Fleet icon in the activity bar, pick a",
				"vehicle, and poke around: the CAN stream, the vehicle controls, the",
				"trouble codes in the Problems panel — all simulated, all live.",
				""
			].join("\n")
		)
	);
	registerFileSystemOverlay(1, fsProvider);

	// BEFORE init, per the monaco-vscode-api contract: the configuration
	// service reads this snapshot during initialize. gpuAcceleration off keeps
	// the terminal DOM-rendered (screen-reader- and Playwright-visible text
	// instead of a canvas).
	await initUserConfiguration(
		JSON.stringify({
			"workbench.colorTheme": "Default Dark Modern",
			"window.commandCenter": false,
			"workbench.activityBar.location": "default",
			"terminal.integrated.gpuAcceleration": "off"
		})
	);
	progress(20);

	// --- construct + init ----------------------------------------------------
	const constructOptions: IWorkbenchConstructionOptions = {
		workspaceProvider: {
			trusted: true,
			async open() {
				return false;
			},
			workspace: { folderUri: monaco.Uri.file("/workspace") }
		},
		developmentOptions: { logLevel: LogLevel.Error },
		// The README stays the FIRST editor even though stageDemoScene() opens
		// the controls editor on top of it after activation: it is the landing
		// fallback. Staging is defensive and allowed to fail, and a boot whose
		// staging failed with no default editor would land on an empty editor
		// group — a README that explains the demo is a far better worst case,
		// and it costs nothing as a background tab in the normal case.
		defaultLayout: {
			editors: [{ uri: monaco.Uri.file("/workspace/README.md") }],
			force: true
		},
		productConfiguration: {
			nameShort: "Fleet demo",
			nameLong: "Fleet demo — VS Code in the browser"
		}
	};

	const container = document.getElementById("workbench")!;

	// NOTE deliberately absent: views-service-override. It silently corrupts
	// the workbench grid when combined with workbench-service-override (editor
	// collapses to 0px). Workbench only — webviews ride in transitively.
	await initializeMonacoService(
		{
			...getLogServiceOverride(),
			...getExtensionServiceOverride(),
			...getModelServiceOverride(),
			...getConfigurationServiceOverride(),
			...getKeybindingsServiceOverride(),
			...getTextmateServiceOverride(),
			...getThemeServiceOverride(),
			...getLanguagesServiceOverride(),
			...getNotificationsServiceOverride(),
			...getDialogsServiceOverride(),
			...getStorageServiceOverride(),
			...getLifecycleServiceOverride(),
			...getTerminalServiceOverride(),
			...getMarkersServiceOverride(),
			...getExplorerServiceOverride(),
			...getWorkbenchServiceOverride(),
			...getQuickAccessServiceOverride({
				isKeybindingConfigurationVisible: () => true,
				shouldUseGlobalPicker: () => true
			})
		},
		container,
		constructOptions,
		{}
	);
	progress(60);
	document.getElementById("boot-indicator")?.remove();

	// --- the fleet extension --------------------------------------------------
	const api = await activateFleetExtension();
	// Module-level, so the reset handler runs against the real activation API
	// rather than reaching through the debugging probe below.
	fleetApi = api;
	progress(80);

	await applyDemoLayout(api);
	progress(85);

	// Playwright / debugging probe.
	(window as unknown as Record<string, unknown>).__fleetDemo = { api };

	// "Ready" means the vehicle tree actually rendered rows, not merely that
	// activate() returned — the parent swaps its poster for the iframe on this
	// signal and must never reveal an empty sidebar. It also gates the staging
	// below: rendered rows prove the extension really activated (so the fleet:
	// fs and the staged commands exist), and on narrow viewports the sidebar
	// must not be hidden before the rows it is polled for have appeared.
	await waitForFleetTree(container);
	progress(90);

	// Stage the poster's scene — controls editor open, CAN stream running.
	// Defensive on purpose: staging is a nicety, not a precondition. A boot
	// that reaches this line has a fully working workbench, and a reader with
	// a working-but-unstaged workbench is strictly better off than one whose
	// demo errored out because a garnish failed — so log and continue.
	try {
		await stageDemoScene(api);
		await waitForCanStreamOutput(container, 10_000);
	} catch (error) {
		console.error("[fleet-demo] staging the opening scene failed", error);
	}
	progress(97);

	post({ type: "fleet-demo:ready" });
}

/**
 * Poll until the fleet tree has really rendered rows, or throw after 30s —
 * the boot-failure path turns that throw into `fleet-demo:error`, because a
 * workbench whose extension host silently died looks identical to a working
 * one from outside the iframe.
 */
async function waitForFleetTree(container: HTMLElement) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const rows = container.querySelectorAll(".part.sidebar .monaco-list-row");
		if (rows.length > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("fleet tree never rendered");
}

boot().catch((error) => {
	console.error("[fleet-demo] boot failed", error);
	const indicator = document.getElementById("boot-indicator");
	if (indicator != null) indicator.textContent = "The demo failed to start.";
	post({ type: "fleet-demo:error", message: error instanceof Error ? error.message : String(error) });
});
