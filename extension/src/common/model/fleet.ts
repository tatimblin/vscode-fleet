import { generateVin } from "./vin";
import type {
	DoorId,
	DoorState,
	Dtc,
	SoftwareUpdateState,
	Vehicle,
	WindowState
} from "./types";

/**
 * The seeded demo fleet.
 *
 * Every vehicle is a Fisker Ocean, because the post this demo is embedded in
 * is about the author's time at Fisker — a fleet of somebody else's cars would
 * be the first thing a reader who was there noticed. WMI `VCF` is Fisker's,
 * plant code `G` is Graz, Austria (Magna Steyr built every Ocean), and the
 * trims (One, Extreme, Ultra, Sport) are the four that actually shipped.
 *
 * Six vehicles, one per interesting state, chosen so that every feature the
 * extension contributes has something to point at the moment it is opened:
 * a moving vehicle for the CAN stream, a charging one for the gauges, an
 * offline one for the "asleep" empty state, a faulted one for the diagnostics
 * list, and two quiet ones so the tree does not look like every row is an
 * emergency.
 *
 * The six are split two-and-two-and-two across the three cohorts the tree
 * groups by, and the split is not alphabetical: Stage holds the faulted Sport
 * and one idler, because staging is where broken things and things nobody is
 * driving end up; North America holds the mover and the other idler; EMEA
 * holds the one on a charger and the one asleep, both parked on real European
 * coordinates. Two per cohort so no group renders as a lone row under a
 * heading, which reads as a bug rather than as a fleet.
 *
 * `seedFleet()` returns a *fresh* array of fresh objects on every call. This is
 * load-bearing: `fleet.reset` re-seeds by calling it again, and if it returned
 * a shared module-level constant the simulator's in-place mutations from the
 * previous session would still be sitting in it, so "Reset Demo" would reset
 * nothing.
 */

/** All four corners, in the order the controls webview lays them out. */
const DOOR_IDS: readonly DoorId[] = ["FL", "FR", "RL", "RR"];

/** Every door locked and closed — the state five of the six vehicles start in. */
function closedDoors(locked: boolean): Record<DoorId, DoorState> {
	return Object.fromEntries(
		DOOR_IDS.map((id) => [id, { locked, open: false }])
	) as Record<DoorId, DoorState>;
}

/** Every window fully up. */
function closedWindows(): Record<DoorId, WindowState> {
	return Object.fromEntries(
		DOOR_IDS.map((id) => [id, { position: 0 }])
	) as Record<DoorId, WindowState>;
}

/** No OTA campaign in flight — every vehicle seeds this way; the OTA flow
 * mutates it live through the simulator so open `state.json` tabs can watch
 * `software_update` advance. A fresh object per call, same as the fleet. */
function idleSoftwareUpdate(): SoftwareUpdateState {
	return { status: "", version: "", downloadPerc: 0, installPerc: 0 };
}

/**
 * The faulted vehicle's stored trouble codes: real SAE codes with their real
 * titles, in the order a scan tool would list them (powertrain codes ascending,
 * then network codes).
 *
 * They tell one coherent story rather than being five unrelated codes, which is
 * what makes the diagnostics panel worth reading: the pack is degraded (P0A80)
 * and cannot hold charge (P0A7D) while running hot (P0A7E), which has dragged
 * the 12V system down (P0562) far enough that the ECM dropped off the bus
 * (U0100). A reader who knows OBD-II sees a failure chain; one who does not
 * still sees plausible codes.
 */
const FAULTED_DTC_SPECS: ReadonlyArray<{
	code: string;
	description: string;
	status: Dtc["status"];
	/** Minutes before "now" the code was set — newest last. */
	minutesAgo: number;
}> = [
	{ code: "P0A80", description: "Replace Hybrid Battery Pack", status: "confirmed", minutesAgo: 2874 },
	{ code: "P0A7D", description: "Hybrid Battery Pack State of Charge Low", status: "confirmed", minutesAgo: 1140 },
	{ code: "P0A7E", description: "Hybrid Battery Pack Over Temperature", status: "confirmed", minutesAgo: 412 },
	{ code: "P0562", description: "System Voltage Low", status: "confirmed", minutesAgo: 96 },
	{ code: "U0100", description: "Lost Communication With ECM/PCM \"A\"", status: "pending", minutesAgo: 11 }
];

const MINUTE_MS = 60_000;

