/**
 * The single shared vocabulary for the whole demo.
 *
 * Three consumers read these types, and they are deliberately shaped to serve
 * all three without a translation layer:
 *
 *   1. the simulator, which mutates a `Vehicle` on a clock tick;
 *   2. the virtual file system, which serialises a `Vehicle` to JSON that a
 *      user can read (and, for some fields, edit) in an editor tab;
 *   3. the webview protocol, which posts vehicle state across a `postMessage`
 *      boundary.
 *
 * That third consumer is why every type here is a plain interface or string
 * union over JSON-safe primitives — no classes, no `Date`, no `Map`, no
 * methods. `postMessage` uses the structured clone algorithm, which silently
 * drops methods and rebuilds prototypes as bare objects; a class instance that
 * survives the trip arrives as something that no longer answers `instanceof`,
 * and the failure shows up far from its cause. Timestamps are therefore epoch
 * milliseconds (`number`) rather than `Date`.
 *
 * String unions (rather than enums) for the same reason: a TS `enum` compiles
 * to a runtime object the webview bundle would have to import, whereas a union
 * of string literals is erased entirely and still round-trips through JSON.
 */

/**
 * Corner identifiers, used for both doors and windows. Front/Rear × Left/Right,
 * as they are labelled on a wiring harness.
 */
export type DoorId = "FL" | "FR" | "RL" | "RR";

/** Per-door state. A door can be unlocked and closed, or locked and open (an ajar warning). */
export interface DoorState {
	locked: boolean;
	open: boolean;
}

/**
 * Window position as a percentage: 0 = fully closed, 100 = fully down. A
 * percentage rather than an open/closed boolean because the controls webview
 * animates a partial roll-down.
 */
export interface WindowState {
	/** 0–100. */
	position: number;
}

/** Shifter position. No "L"/"B" — the demo fleet is all single-speed EVs. */
export type GearPosition = "P" | "R" | "N" | "D";

/**
 * Battery and charging state. `soc` is state of charge in percent; `rangeKm` is
 * stored in kilometres always, and converted at the *display* edge according to
 * the `fleet.units` setting. Storing the canonical unit and converting late is
 * what keeps a units toggle from corrupting the simulation.
 */
export interface ChargeState {
	/** State of charge, 0–100. */
	soc: number;
	/** Estimated remaining range in kilometres (canonical unit — convert on display). */
	rangeKm: number;
	pluggedIn: boolean;
	charging: boolean;
	/** Instantaneous charge power in kilowatts; 0 when not charging. */
	powerKw: number;
	/** Pack temperature in degrees Celsius (canonical unit — convert on display). */
	batteryTempC: number;
}

/**
 * Over-the-air firmware update state, mirroring the Owner API's
 * `vehicle_state.software_update` block. Idle is `status: ""` with a blank
 * version — the real API reports `" "` (a single space) when no campaign is
 * pending, and serialize.ts reproduces that quirk at the JSON edge; the model
 * keeps a plain empty string so code can test truthiness without knowing it.
 */
export interface SoftwareUpdateState {
	/** "" = no update in flight; otherwise the phase the installer is in. */
	status: "" | "downloading" | "installing";
	/** Target version of the in-flight campaign; "" when idle. */
	version: string;
	/** Download progress, 0–100. */
	downloadPerc: number;
	/** Install (flash) progress, 0–100. */
	installPerc: number;
}

/**
 * The behaviour profile the simulator applies on each tick. This is the demo's
 * central knob: it is what makes six rows in a tree view feel like a fleet
 * rather than six copies of the same JSON. The simulator switches on it, and
 * the switcher derives its per-row glyph and telemetry line from it. (The
 * tree deliberately does NOT: its rows carry one neutral icon, and the state
 * reaches them through file decorations instead.)
 */
export type VehiclePersonality = "driving" | "charging" | "asleep" | "faulted" | "idle";

