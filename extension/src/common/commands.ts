import * as vscode from "vscode";
import type { FleetSimulator } from "./sim/clock";
import { ControlsEditorProvider } from "./providers/controlsEditorProvider";
import type { CanStreamManager } from "./providers/canTerminal";
import { executeVehicleCommand } from "./vehicleCommands";
import { runOtaFlow } from "./otaFlow";
import { pickVehicleVin, showVehicleQuickPick } from "./quickpick";
import { vinTail } from "./model/vin";

/**
 * Every command the manifest declares, registered in one place.
 *
 * The rule that keeps this file honest: `contributes.commands` in package.json
 * and the registrations here must stay in lockstep. A declared-but-unregistered
 * command still shows in the palette and fails with "command not found" when
 * invoked — the most embarrassing possible failure for a demo — so every
 * command in `contributes.commands` is registered here, and every registration
 * here is declared there.
 */

export function registerCommands(
	context: vscode.ExtensionContext,
	simulator: FleetSimulator,
	canStreams: CanStreamManager
): void {
	context.subscriptions.push(
		/**
		 * Internal navigation command — the tree rows and future deep links call
		 * it with a VIN. Declared in the manifest (VS Code warns on undeclared
		 * commands in tree item bindings) but hidden from the palette via a
		 * `menus.commandPalette` `"when": "false"` entry, because palette users
		 * have no way to supply the argument and the no-arg fallback silently
		 * picking a vehicle would be a confusing palette experience.
		 */
		vscode.commands.registerCommand("fleet.openControls", (vin?: string) => {
			const target = vin ?? simulator.getVehicles()[0]?.vin;
			if (!target) return;
			void vscode.commands.executeCommand(
				"vscode.openWith",
				vscode.Uri.parse(`fleet:/${target}/controls.vehicle`),
				ControlsEditorProvider.viewType
			);
		}),

		vscode.commands.registerCommand("fleet.unlockAllDoors", () => {
			void mutateWholeFleet(simulator, false);
		}),

		vscode.commands.registerCommand("fleet.lockAllDoors", () => {
			void mutateWholeFleet(simulator, true);
		}),

		vscode.commands.registerCommand("fleet.reset", () => {
			simulator.reset();
			void vscode.window.showInformationMessage("Fleet: demo reset — six vehicles re-seeded.");
		}),

		/**
		 * Optionally takes a VIN (a future tree context menu / the switcher
		 * will pass one); bare palette invocations stream the current bus
		 * target, which defaults to the driving vehicle. The type guard
		 * matters: the palette invokes commands with undefined, but other
		 * surfaces can pass anything.
		 */
		vscode.commands.registerCommand("fleet.openCanStream", (vin?: unknown) => {
			canStreams.open(typeof vin === "string" ? vin : undefined);
		}),

		vscode.commands.registerCommand("fleet.installFirmwareUpdate", () => {
			void runOtaFlow(simulator);
		}),

		vscode.commands.registerCommand("fleet.switchVehicle", () => {
			showVehicleQuickPick(simulator, canStreams);
		}),

		/**
		 * The fleet: file system's front door. Without this, a reader only ever
		 * reaches a `state.json` sideways — through a Problems entry on the
		 * faulted vehicle, or F12 out of a DBC signal name — which buries the
		 * demo's whole point (these files do not exist on disk) behind a
		 * scavenger hunt.
		 *
		 * Two invocation shapes, because the command is on both the palette and
		 * the tree's context menu: `view/item/context` hands the handler the
		 * tree ELEMENT (a Vehicle) as its first argument, while the palette
		 * passes nothing and has to ask.
		 */
		vscode.commands.registerCommand("fleet.openState", (target?: unknown) => {
			void openVehicleState(simulator, vinFrom(target));
		})
	);
}

/** The VIN a command invocation names, across both surfaces: a bare VIN
 * string, a tree element (any object carrying one), or nothing at all. */
function vinFrom(target: unknown): string | undefined {
	if (typeof target === "string") return target;
	if (target && typeof target === "object" && typeof (target as { vin?: unknown }).vin === "string") {
		return (target as { vin: string }).vin;
	}
	return undefined;
}

/**
 * Open a vehicle's `state.json`, asking which vehicle when the caller did not
 * say. Plain `showTextDocument`, not a custom editor: the point of the file
 * system provider is that the ordinary JSON editor — folding, colouring, the
 * outline — works on a document that only exists in memory.
 */
async function openVehicleState(simulator: FleetSimulator, vin?: string): Promise<void> {
	const target =
		vin ?? (await pickVehicleVin(simulator, { title: "Open vehicle state", placeholder: "VIN or model" }));
	if (!target) return;
	await vscode.window.showTextDocument(vscode.Uri.parse(`fleet:/${target}/state.json`));
}

/**
 * Lock/unlock the whole fleet through the async command layer, one command
 * per vehicle, all in flight together. The layer's state-derived rejections
 * do the interesting work here: a fleet-wide lock legitimately fails for the
 * moving vehicle (IN_MOTION), the sleeping one (ASLEEP) and the one with a
 * door ajar (DOOR_OPEN), so the summary toast reads like a real dispatch
 * report — one toast, not six, because six simultaneous toasts train the
 * user to dismiss without reading.
 */
async function mutateWholeFleet(simulator: FleetSimulator, locked: boolean): Promise<void> {
	const verb = locked ? "locked" : "unlocked";
	const outcomes = await Promise.all(
		simulator.getVehicles().map(async (vehicle) => ({
			name: vinTail(vehicle.vin),
			result: await executeVehicleCommand(simulator, vehicle.vin, { kind: "setVehicleLocked", locked })
		}))
	);

	const succeeded = outcomes.filter((o) => o.result.ok).length;
	const rejected = outcomes
		.filter((o) => !o.result.ok)
		.map((o) => `${o.name} (${o.result.ok ? "" : o.result.reason})`);

	const summary =
		`Fleet: ${verb} ${succeeded} of ${outcomes.length} vehicles` +
		(rejected.length > 0 ? ` · rejected: ${rejected.join(", ")}` : ".");
	if (rejected.length > 0) {
		void vscode.window.showWarningMessage(summary);
	} else {
		void vscode.window.showInformationMessage(summary);
	}
}
