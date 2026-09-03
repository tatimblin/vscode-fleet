import type { DoorId, Vehicle } from "./model/types";
import type { FleetSimulator } from "./sim/clock";
import { vinTail } from "./model/vin";

/**
 * The async command layer: every vehicle mutation the UI can request flows
 * through `executeVehicleCommand`, which adds the round-trip a real telematics
 * backend has (600–900 ms of latency) and the rejections a real one issues.
 *
 * Two properties are deliberate and load-bearing:
 *
 *   1. Rejections are STATE-DERIVED, not random. `IN_MOTION` fires because
 *      Atlas is actually doing 106 km/h in the simulator, `DOOR_OPEN` because
 *      Dune's front-left door is actually ajar. A demo whose failures are
 *      dice rolls trains the viewer to retry; one whose failures are readable
 *      from the tree view trains them to *look*, which is the point. The one
 *      exception is a ~10% spurious `UNREACHABLE` on otherwise-valid
 *      commands — cellular telematics genuinely does that, and its absence is
 *      its own kind of tell. The reason vocabulary is Smartcar's, because
 *      that is the error surface a fleet-API reader has actually seen.
 *
 *   2. NO `vscode` import, transitively or otherwise. The Bun selftest drives
 *      this file directly (latency bounds, every rejection path, the mutation
 *      on success), which is only possible because the toasts, wake-progress
 *      notifications and webview plumbing live one layer up in commandUi.ts.
 *      The injectable `sleep`/`random` hooks exist for the same reason: the
 *      selftest swaps them to run every path in microseconds, deterministic.
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The mutations this unit routes through the layer. Windows/alarm arrive
 * with the next unit's controls-pane UI and slot in as new `kind`s here. */
export type VehicleCommand =
	| { kind: "setDoorLock"; door: DoorId; locked: boolean }
	| { kind: "setVehicleLocked"; locked: boolean }
	| { kind: "unlatchChargePort" };

/** Smartcar's error-code vocabulary, verbatim — see the module comment. */
export type RejectionReason =
	| "ASLEEP"
	| "IN_MOTION"
	| "DOOR_OPEN"
	| "CHARGING_IN_PROGRESS"
	| "UNREACHABLE";

export type CommandResult =
	| { ok: true }
	| { ok: false; reason: RejectionReason; detail: string };

// ── Pure policy ──────────────────────────────────────────────────────────────

/** "Atlas — Ocean Extreme" → "Atlas". */


/**
 * Decide whether `command` is currently allowed against `vehicle`. Pure over
 * its inputs — same state in, same verdict out — so the selftest can walk
 * every personality through every command without an event loop. Order
 * matters and mirrors how a real stack fails: reachability first (an asleep
 * vehicle never even hears the request), then safety interlocks.
 */
export function evaluateVehicleCommand(vehicle: Vehicle, command: VehicleCommand): CommandResult {
	if (!vehicle.online) {
		return {
			ok: false,
			reason: "ASLEEP",
			detail: `${vinTail(vehicle.vin)} is asleep`
		};
	}

	const isLockCommand = command.kind === "setDoorLock" || command.kind === "setVehicleLocked";

	// Door-lock actuation is interlocked against motion — the BCM refuses it
	// above walking pace, in both directions (an unlock at highway speed is
	// the scarier of the two).
	if (isLockCommand && vehicle.speedKph > 0) {
		return {
			ok: false,
			reason: "IN_MOTION",
			detail: `${vinTail(vehicle.vin)} is moving (${Math.round(vehicle.speedKph)} km/h)`
		};
	}

	// Locking with a door ajar: the latch cannot throw, so the command is
	// refused rather than reported as a success that secured nothing.
	if (isLockCommand && wantsLocked(command)) {
		const ajar = (Object.entries(vehicle.doors) as Array<[DoorId, { open: boolean }]>).find(([, d]) => d.open);
		if (ajar) {
			return {
				ok: false,
				reason: "DOOR_OPEN",
				detail: `${vinTail(vehicle.vin)}'s ${ajar[0]} door is ajar`
			};
		}
	}

	// The charge-port latch stays down while current flows; yanking a live
	// CCS connector is how contactors get welded and fingers get burned.
	if (command.kind === "unlatchChargePort" && vehicle.charge.charging) {
		return {
			ok: false,
			reason: "CHARGING_IN_PROGRESS",
			detail: `${vinTail(vehicle.vin)} is charging at ${Math.round(vehicle.charge.powerKw)} kW`
		};
	}

	return { ok: true };
}

/** Does this command end with the vehicle (or a door) locked? */
function wantsLocked(command: VehicleCommand): boolean {
	return (command.kind === "setDoorLock" || command.kind === "setVehicleLocked") && command.locked;
}

/**
 * Deterministic-ish latency in the 600–900 ms band a cellular round trip
 * plus vehicle wake-and-ack actually costs. FNV-1a over the seed rather than
 * `Math.random()` so the same command against the same vehicle feels
 * consistently snappy or consistently sluggish — real links have a
 * characteristic latency, not a fresh dice roll per request — and so the
 * selftest can assert the bounds over the whole seed space.
 */
