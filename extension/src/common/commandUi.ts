import * as vscode from "vscode";
import type { FleetSimulator } from "./sim/clock";
import type { CommandResult, VehicleCommand } from "./vehicleCommands";
import { executeVehicleCommand } from "./vehicleCommands";
import { vinTail } from "./model/vin";

/**
 * The vscode-flavoured rim around the pure command layer: run a command, and
 * if it is rejected, say so the way VS Code says things — a warning toast
 * with the Smartcar reason up front (`Command rejected: IN_MOTION — …002314
 * is moving (106 km/h)`), plus the one rejection that carries an action:
 * ASLEEP offers a "Wake Vehicle" button.
 *
 * This file exists so vehicleCommands.ts does not have to import `vscode`
 * (the Bun selftest drives that file directly — see its module comment).
 * Everything here is presentation; every decision stays in the pure layer.
 */

/** How long the wake theatre runs before the simulator actually wakes it. A
 * real vehicle takes 20–60 s to come up; 3 s is the demo-scaled equivalent —
 * long enough to read the notification, short enough not to lose the room. */
const WAKE_DURATION_MS = 3000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(() => resolve(), ms));

/**
 * Execute a command and surface any rejection as a toast. Returns the result
 * so callers (the controls webview bridge) can also reflect it in their own
 * UI. Deliberately does NOT await the toast: `showWarningMessage`'s promise
 * resolves when the user dismisses it, which can be minutes later, and the
 * webview's pending-tile state must clear on the command's timescale, not
 * the user's.
 */
export async function runVehicleCommand(
	simulator: FleetSimulator,
	vin: string,
	command: VehicleCommand
): Promise<CommandResult> {
	const result = await executeVehicleCommand(simulator, vin, command);
	if (!result.ok) {
		if (result.reason === "ASLEEP") {
			void offerWake(simulator, vin, result.detail);
		} else {
			void vscode.window.showWarningMessage(`Command rejected: ${result.reason} — ${result.detail}`);
		}
	}
	return result;
}

/**
 * The ASLEEP rejection toast, with the wake affordance attached. Fire and
 * forget from the caller's point of view; the original command is NOT
 * auto-retried after the wake — real fleet consoles make you press the
 * button again, and silently replaying a mutation the user issued minutes
 * ago against a vehicle that just woke up is how surprises happen.
 */
export async function offerWake(simulator: FleetSimulator, vin: string, detail: string): Promise<void> {
	const choice = await vscode.window.showWarningMessage(`Command rejected: ASLEEP — ${detail}`, "Wake Vehicle");
	if (choice === "Wake Vehicle") {
		await wakeVehicle(simulator, vin);
	}
}

/**
 * The wake flow proper: a determinate-feeling ~3 s progress notification,
 * then the simulator flips the vehicle to an online idler (its `wake()` is
 * synchronous — the waiting happens here, in UI land, where blocking costs
 * nothing). The tree row and any open editors update off the resulting
 * change event; the success toast is just the receipt.
 */
export async function wakeVehicle(simulator: FleetSimulator, vin: string): Promise<void> {
	const vehicle = simulator.getVehicle(vin);
	if (!vehicle) return;
	const name = vinTail(vehicle.vin);

	if (vehicle.online) return;

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Waking ${name}…` },
		async () => {
			await sleep(WAKE_DURATION_MS);
			simulator.wake(vin);
		}
	);
	void vscode.window.showInformationMessage(`Fleet: ${name} is awake.`);
}