/** A stored diagnostic trouble code, as an OBD-II scan tool would report it. */
export interface Dtc {
	/** SAE code, e.g. "P0A80". */
	code: string;
	/** Human-readable title for the code. */
	description: string;
	/** Epoch milliseconds — see the note above on why this is not a `Date`. */
	timestamp: number;
	/**
	 * A pending code has been seen once; a confirmed code has been seen across
	 * consecutive drive cycles and is what illuminates the dashboard lamp.
	 */
	status: "pending" | "confirmed";
}

/**
 * One frame off the vehicle's CAN bus, as the CAN stream view renders it.
 *
 * `data` is a byte array rather than a hex string because the stream view
 * formats it (hex, decimal, or decoded signal) at render time, and because a
 * string would make it too easy to emit a frame whose payload length disagrees
 * with `dlc`. Classic CAN carries 0–8 bytes, so `dlc` and `data.length` must
 * match and must be ≤ 8.
 */
export interface CanFrame {
	/** Epoch milliseconds. */
	timestamp: number;
	/** 11-bit arbitration ID (0x000–0x7FF), stored as a number, rendered as hex. */
	id: number;
	/** Data length code: 0–8, and always equal to `data.length`. */
	dlc: number;
	/** Payload bytes, each 0–255. */
	data: number[];
	/** Optional human label for the frame, e.g. "BMS_SOC". */
	label?: string;
}

/** GPS fix. Heading is degrees clockwise from true north. */
export interface GeoPosition {
	lat: number;
	lon: number;
	/** Degrees, 0–359, clockwise from true north. */
	heading: number;
}

/**
 * The operating cohorts the fleet is divided into — the top level of the
 * Vehicles tree, and the grouping the vehicle switcher repeats.
 *
 * Deliberately the vocabulary a real fleet console uses: one *environment*
 * ("Stage", where the broken and the not-yet-released live) and two
 * *regions*. Mixing the two kinds in one axis looks wrong on paper and is
 * exactly what operators do, because a vehicle leaves its region the moment
 * it is pulled for testing.
 *
 * A union of literals rather than a lookup table because the strings ARE the
 * headings — there is no separate display name to keep in step, which is the
 * whole point of this file (see the note at the top on JSON-safe types).
 */
export type FleetCohort = "Stage" | "North America" | "EMEA";

/**
 * A single vehicle — the unit of everything in the demo. `vin` is the only
 * identifier: the VFS maps one directory per vehicle at `fleet:/<VIN>`, the
 * tree labels rows with it, and every compact surface shows its last six
 * characters. There is deliberately no name field — a fleet operator does not
 * name six hundred cars, and a demo that does is a demo about six pets.
 */
export interface Vehicle {
	/** 17-character VIN — see `vin.ts`; always passes `isValidVin`. */
	vin: string;
	/** Which cohort's directory this vehicle sits under in the tree. */
	cohort: FleetCohort;
	make: string;
	model: string;
	year: number;
	personality: VehiclePersonality;
	/** True when the vehicle is awake and reporting; false for "asleep". */
	online: boolean;
	locked: boolean;
	doors: Record<DoorId, DoorState>;
	windows: Record<DoorId, WindowState>;
	gear: GearPosition;
	/** Road speed in km/h (canonical unit — convert on display). */
	speedKph: number;
	/** Odometer in kilometres (canonical unit — convert on display). */
	odometerKm: number;
	/** Cabin climate setpoint in degrees Celsius. */
	cabinTempC: number;
	climateOn: boolean;
	charge: ChargeState;
	position: GeoPosition;
	/** Stored trouble codes. Empty for every vehicle except the faulted one. */
	dtcs: Dtc[];
	/** Installed firmware version, bumped by `fleet.installFirmwareUpdate`. */
	firmwareVersion: string;
	/** In-flight OTA campaign, if any — see `SoftwareUpdateState`. */
	softwareUpdate: SoftwareUpdateState;
	/** Epoch milliseconds of the last simulator tick that touched this vehicle. */
	lastUpdated: number;
}