export function commandLatencyMs(seed: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return 600 + ((hash >>> 0) % 300);
}

/** How often an otherwise-valid command vanishes into the cellular void. */
const SPURIOUS_UNREACHABLE_RATE = 0.1;

/** Per-process sequence number folded into the latency seed, so repeated
 * clicks on the same button do not all land at the exact same delay. */
let commandSequence = 0;

/** Test seams. Production callers pass nothing and get real time and dice. */
export interface ExecuteOptions {
	/** RNG for the spurious-UNREACHABLE roll; inject a constant to pin it. */
	random?: () => number;
	/** Delay function; inject a resolve-immediately stub to test at speed. */
	sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(() => resolve(), ms));

/**
 * The one gate every vehicle mutation passes through: wait out the simulated
 * round trip, re-evaluate the policy against the vehicle's *current* state
 * (it may have driven off or fallen asleep while the request was in flight —
 * evaluating after the delay is what makes the latency honest rather than
 * cosmetic), roll for the spurious failure, then apply via the simulator.
 */
export async function executeVehicleCommand(
	simulator: FleetSimulator,
	vin: string,
	command: VehicleCommand,
	options: ExecuteOptions = {}
): Promise<CommandResult> {
	const random = options.random ?? Math.random;
	const sleep = options.sleep ?? realSleep;

	await sleep(commandLatencyMs(`${vin}:${command.kind}:${commandSequence++}`));

	const vehicle = simulator.getVehicle(vin);
	if (!vehicle) {
		return { ok: false, reason: "UNREACHABLE", detail: `no vehicle with VIN ${vin}` };
	}

	const verdict = evaluateVehicleCommand(vehicle, command);
	if (!verdict.ok) return verdict;

	if (random() < SPURIOUS_UNREACHABLE_RATE) {
		return {
			ok: false,
			reason: "UNREACHABLE",
			detail: `${vinTail(vehicle.vin)} did not acknowledge — try again`
		};
	}

	switch (command.kind) {
		case "setDoorLock":
			simulator.setDoorLock(vin, command.door, command.locked);
			break;
		case "setVehicleLocked":
			simulator.setVehicleLocked(vin, command.locked);
			break;
		case "unlatchChargePort":
			simulator.unlatchChargePort(vin);
			break;
	}
	return { ok: true };
}

// ── OTA preconditions ────────────────────────────────────────────────────────

/** The campaign version every eligible vehicle updates to. Fisker shipped its
 * vehicle software as plain "Fisker OS <major>.<minor>" (1.10, 2.0, 2.1), which
 * is the scheme the seeded `car_version` strings use — so the campaign is the
 * next one along rather than a date-coded build number. */
export const OTA_TARGET_VERSION = "Fisker OS 2.3";

/** Flash order for the "Flashing ECUs" stage — gateway first (it routes the
 * others' diag sessions), safety-critical domains next, infotainment last. */
export const OTA_ECUS = ["gateway", "VCU", "BMS", "BCM", "infotainment", "ADAS domain controller"] as const;

/** Progress-bar increments per stage. MUST sum to exactly 100: `withProgress`
 * increments are additive, and a sum that overshoots pins the bar at full
 * while work continues — the classic fake-progress tell. */
export const OTA_STAGE_INCREMENTS = { download: 45, verify: 10, flash: 35, reboot: 10 } as const;

export interface OtaRejection {
	reason: "ASLEEP" | "NOT_IN_PARK" | "LOW_BATTERY";
	/** Short toast-worthy phrasing: which precondition failed. */
	summary: string;
	/** UDS negative-response flavoured detail, as a scan tool would log it. */
	detail: string;
}

/**
 * Preconditions for starting an OTA install, checked against live state in
 * the order the vehicle's updater checks them. UDS 0x22 (conditionsNotCorrect)
 * with a vendor sub-code is exactly what these rejections look like on a real
 * diag session; the flavour is the point. Pure, same as the command policy.
 */
export function evaluateOtaPreconditions(vehicle: Vehicle): OtaRejection | null {
	if (!vehicle.online) {
		return {
			reason: "ASLEEP",
			summary: "vehicle is asleep",
			detail: "conditionsNotCorrect (0x22): ecuNotAwake (0x83)"
		};
	}
	if (vehicle.gear !== "P") {
		return {
			reason: "NOT_IN_PARK",
			summary: "shifter not in P",
			detail: "conditionsNotCorrect (0x22): shifterLeverNotInPark (0x90)"
		};
	}
	// Flashing ECUs on a marginal pack risks bricking the gateway when the
	// 12V rail sags mid-write; 20% is the customary floor.
	if (vehicle.charge.soc < 20) {
		return {
			reason: "LOW_BATTERY",
			summary: "battery below 20%",
			detail: "conditionsNotCorrect (0x22): batterySocTooLow (0x8F)"
		};
	}
	return null;
}