/**
 * Build the demo fleet.
 *
 * @param now Epoch milliseconds treated as "the present" — injectable so tests
 *   and the selftest get stable timestamps instead of depending on wall clock.
 *   VINs do not depend on it: they are derived from the WMI/year/serial below,
 *   so a vehicle keeps the same VIN (and therefore the same VFS path) across
 *   resets and across extension-host restarts.
 */
export function seedFleet(now: number = Date.now()): Vehicle[] {
	return [
		// ── Driving ──────────────────────────────────────────────────────────────
		// Northbound on US-101 through Palo Alto, heading 328° (roughly NNW toward
		// San Francisco). Real coordinates on a real road, because the map preview
		// in the controls editor plots them and a point in the ocean reads as a bug.
		{
			vin: generateVin({ wmi: "VCF", year: 2023, serial: 2314, plant: "G" }),
			cohort: "North America",
			make: "Fisker",
			model: "Ocean Extreme",
			year: 2023,
			personality: "driving",
			online: true,
			locked: true,
			doors: closedDoors(true),
			windows: closedWindows(),
			gear: "D",
			speedKph: 103,
			odometerKm: 41_286,
			cabinTempC: 21,
			climateOn: true,
			// Hyper Range pack (~106 kWh), rated ~579 km / 360 mi: 62% of that is
			// ~359 km. Range is kept as a straight fraction of the trim's rating
			// throughout the seed, because a reader who divides one by the other
			// is exactly the reader this demo is written for.
			charge: {
				soc: 62,
				rangeKm: 359,
				pluggedIn: false,
				charging: false,
				powerKw: 0,
				batteryTempC: 32
			},
			position: { lat: 37.4419, lon: -122.143, heading: 328 },
			dtcs: [],
			firmwareVersion: "Fisker OS 2.1",
			softwareUpdate: idleSoftwareUpdate(),
			lastUpdated: now
		},

		// ── Charging ─────────────────────────────────────────────────────────────
		// Mid-range SoC and mid-taper power: the Ocean's 400 V pack peaks near
		// 120 kW on a DC charger and is already tapering by 54%, so 112 kW is off
		// the peak but nowhere near the slow tail — the gauge visibly moves during
		// a demo instead of sitting still.
		{
			vin: generateVin({ wmi: "VCF", year: 2023, serial: 487, plant: "G" }),
			cohort: "EMEA",
			make: "Fisker",
			model: "Ocean One",
			year: 2023,
			personality: "charging",
			online: true,
			locked: true,
			doors: closedDoors(true),
			windows: closedWindows(),
			gear: "P",
			speedKph: 0,
			odometerKm: 12_904,
			cabinTempC: 19,
			climateOn: false,
			// Ocean One is the launch edition of the Extreme, so the same Hyper
			// Range rating applies: 54% of ~579 km is ~313 km.
			charge: {
				soc: 54,
				rangeKm: 313,
				pluggedIn: true,
				charging: true,
				powerKw: 112,
				batteryTempC: 38
			},
			// The DC charging bank outside the Magna Steyr plant in Graz, Austria —
			// where every Ocean was actually built, and where an EMEA vehicle would
			// plausibly be sitting on a charger.
			position: { lat: 47.0707, lon: 15.4395, heading: 0 },
			dtcs: [],
			firmwareVersion: "Fisker OS 2.1",
			softwareUpdate: idleSoftwareUpdate(),
			lastUpdated: now
		},

		// ── Asleep ───────────────────────────────────────────────────────────────
		// `online: false` is the point of this one: it is the fleet's empty state.
		// Its telemetry is a snapshot from the last time it was awake, and the
		// simulator must leave it alone — a sleeping vehicle whose odometer creeps
		// up is the classic mock-data tell.
		{
			vin: generateVin({ wmi: "VCF", year: 2024, serial: 4102, plant: "G" }),
			cohort: "EMEA",
			make: "Fisker",
			model: "Ocean Ultra",
			year: 2024,
			personality: "asleep",
			online: false,
			locked: true,
			doors: closedDoors(true),
			windows: closedWindows(),
			gear: "P",
			speedKph: 0,
			odometerKm: 28_431,
			cabinTempC: 8,
			climateOn: false,
			// Ultra shares the Hyper Range pack but rates lower than the Extreme
			// (~563 km / 350 mi) on its 20" wheels: 71% of that is ~399 km.
			charge: {
				soc: 71,
				rangeKm: 399,
				pluggedIn: false,
				charging: false,
				powerKw: 0,
				batteryTempC: 9
			},
			// A residential street in Schwabing, Munich — asleep at the kerb, which
			// is where a European customer car spends most of its life.
			position: { lat: 48.1543, lon: 11.582, heading: 92 },
			dtcs: [],
			firmwareVersion: "Fisker OS 2.0",
			softwareUpdate: idleSoftwareUpdate(),
			lastUpdated: now - 6 * 60 * MINUTE_MS
		},

		// ── Faulted ──────────────────────────────────────────────────────────────
		// Low SoC, hot pack, doors unlocked and one ajar: the state you would
		// actually find a vehicle in after the failure chain in FAULTED_DTC_SPECS.
		{
			vin: generateVin({ wmi: "VCF", year: 2023, serial: 1196, plant: "G" }),
			cohort: "Stage",
			make: "Fisker",
			model: "Ocean Sport",
			year: 2023,
			personality: "faulted",
			online: true,
			locked: false,
			doors: {
				...closedDoors(false),
				// Left ajar when the tech walked away from it.
				FL: { locked: false, open: true }
			},
			windows: { ...closedWindows(), FL: { position: 35 } },
			gear: "P",
			speedKph: 0,
			odometerKm: 96_772,
			cabinTempC: 27,
			climateOn: false,
			// Sport is the only trim on the smaller Touring Range pack (~75 kWh,
			// ~372 km / 231 mi), so 7% is ~26 km — and the degraded pack in the
			// DTC chain below is why it is the one that broke.
			charge: {
				soc: 7,
				rangeKm: 26,
				pluggedIn: false,
				charging: false,
				powerKw: 0,
				batteryTempC: 54
			},
			// Service yard in Casa Grande, AZ.
			position: { lat: 32.8795, lon: -111.7574, heading: 180 },
			dtcs: FAULTED_DTC_SPECS.map((spec) => ({
				code: spec.code,
				description: spec.description,
				status: spec.status,
				timestamp: now - spec.minutesAgo * MINUTE_MS
			})),
			// A release behind the rest of the fleet: it has been sitting in a
			// service yard, unreachable, since before Fisker OS 2.0 went out.
			firmwareVersion: "Fisker OS 1.10",
			softwareUpdate: idleSoftwareUpdate(),
			lastUpdated: now
		},

		// ── Idle ×2 ──────────────────────────────────────────────────────────────
		// Parked, awake, nothing happening. Two of them, so the tree view has a
		// majority of boring rows and the interesting ones stand out.
		{
			vin: generateVin({ wmi: "VCF", year: 2024, serial: 6755, plant: "G" }),
			cohort: "North America",
			make: "Fisker",
			model: "Ocean Extreme",
			year: 2024,
			personality: "idle",
			online: true,
			locked: true,
			doors: closedDoors(true),
			windows: closedWindows(),
			gear: "P",
			speedKph: 0,
			odometerKm: 7_215,
			cabinTempC: 16,
			climateOn: false,
			// 88% of the Extreme's ~579 km rating.
			charge: {
				soc: 88,
				rangeKm: 509,
				pluggedIn: true,
				// Plugged in but full enough that the charger has stopped — this is
				// why `pluggedIn` and `charging` are separate flags on ChargeState.
				charging: false,
				powerKw: 0,
				batteryTempC: 18
			},
			// Depot lot in Normal, IL.
			position: { lat: 40.5142, lon: -88.9906, heading: 270 },
			dtcs: [],
			firmwareVersion: "Fisker OS 2.1",
			softwareUpdate: idleSoftwareUpdate(),
			lastUpdated: now
		},
		{
			vin: generateVin({ wmi: "VCF", year: 2023, serial: 3048, plant: "G" }),
			cohort: "Stage",
			make: "Fisker",
			model: "Ocean Ultra",
			year: 2023,
			personality: "idle",
			online: true,
			locked: true,
			doors: closedDoors(true),
			windows: closedWindows(),
			gear: "P",
			speedKph: 0,
			odometerKm: 63_940,
			cabinTempC: 14,
			climateOn: false,
			// 45% of the Ultra's ~563 km rating.
			charge: {
				soc: 45,
				rangeKm: 253,
				pluggedIn: false,
				charging: false,
				powerKw: 0,
				batteryTempC: 15
			},
			// Street parking in Seattle, WA.
			position: { lat: 47.6205, lon: -122.3493, heading: 5 },
			dtcs: [],
			firmwareVersion: "Fisker OS 2.0",
			softwareUpdate: idleSoftwareUpdate(),
			lastUpdated: now
		}
	];
}
