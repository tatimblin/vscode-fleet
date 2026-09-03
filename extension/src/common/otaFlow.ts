import * as vscode from "vscode";
import type { FleetSimulator } from "./sim/clock";
import { evaluateOtaPreconditions, OTA_ECUS, OTA_STAGE_INCREMENTS, OTA_TARGET_VERSION } from "./vehicleCommands";
import { wakeVehicle } from "./commandUi";
import { vinTail } from "./model/vin";

/**
 * `fleet.installFirmwareUpdate`: pick a vehicle, check the updater's
 * preconditions, then run the install as a cancellable progress notification
 * while the simulator mirrors every stage into `vehicle_state.software_update`
 * — so a `state.json` tab open beside the notification watches
 * `download_perc` and `install_perc` climb in real time. That mirroring is
 * the demo's payoff: the progress bar and the "API response" agree because
 * they are the same state.
 *
 * The stage timing/choreography lives HERE, not in the simulator, on
 * purpose: the sim stays synchronous and vscode-free (its four OTA methods
 * are instant state transitions the Bun selftest drives directly), and this
 * file owns everything with a token, a toast, or a clock in it.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(() => resolve(), ms));

/** Firmware image size for the download stage's byte-count messages. ~2 GiB
 * is what a full vehicle-wide image actually weighs; the number is flavour,
 * but wrong flavour (a 40 MiB "full image") reads as fake instantly. */
const IMAGE_MIB = 2148;

/** Download sub-reports: 9 steps × 5% = the stage's 45 increment total. */
const DOWNLOAD_STEPS = 9;

export async function runOtaFlow(simulator: FleetSimulator): Promise<void> {
	// Minimal-but-real target picker: VIN tail + currently installed version,
	// so the pick itself shows why the update matters. The full vehicle switcher
	// QuickPick (status icons, live telemetry) is the next unit's; this one
	// stays deliberately lean so the two do not half-duplicate each other.
	const picked = await vscode.window.showQuickPick(
		simulator.getVehicles().map((vehicle) => ({
			label: vinTail(vehicle.vin),
			description: vehicle.firmwareVersion,
			detail: vehicle.online ? undefined : "asleep",
			vin: vehicle.vin
		})),
		{ placeHolder: `Select a vehicle to update to ${OTA_TARGET_VERSION}` }
	);
	if (!picked) return;

	const vehicle = simulator.getVehicle(picked.vin);
	if (!vehicle) return;

	let rejection = evaluateOtaPreconditions(vehicle);
	if (rejection?.reason === "ASLEEP") {
		// The one recoverable precondition gets its affordance inline; unlike a
		// door command, the user's intent here (update THIS vehicle) is still
		// fresh after the wake, so the flow continues instead of making them
		// re-run the command.
		const choice = await vscode.window.showWarningMessage(
			`Firmware update unavailable: ${rejection.summary} — ${rejection.detail}`,
			"Wake Vehicle"
		);
		if (choice !== "Wake Vehicle") return;
		await wakeVehicle(simulator, vehicle.vin);
		rejection = evaluateOtaPreconditions(vehicle);
	}
	if (rejection) {
		void vscode.window.showWarningMessage(
			`Firmware update rejected: ${rejection.summary} — ${rejection.detail}`
		);
		return;
	}

	try {
		await installUpdate(simulator, vehicle.vin, vinTail(vehicle.vin));
	} catch (error) {
		if (error instanceof vscode.CancellationError) {
			void vscode.window.showInformationMessage(
				`Fleet: update cancelled — ${vinTail(vehicle.vin)} unchanged.`
			);
			return;
		}
		throw error;
	}
}

/**
 * The install itself. Increments are ADDITIVE and the stage totals sum to
 * exactly 100 (asserted by the selftest via OTA_STAGE_INCREMENTS) — with the
 * `{increment: 0}` opener that tells VS Code the bar is determinate rather
 * than a spinner. Cancellation is checked after every await: the token does
 * not interrupt a sleep in flight, it just makes the next checkpoint bail,
 * which at these step sizes means cancel lands within ~a second.
 */
async function installUpdate(simulator: FleetSimulator, vin: string, name: string): Promise<void> {
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			cancellable: true,
			title: `Updating ${name} to ${OTA_TARGET_VERSION}`
		},
		async (progress, token) => {
			const checkpoint = (): void => {
				if (token.isCancellationRequested) {
					// Roll the model back to idle BEFORE throwing: an open
					// state.json stuck on "downloading" after the notification is
					// gone would be the exact split-truth the single clock forbids.
					simulator.cancelOta(vin);
					throw new vscode.CancellationError();
				}
			};

			progress.report({ increment: 0 });
			simulator.beginOtaUpdate(vin, OTA_TARGET_VERSION);

			// ── Downloading image: 45 ──────────────────────────────────────────
			for (let step = 1; step <= DOWNLOAD_STEPS; step++) {
				await sleep(750);
				checkpoint();
				const mib = Math.round((IMAGE_MIB * step) / DOWNLOAD_STEPS);
				progress.report({
					increment: OTA_STAGE_INCREMENTS.download / DOWNLOAD_STEPS,
					message: `Downloading image · ${mib} / ${IMAGE_MIB} MiB`
				});
				simulator.setOtaProgress(vin, { downloadPerc: (step / DOWNLOAD_STEPS) * 100 });
			}

			// ── Verifying signature: 10 ────────────────────────────────────────
			progress.report({ message: "Verifying signature" });
			await sleep(900);
			checkpoint();
			progress.report({ increment: OTA_STAGE_INCREMENTS.verify });

			// ── Flashing ECUs: 35 ──────────────────────────────────────────────
			simulator.setOtaProgress(vin, { status: "installing", installPerc: 0 });
			for (let i = 0; i < OTA_ECUS.length; i++) {
				progress.report({ message: `Flashing ECUs · ${OTA_ECUS[i]}` });
				await sleep(850);
				checkpoint();
				// Integer split of 35 across 6 ECUs (6+6+6+6+6+5) so the running
				// total stays exact instead of drifting on repeating decimals.
				const increment = Math.round((OTA_STAGE_INCREMENTS.flash * (i + 1)) / OTA_ECUS.length) -
					Math.round((OTA_STAGE_INCREMENTS.flash * i) / OTA_ECUS.length);
				progress.report({ increment });
				simulator.setOtaProgress(vin, { installPerc: ((i + 1) / OTA_ECUS.length) * 90 });
			}

			// ── Rebooting and validating: 10 ───────────────────────────────────
			progress.report({ message: "Rebooting and validating" });
			simulator.setOtaProgress(vin, { installPerc: 95 });
			await sleep(1400);
			checkpoint();
			progress.report({ increment: OTA_STAGE_INCREMENTS.reboot });

			// Version bump + software_update reset + the success toast (it rides
			// the ambient-event channel, same as "finished charging").
			simulator.completeOta(vin);
		}
	);
}
