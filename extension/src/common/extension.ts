import * as vscode from "vscode";
import { FleetSimulator } from "./sim/clock";
import { FleetFsProvider } from "./providers/fleetFsProvider";
import { FleetTreeProvider } from "./providers/fleetTreeProvider";
import { ControlsEditorProvider } from "./providers/controlsEditorProvider";
import { CanStreamManager } from "./providers/canTerminal";
import { FleetDecorationProvider } from "./providers/decorationProvider";
import { DtcDiagnostics } from "./providers/dtcDiagnostics";
import { registerDbcNavigation } from "./providers/dbcNavigation";
import { FleetStatusBar } from "./statusBar";
import { registerCommands } from "./commands";

/**
 * The shared activation path.
 *
 * Everything the extension actually does lives under `src/common/` and is
 * entered from here, so the desktop (Node) and browser (Web Worker) entry
 * points differ only in their thin wrapper. That split is what lets the same
 * build power both a real `--extensionDevelopmentPath` F5 session and the
 * monaco-vscode-api embed in the blog post without a second implementation
 * drifting away from the first.
 *
 * Construction order matters and is deliberate:
 *   1. ONE `FleetSimulator` — the single clock every other component reads
 *      from and subscribes to (see sim/clock.ts for why exactly one).
 *   2. Providers, each handed that instance — they subscribe in their
 *      constructors, so the simulator must exist first.
 *   3. `start()` last, so no tick fires before every subscriber is wired and
 *      the first change events have someone to reach.
 *
 * Everything lands in `context.subscriptions`; the host disposes them in
 * reverse order on deactivate, which stops the clock (the simulator's own
 * `dispose` clears its interval — a leaked interval in the web worker host
 * keeps the worker alive after the extension is gone).
 */
export function activateCommon(context: vscode.ExtensionContext): void {
	const simulator = new FleetSimulator();
	context.subscriptions.push(simulator);

	const fsProvider = new FleetFsProvider(simulator);
	context.subscriptions.push(
		fsProvider,
		vscode.workspace.registerFileSystemProvider("fleet", fsProvider, {
			// VINs are uppercase by construction, but case-sensitivity is still
			// declared: a case-folding lookup would make fleet:/vcf… and
			// fleet:/VCF… the same editor tab with two different URIs.
			isCaseSensitive: true,
			isReadonly: true
		})
	);

	const treeProvider = new FleetTreeProvider(simulator);
	context.subscriptions.push(
		treeProvider,
		vscode.window.createTreeView("fleetExplorer", { treeDataProvider: treeProvider })
	);

	// Badges on the tree rows and on any open fleet: tab. Registered after the
	// tree so the first decoration request arrives against rows that exist.
	const decorationProvider = new FleetDecorationProvider(simulator);
	context.subscriptions.push(
		decorationProvider,
		vscode.window.registerFileDecorationProvider(decorationProvider)
	);

	// Trouble codes into the Problems panel. Populated in its constructor for
	// every vehicle, so the panel is already right before anything is opened.
	context.subscriptions.push(new DtcDiagnostics(simulator));

	// F12 / hover on a CAN signal name in state.json → its SG_ line in
	// fleet:/fleet.dbc. Stateless and simulator-independent: it reads the DBC
	// text, which the FS provider serves from the same module constant.
	context.subscriptions.push(registerDbcNavigation());

	context.subscriptions.push(ControlsEditorProvider.register(simulator));

	// The CAN terminal manager owns at most one live pseudoterminal; it is a
	// subscription so window teardown disposes the terminal (and with it the
	// pty's 30 Hz drain interval) rather than leaking it.
	const canStreams = new CanStreamManager(simulator);
	context.subscriptions.push(canStreams);

	registerCommands(context, simulator, canStreams);

	// The one surface that survives a fully collapsed workbench. Created after
	// the commands, because its click target is `fleet.switchVehicle` and a
	// status bar whose command does not exist yet is a click that errors.
	context.subscriptions.push(new FleetStatusBar(simulator));

	// Surface the simulator's sparse ambient events (charge completions, idle
	// blips) as toasts — the fleet talking while nobody watches it is what
	// makes the demo feel inhabited rather than paused.
	context.subscriptions.push(
		simulator.onAmbientEvent((event) => {
			void vscode.window.showInformationMessage(`Fleet: ${event.message}`);
		})
	);

	simulator.start();
}

/**
 * Symmetric teardown hook. Anything created in `activateCommon` is pushed onto
 * `context.subscriptions` and disposed by the host — including the simulator,
 * whose `dispose` stops the clock — so there is nothing left to do here; this
 * exists so the entry points have something to delegate to when a future
 * resource genuinely cannot be a `Disposable`.
 */
export function deactivateCommon(): void {
	// Nothing to release: context.subscriptions owns every resource.
}
