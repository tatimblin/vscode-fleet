/**
 * Pure-logic selftest for the fleet model.
 *
 * Why a Bun script instead of a test runner: everything under
 * `src/common/model/` is deliberately free of any `vscode` import, so it can be
 * exercised without an extension host, a display, or a downloaded VS Code
 * build. Keeping that property verifiable is half the point of the test — the
 * moment this script cannot run, the model has grown a host dependency and the
 * webview will not be able to import it either.
 *
 * Run with `bun run selftest`. Exits non-zero on the first failure so it can be
 * wired into CI as-is.
 */

import { computeCheckDigit, generateVin, isValidVin, vinTail } from "../src/common/model/vin";
import { seedFleet } from "../src/common/model/fleet";
import type { VehiclePersonality } from "../src/common/model/types";
import { FleetSimulator } from "../src/common/sim/clock";
import type { AmbientEvent } from "../src/common/sim/clock";
import {
	canSignalSnapshot,
	decodeFrameAnnotation,
	encodeBmsSocUi,
	encodeDiSpeed,
	encodeDiSystemStatus,
	encodeDiTorque1,
	encodeGtwCarState,
	encodeWheelSpeeds,
	getBitsLE,
	motorRpmFor,
	motorTorqueNmFor
} from "../src/common/sim/can";
import type { CanFrame } from "../src/common/model/types";
import { FLEET_DBC, parseDbcSignals } from "../src/common/sim/dbcText";
import { DECORATION_BADGES, decorationFor, dtcSeverity } from "../src/common/model/status";
import { describeSignalMarkdown, escapeTableCell } from "../src/common/model/dbcHover";
import {
	commandLatencyMs,
	evaluateOtaPreconditions,
	evaluateVehicleCommand,
	executeVehicleCommand,
	OTA_ECUS,
	OTA_STAGE_INCREMENTS,
	OTA_TARGET_VERSION
} from "../src/common/vehicleCommands";

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
	if (condition) {
		console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures++;
		console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

console.log("vin: reference cases");

// The canonical worked example from the FMVSS 565 literature. Its weighted sum
// is 351; 351 mod 11 = 10, which is the case that must render as "X" rather
// than as the digits "10". A naive implementation that returns String(10) here
// produces an 18-character VIN and nothing downstream notices.
const REFERENCE_VIN = "1M8GDM9AXKP042788";
check("1M8GDM9AXKP042788 check digit is X", computeCheckDigit(REFERENCE_VIN) === "X", computeCheckDigit(REFERENCE_VIN));
check("1M8GDM9AXKP042788 validates", isValidVin(REFERENCE_VIN));

// A hand-verified Fisker Ocean VIN: WMI VCF, VDS 1ZBU2, year P = 2023, plant
// G = Graz. Its weighted sum is 366 and 366 mod 11 = 3, which is the digit in
// position 9. This is the shape the seeded fleet claims to be, checked against
// a VIN nobody in this repo generated — so a generator that drifted into
// producing self-consistent nonsense would still fail here.
const OCEAN_VIN = "VCF1ZBU23PG001985";
check("VCF1ZBU23PG001985 check digit is 3", computeCheckDigit(OCEAN_VIN) === "3", computeCheckDigit(OCEAN_VIN));
check("VCF1ZBU23PG001985 validates", isValidVin(OCEAN_VIN));

// All-ones: every character transliterates to 1, so the sum is just the sum of
// the weights (89), and 89 mod 11 = 1 — which happens to be the character
// already sitting in position 9. A degenerate but load-bearing case: it is the
// only reference that catches a wrong *weight* while every transliteration is
// right.
const ONES_VIN = "11111111111111111";
check("11111111111111111 check digit is 1", computeCheckDigit(ONES_VIN) === "1", computeCheckDigit(ONES_VIN));
check("11111111111111111 validates", isValidVin(ONES_VIN));

// S transliterates to 2, not 1. This is the specific value an arithmetic
// shortcut over character codes gets wrong; assert it directly so the failure
// names itself instead of surfacing as "some VIN is invalid".
check(
	"S transliterates to 2 (not 1)",
	computeCheckDigit("1S111111111111111") === computeCheckDigit("1B111111111111111"),
	"S and B must contribute the same weighted value"
);

console.log("");
console.log("vin: rejects malformed input");

check("rejects wrong length", !isValidVin("1M8GDM9AXKP04278"));
check("rejects illegal letter I", !isValidVin("1M8GDM9AXKP04278I"));
check("rejects illegal letter O", !isValidVin("OM8GDM9AXKP042788"));
check("rejects illegal letter Q", !isValidVin("QM8GDM9AXKP042788"));
check("rejects empty string", !isValidVin(""));

console.log("");
console.log("vin: single-character mutations are caught");

// A mod-11 check digit catches a single-character substitution *unless* the
// two characters transliterate to the same value — the mapping is many-to-one
// by design (1, A and J are all worth 1), so those substitutions are provably
// invisible to any check digit, not a bug in this implementation. Position 1 of
// the reference VIN holds "1", so mutating it across the whole alphabet must
// leave exactly "A" and "J" standing and nothing else.
const ALPHABET = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ";
const survivors: string[] = [];
for (const char of ALPHABET) {
	if (char === REFERENCE_VIN[0]) continue;
	if (isValidVin(char + REFERENCE_VIN.slice(1))) survivors.push(char);
}
check(
	"position 1 mutations survive only on transliteration collisions",
	survivors.join("") === "AJ",
	`survivors: ${survivors.join("") || "none"} (of ${ALPHABET.length - 1} mutations)`
);

// Sweep every position and every substitution to quantify the check digit's
// real strength, rather than trusting one position.
let mutations = 0;
let falseAccepts = 0;
for (let i = 0; i < REFERENCE_VIN.length; i++) {
	// Position 9 IS the check digit; changing it is a different kind of error and
	// is covered by the reference case above.
	if (i === 8) continue;
	for (const char of ALPHABET) {
		if (char === REFERENCE_VIN[i]) continue;
		mutations++;
		const mutated = REFERENCE_VIN.slice(0, i) + char + REFERENCE_VIN.slice(i + 1);
		if (isValidVin(mutated)) falseAccepts++;
	}
}
check(
	"single-character mutations are overwhelmingly rejected",
	falseAccepts / mutations < 0.1,
	`${falseAccepts}/${mutations} accepted (${((falseAccepts / mutations) * 100).toFixed(1)}%)`
);

console.log("");
console.log("vin: short form");

// Every compact surface in the extension refers to a vehicle by this string,
// so the digit count and the leading ellipsis are effectively public API: a
// change here silently rewrites the editor tab, the terminal name, every
// toast and the switcher's labels all at once.
check("vinTail is an ellipsis plus the last six characters", vinTail(REFERENCE_VIN) === "…042788", vinTail(REFERENCE_VIN));
check("vinTail's tail is the VIN's serial field (positions 12–17)", vinTail(OCEAN_VIN) === `…${OCEAN_VIN.slice(11)}`, vinTail(OCEAN_VIN));
check("vinTail is 7 characters wide for any valid VIN", [...vinTail(OCEAN_VIN)].length === 7);

console.log("");
console.log("vin: generator");

// Every WMI × every supported year × a spread of serials must produce a VIN
// that its own validator accepts. This is the property that actually matters:
// the generator and the validator are two independent readings of the same
// spec, and they have to agree.
// VCF is the fleet's own WMI; the rest are other real manufacturers' codes,
// kept only because they exercise different digit/letter mixes through the
// transliteration table than a single all-letter WMI would.
const WMIS = ["VCF", "1FA", "JN1", "WBA", "5UX"];
const YEARS = [2022, 2023, 2024, 2025, 2026];
let generated = 0;
let invalid = 0;
for (const wmi of WMIS) {
	for (const year of YEARS) {
		for (const serial of [0, 1, 7, 42, 8871, 118342, 999999]) {
			const vin = generateVin({ wmi, year, serial });
			generated++;
			if (vin.length !== 17 || !isValidVin(vin)) invalid++;
		}
	}
}
check("every generated VIN is valid", invalid === 0, `${generated - invalid}/${generated} valid`);

// Determinism: the VFS keys editor URIs off the VIN, so the same inputs must
// give the same VIN forever, not just within one process.
check(
	"generation is deterministic",
	generateVin({ wmi: "VCF", year: 2023, serial: 2314 }) ===
		generateVin({ wmi: "VCF", year: 2023, serial: 2314 })
);

const YEAR_CODE_CASES: Array<[number, string]> = [
	[2022, "N"],
	[2023, "P"],
	[2024, "R"],
	[2025, "S"],
	[2026, "T"]
];
for (const [year, code] of YEAR_CODE_CASES) {
	const vin = generateVin({ wmi: "VCF", year, serial: 1 });
	check(`year ${year} encodes as "${code}"`, vin[9] === code, vin);
}

console.log("");
console.log("fleet: seed");

const fleet = seedFleet(1_756_857_600_000);

check("seeds 6 vehicles", fleet.length === 6, `${fleet.length}`);
check("every VIN is valid", fleet.every((v) => isValidVin(v.vin)));
check("VINs are unique", new Set(fleet.map((v) => v.vin)).size === fleet.length);

// The whole fleet is Fisker Oceans on purpose (see fleet.ts) — assert the
// identity rather than trusting six hand-written literals to stay in step.
check("every VIN carries Fisker's WMI", fleet.every((v) => v.vin.startsWith("VCF")));
check("every VIN is built in Graz", fleet.every((v) => v.vin[10] === "G"));
check("every vehicle is a Fisker", fleet.every((v) => v.make === "Fisker"));
check(
	"every model is an Ocean trim",
	fleet.every((v) => /^Ocean (One|Extreme|Ultra|Sport)$/.test(v.model)),
	fleet.map((v) => v.model).join(", ")
);
check(
	"model years are the two Fisker actually built",
	fleet.every((v) => v.year === 2023 || v.year === 2024),
	fleet.map((v) => v.year).join(", ")
);
// Position 10 is the year code, so the VIN and the `year` field cannot drift
// apart without one of them being wrong in a decoder.
check(
	"VIN year codes agree with the year field",
	fleet.every((v) => v.vin[9] === (v.year === 2023 ? "P" : "R")),
	fleet.map((v) => `${v.year}=${v.vin[9]}`).join(", ")
);
check(
	"every vehicle runs a Fisker OS build",
	fleet.every((v) => /^Fisker OS \d+\.\d+$/.test(v.firmwareVersion)),
	fleet.map((v) => v.firmwareVersion).join(", ")
);

const counts = fleet.reduce<Record<string, number>>((acc, v) => {
	acc[v.personality] = (acc[v.personality] ?? 0) + 1;
	return acc;
}, {});
const EXPECTED: Record<VehiclePersonality, number> = {
	driving: 1,
	charging: 1,
	asleep: 1,
	faulted: 1,
	idle: 2
};
for (const [personality, expected] of Object.entries(EXPECTED)) {
	check(`${expected}× "${personality}"`, counts[personality] === expected, `got ${counts[personality] ?? 0}`);
}

// ── Cohorts ────────────────────────────────────────────────────────────────
// The tree's top level. Two per cohort is the shape the sidebar was designed
// around (a lone row under a heading reads as a bug), and WHICH vehicle sits
// where is the story: staging holds the broken one.
const COHORT_ORDER = ["Stage", "North America", "EMEA"] as const;
const byCohort = (cohort: string): typeof fleet => fleet.filter((v) => v.cohort === cohort);

check(
	"every vehicle names one of the three cohorts",
	fleet.every((v) => (COHORT_ORDER as readonly string[]).includes(v.cohort)),
	fleet.map((v) => v.cohort).join(", ")
);
for (const cohort of COHORT_ORDER) {
	check(`"${cohort}" holds exactly 2 vehicles`, byCohort(cohort).length === 2, `${byCohort(cohort).length}`);
}
check(
	"the faulted vehicle is in Stage",
	fleet.find((v) => v.personality === "faulted")!.cohort === "Stage",
	fleet.find((v) => v.personality === "faulted")!.cohort
);
check(
	"North America holds the mover",
	byCohort("North America").some((v) => v.personality === "driving")
);
// Longitude is the cheap discriminator: every North American seed is west of
// -80 and every European one east of 0, so a coordinate copy-pasted from the
// wrong hemisphere (the classic way a "European" fleet ends up in Kansas)
// fails here rather than in a map preview nobody opens.
check(
	"EMEA vehicles are actually in Europe",
	byCohort("EMEA").every(
		(v) => v.position.lon > -10 && v.position.lon < 40 && v.position.lat > 35 && v.position.lat < 71
	),
	byCohort("EMEA").map((v) => `${v.position.lat},${v.position.lon}`).join(" ")
);
check(
	"the North American vehicles stayed in North America",
	byCohort("North America").every((v) => v.position.lon < -60),
	byCohort("North America").map((v) => v.position.lon).join(", ")
);

const driving = fleet.find((v) => v.personality === "driving")!;
check("driving vehicle is in gear D", driving.gear === "D");
check("driving vehicle has nonzero speed", driving.speedKph > 0, `${driving.speedKph} km/h`);
check(
	"driving vehicle has a plausible GPS fix",
	Math.abs(driving.position.lat) <= 90 && Math.abs(driving.position.lon) <= 180,
	`${driving.position.lat}, ${driving.position.lon}`
);

const charging = fleet.find((v) => v.personality === "charging")!;
check("charging vehicle is plugged in and charging", charging.charge.pluggedIn && charging.charge.charging);
check("charging vehicle has mid-range SoC", charging.charge.soc >= 30 && charging.charge.soc <= 80, `${charging.charge.soc}%`);
check("charging vehicle draws power", charging.charge.powerKw > 0, `${charging.charge.powerKw} kW`);

const asleep = fleet.find((v) => v.personality === "asleep")!;
check("asleep vehicle is offline", asleep.online === false);
check("asleep vehicle is stationary", asleep.speedKph === 0 && asleep.gear === "P");

const faulted = fleet.find((v) => v.personality === "faulted")!;
const EXPECTED_DTCS = ["P0A80", "P0A7D", "P0A7E", "P0562", "U0100"];
check("faulted vehicle carries 5 DTCs", faulted.dtcs.length === 5, `${faulted.dtcs.length}`);
check(
	"faulted vehicle carries the expected codes",
	EXPECTED_DTCS.every((code) => faulted.dtcs.some((d) => d.code === code)),
	faulted.dtcs.map((d) => d.code).join(", ")
);
check("every DTC has a description", faulted.dtcs.every((d) => d.description.length > 0));
check("every DTC has a timestamp", faulted.dtcs.every((d) => Number.isFinite(d.timestamp) && d.timestamp > 0));
check("no other vehicle has DTCs", fleet.filter((v) => v.dtcs.length > 0).length === 1);

// `fleet.reset` re-seeds by calling seedFleet() again, so it must hand back
// fresh objects — a shared constant would carry the previous session's
// simulator mutations straight through the reset.
const a = seedFleet(0);
const b = seedFleet(0);
a[0]!.speedKph = 999;
check("seedFleet returns fresh objects", b[0]!.speedKph !== 999);
check("seedFleet is VIN-stable across calls", a.map((v) => v.vin).join() === b.map((v) => v.vin).join());


// ────────────────────────────────────────────────────────────────────────────
// Simulator. Constructed directly and driven with explicit `tick(now)` calls —
// virtual time, no interval, no sleeping — which is only possible because
// src/common/sim/ has no `vscode` import. If these lines ever fail to *load*,
// that property broke.
// ────────────────────────────────────────────────────────────────────────────

console.log("");
console.log("sim: physics");

const T0 = 1_756_857_600_000;
const sim = new FleetSimulator(T0);
const mover = sim.getVehicles().find((v) => v.personality === "driving")!;
const charger = sim.getVehicles().find((v) => v.personality === "charging")!;
const sleeper = sim.getVehicles().find((v) => v.personality === "asleep")!;
const faulty = sim.getVehicles().find((v) => v.personality === "faulted")!;

const seedLat = mover.position.lat;
const seedLon = mover.position.lon;
const seedOdometer = mover.odometerKm;
const sleeperBefore = JSON.stringify(sleeper);
const faultyBefore = JSON.stringify(faulty);

const changedVins = new Set<string>();
sim.onVehicleChanged((vin) => changedVins.add(vin));

// 120 ticks × 250 ms = 30 s of virtual driving/charging.
let socMonotonic = true;
let speedInBounds = true;
let lastSoc = charger.charge.soc;
let now = T0;
for (let i = 0; i < 120; i++) {
	now = T0 + (i + 1) * 250;
	sim.tick(now);
	if (charger.charge.soc < lastSoc) socMonotonic = false;
	lastSoc = charger.charge.soc;
	if (mover.speedKph < 90 || mover.speedKph > 115) speedInBounds = false;
}

check("the mover's speed stays within 90–115 km/h across 120 ticks", speedInBounds, `${mover.speedKph.toFixed(1)} km/h now`);
check(
	"the mover's GPS advanced",
	mover.position.lat !== seedLat || mover.position.lon !== seedLon,
	`${seedLat},${seedLon} → ${mover.position.lat.toFixed(5)},${mover.position.lon.toFixed(5)}`
);
check("the mover's odometer advanced", mover.odometerKm > seedOdometer, `+${(mover.odometerKm - seedOdometer).toFixed(3)} km`);
check("the charging vehicle's SoC rose monotonically", socMonotonic && charger.charge.soc > 54, `54% → ${charger.charge.soc.toFixed(1)}%`);
check("charge power tapers but stays positive", charger.charge.powerKw > 0 && charger.charge.powerKw < 147, `${charger.charge.powerKw} kW`);
check("asleep vehicle untouched by the clock", JSON.stringify(sleeper) === sleeperBefore);
check("faulted vehicle untouched by the clock", JSON.stringify(faulty) === faultyBefore);
check(
	"onVehicleChanged fired for the movers, not the sleepers",
	changedVins.has(mover.vin) && changedVins.has(charger.vin) && !changedVins.has(sleeper.vin) && !changedVins.has(faulty.vin),
	[...changedVins].map((vin) => vin.slice(-6)).join(", ")
);

console.log("");
console.log("sim: serialization");

const stateJson = sim.serializeState(mover.vin);
let state: Record<string, any> | null = null;
try {
	state = JSON.parse(stateJson);
} catch {
	state = null;
}
check("serializeState produces parseable JSON", state !== null, `${stateJson.length} bytes`);
check(
	"state has charge_state / climate_state / drive_state / vehicle_state",
	!!state && ["charge_state", "climate_state", "drive_state", "vehicle_state"].every((key) => typeof state![key] === "object")
);
check(
	"vehicle_state carries df/dr/pf/pr and ft/rt",
	!!state && ["df", "dr", "pf", "pr", "ft", "rt"].every((key) => typeof state!.vehicle_state[key] === "number")
);
check(
	"vehicle_state carries locked, odometer and software_update{status,version}",
	!!state &&
		typeof state.vehicle_state.locked === "boolean" &&
		typeof state.vehicle_state.odometer_km === "number" &&
		typeof state.vehicle_state.software_update?.status === "string" &&
		typeof state.vehicle_state.software_update?.version === "string"
);

const dtcsJson = sim.serializeDtcs(faulty.vin);
let dtcsDoc: Record<string, any> | null = null;
try {
	dtcsDoc = JSON.parse(dtcsJson);
} catch {
	dtcsDoc = null;
}
check("serializeDtcs produces parseable JSON with 5 codes", !!dtcsDoc && dtcsDoc.count === 5 && dtcsDoc.codes.length === 5);

// The vehicles have no names, and `display_name` is the one field in the
// Owner API shape that would smuggle one back in.
check(
	"display_name is the VIN tail, not a name",
	!!state && state.display_name === vinTail(mover.vin),
	String(state?.display_name)
);

console.log("");
console.log("sim: CAN ring buffer");

// 120 ticks at ~300 frames each is ~36,000 frames offered; the cap is 4,096.
check("ring buffer respects its cap under overfill", sim.bufferedFrameCount <= 4096, `${sim.bufferedFrameCount} buffered`);
check("ring buffer actually filled to its cap", sim.bufferedFrameCount === 4096, `${sim.bufferedFrameCount}`);

const oldest = sim.drainFrames(1)[0]!;
// Drop-oldest: the earliest surviving frame must postdate the early ticks
// whose frames were pushed out. 4,096 frames at ~1,200/s is ~3.4 s of tail
// out of 30 s simulated.
check("overfill dropped the oldest frames", oldest.timestamp > T0 + 20_000, `oldest at T0+${oldest.timestamp - T0} ms`);

const drained = sim.drainFrames(500);
check("drainFrames honours max", drained.length === 500, `${drained.length}`);
check("drainFrames removes what it returns", sim.bufferedFrameCount === 4096 - 1 - 500, `${sim.bufferedFrameCount} left`);
check("frames are well-formed (dlc matches data, 11-bit ids)", drained.every((f) => f.dlc === f.data.length && f.dlc <= 8 && f.id >= 0 && f.id <= 0x7ff));

// DI_speed round-trip: the last DI_speed frame in the buffer was encoded from
// the mover's post-physics speed on the final tick, which nothing has changed
// since. Decode 12|12@1+ with the real DBC scaling: kph = raw × 0.08 − 40.
const rest = sim.drainFrames(10_000);
const lastSpeedFrame = [...rest].reverse().find((f) => f.label === "DI_speed");
check("buffer contains DI_speed frames (id 599)", !!lastSpeedFrame && lastSpeedFrame.id === 599);
if (lastSpeedFrame) {
	const decodedKph = getBitsLE(lastSpeedFrame.data, 12, 12) * 0.08 - 40;
	check(
		"DI_speed round-trips through factor 0.08 / offset −40",
		Math.abs(decodedKph - mover.speedKph) <= 0.04 + 1e-9,
		`decoded ${decodedKph.toFixed(2)} vs actual ${mover.speedKph.toFixed(2)} km/h`
	);
}
check("drained dry", sim.bufferedFrameCount === 0);

console.log("");
console.log("sim: mtime monotonicity and mutations");

const m1 = sim.mtimeOf(mover.vin);
check("setDoorLock mutates the door", sim.setDoorLock(mover.vin, "FL", false) && mover.doors.FL.locked === false);
check("vehicle-level locked reflects the doors", mover.locked === false);
const m2 = sim.mtimeOf(mover.vin);
sim.tick(now + 250);
const m3 = sim.mtimeOf(mover.vin);
check("mtime strictly increases across mutations", m1 < m2 && m2 < m3, `${m1} < ${m2} < ${m3}`);
check("setDoorLock rejects unknown VINs", sim.setDoorLock("NOSUCHVIN000000000", "FL", true) === false);

console.log("");
console.log("sim: reset");

const preResetMtime = sim.mtimeOf(mover.vin);
sim.reset();
const fresh = seedFleet();
const moverAfter = sim.getVehicle(mover.vin)!;
const chargerAfter = sim.getVehicle(charger.vin)!;
check("reset restores the seeded speed", moverAfter.speedKph === fresh[0]!.speedKph, `${moverAfter.speedKph} km/h`);
check("reset restores the seeded SoC", chargerAfter.charge.soc === fresh[1]!.charge.soc, `${chargerAfter.charge.soc}%`);
check("reset re-locks the unlocked door", moverAfter.doors.FL.locked === true && moverAfter.locked === true);
check("reset keeps VINs (and therefore VFS paths) stable", sim.getVehicles().map((v) => v.vin).join() === fresh.map((v) => v.vin).join());
check("reset clears the frame buffer", sim.bufferedFrameCount === 0);
// The one thing reset must NOT reset: a rewound mtime would pin stale bytes
// in any open editor (see clock.ts).
check("mtime keeps advancing across reset", sim.mtimeOf(mover.vin) > preResetMtime, `${preResetMtime} → ${sim.mtimeOf(mover.vin)}`);

sim.dispose();

// ────────────────────────────────────────────────────────────────────────────
// The async command layer, wake/sleep, OTA transitions and bus targeting.
// Same rule as the simulator sections above: everything here loads and runs
// without vscode, driven with injected sleep/random so every path — including
// the "async" ones — completes in microseconds and deterministically. If the
// import at the top of this file ever fails to load, vehicleCommands.ts grew
// a vscode dependency and the whole layer stopped being testable.
// ────────────────────────────────────────────────────────────────────────────

console.log("");
console.log("commands: latency");

// The latency function, not a stopwatch: executeVehicleCommand awaits exactly
// what this returns, so proving the function's bounds over a spread of seeds
// proves the layer's bounds without ever sleeping for real.
{
	let inBounds = true;
	let low = Infinity;
	let high = -Infinity;
	for (let i = 0; i < 500; i++) {
		const ms = commandLatencyMs(`VIN${i}:setDoorLock:${i * 7}`);
		if (ms < 600 || ms >= 900) inBounds = false;
		low = Math.min(low, ms);
		high = Math.max(high, ms);
	}
	check("commandLatencyMs stays within 600–900 ms across 500 seeds", inBounds, `spread ${low}–${high} ms`);
	check("commandLatencyMs actually varies", high - low > 100, `spread ${high - low} ms`);
	check(
		"commandLatencyMs is deterministic per seed",
		commandLatencyMs("seed:a:1") === commandLatencyMs("seed:a:1")
	);
}

console.log("");
console.log("commands: state-derived rejections");

const sim2 = new FleetSimulator(T0);
const mover2 = sim2.getVehicles().find((v) => v.personality === "driving")!;
const charger2 = sim2.getVehicles().find((v) => v.personality === "charging")!;
const sleeper2 = sim2.getVehicles().find((v) => v.personality === "asleep")!;
const faulty2 = sim2.getVehicles().find((v) => v.personality === "faulted")!;
const idleNa2 = sim2.getVehicles().find((v) => v.personality === "idle" && v.cohort === "North America")!;

// Test seams: capture the delay instead of waiting it out, and pin the
// spurious-UNREACHABLE dice so rejections stay state-derived here.
const requestedDelays: number[] = [];
const instant = (ms: number): Promise<void> => {
	requestedDelays.push(ms);
	return Promise.resolve();
};
const neverSpurious = () => 0.99;
const alwaysSpurious = () => 0.0;
const opts = { sleep: instant, random: neverSpurious };

const asleepResult = await executeVehicleCommand(sim2, sleeper2.vin, { kind: "setVehicleLocked", locked: true }, opts);
check("ASLEEP: any command against the sleeper", !asleepResult.ok && asleepResult.reason === "ASLEEP", JSON.stringify(asleepResult));

const motionResult = await executeVehicleCommand(sim2, mover2.vin, { kind: "setVehicleLocked", locked: true }, opts);
check(
	"IN_MOTION: locking the mover while it drives",
	!motionResult.ok && motionResult.reason === "IN_MOTION" && motionResult.detail.includes("km/h"),
	JSON.stringify(motionResult)
);

const doorOpenResult = await executeVehicleCommand(sim2, faulty2.vin, { kind: "setVehicleLocked", locked: true }, opts);
check(
	"DOOR_OPEN: locking the faulted one with its FL door ajar",
	!doorOpenResult.ok && doorOpenResult.reason === "DOOR_OPEN" && doorOpenResult.detail.includes("FL"),
	JSON.stringify(doorOpenResult)
);
check("DOOR_OPEN rejection left the faulted one unlocked", faulty2.locked === false);

const chargingResult = await executeVehicleCommand(sim2, charger2.vin, { kind: "unlatchChargePort" }, opts);
check(
	"CHARGING_IN_PROGRESS: unlatching a charging vehicle mid-session",
	!chargingResult.ok && chargingResult.reason === "CHARGING_IN_PROGRESS",
	JSON.stringify(chargingResult)
);
check("rejection left the charging vehicle plugged in", charger2.charge.pluggedIn === true);

// Unlocking a door with the vehicle parked is the clean success path — and
// success must actually mutate, or the layer is latency theatre.
const successResult = await executeVehicleCommand(
	sim2,
	idleNa2.vin,
	{ kind: "setDoorLock", door: "FL", locked: false },
	opts
);
check("success path resolves ok", successResult.ok === true, JSON.stringify(successResult));
check("success path mutated the door", idleNa2.doors.FL.locked === false && idleNa2.locked === false);

const spuriousResult = await executeVehicleCommand(
	sim2,
	idleNa2.vin,
	{ kind: "setDoorLock", door: "FL", locked: true },
	{ sleep: instant, random: alwaysSpurious }
);
check(
	"spurious UNREACHABLE fires on an otherwise-valid command",
	!spuriousResult.ok && spuriousResult.reason === "UNREACHABLE",
	JSON.stringify(spuriousResult)
);
check("spurious failure did NOT mutate", idleNa2.doors.FL.locked === false);

const unknownResult = await executeVehicleCommand(sim2, "NOSUCHVIN000000000", { kind: "unlatchChargePort" }, opts);
check("unknown VIN resolves UNREACHABLE", !unknownResult.ok && unknownResult.reason === "UNREACHABLE");

check(
	"every command waited a 600–900 ms latency",
	requestedDelays.length >= 6 && requestedDelays.every((ms) => ms >= 600 && ms < 900),
	`${requestedDelays.length} commands, ${Math.min(...requestedDelays)}–${Math.max(...requestedDelays)} ms`
);

// The policy alone, as a pure function — the property that makes rejections
// reproducible from visible state instead of dice.
check(
	"evaluateVehicleCommand is pure over the same state",
	JSON.stringify(evaluateVehicleCommand(mover2, { kind: "setVehicleLocked", locked: true })) ===
		JSON.stringify(evaluateVehicleCommand(mover2, { kind: "setVehicleLocked", locked: true }))
);

console.log("");
console.log("commands: wake and sleep");

check("wake transitions the sleeper asleep → online idler", sim2.wake(sleeper2.vin) === true && sleeper2.online && sleeper2.personality === "idle");
check("wake on an awake vehicle is a no-op", sim2.wake(sleeper2.vin) === false);
const awakeResult = await executeVehicleCommand(sim2, sleeper2.vin, { kind: "setVehicleLocked", locked: true }, opts);
check("commands succeed against the woken vehicle", awakeResult.ok === true);
check("sleep is wake's inverse", sim2.sleep(sleeper2.vin) === true && !sleeper2.online && sleeper2.personality === "asleep");
check("sleep refuses a moving vehicle", sim2.sleep(mover2.vin) === false);

console.log("");
console.log("ota: precondition evaluation across all personalities");

const moverOta = evaluateOtaPreconditions(mover2);
check(
	"driving: NOT_IN_PARK with the UDS shifter detail",
	moverOta?.reason === "NOT_IN_PARK" && moverOta.detail === "conditionsNotCorrect (0x22): shifterLeverNotInPark (0x90)",
	moverOta?.detail ?? "null"
);
const faultyOta = evaluateOtaPreconditions(faulty2);
check("faulted at 7% SoC: LOW_BATTERY", faultyOta?.reason === "LOW_BATTERY", faultyOta?.detail ?? "null");
check("asleep: ASLEEP", evaluateOtaPreconditions(sleeper2)?.reason === "ASLEEP");
check("charging in P is eligible", evaluateOtaPreconditions(charger2) === null);
check("idle is eligible", evaluateOtaPreconditions(idleNa2) === null);
check(
	"progress increments sum to exactly 100",
	OTA_STAGE_INCREMENTS.download + OTA_STAGE_INCREMENTS.verify + OTA_STAGE_INCREMENTS.flash + OTA_STAGE_INCREMENTS.reboot === 100
);
check("six named ECUs to flash", OTA_ECUS.length === 6, OTA_ECUS.join(", "));

console.log("");
console.log("ota: simulator transitions");

const ambientEvents: AmbientEvent[] = [];
sim2.onAmbientEvent((event) => ambientEvents.push(event));
const versionBefore = idleNa2.firmwareVersion;

check("beginOtaUpdate marks downloading", sim2.beginOtaUpdate(idleNa2.vin, OTA_TARGET_VERSION) === true && idleNa2.softwareUpdate.status === "downloading");
check("a second begin while in flight is refused", sim2.beginOtaUpdate(idleNa2.vin, OTA_TARGET_VERSION) === false);
sim2.setOtaProgress(idleNa2.vin, { downloadPerc: 62 });
check("download progress lands in the model", idleNa2.softwareUpdate.downloadPerc === 62);
const otaStateJson = JSON.parse(sim2.serializeState(idleNa2.vin)) as Record<string, any>;
check(
	"state.json mirrors the in-flight update",
	otaStateJson.vehicle_state.software_update.status === "downloading" &&
		otaStateJson.vehicle_state.software_update.download_perc === 62 &&
		otaStateJson.vehicle_state.software_update.version === OTA_TARGET_VERSION
);
sim2.setOtaProgress(idleNa2.vin, { status: "installing", installPerc: 40 });
check("progress flips downloading → installing", idleNa2.softwareUpdate.status === "installing" && idleNa2.softwareUpdate.installPerc === 40);
check(
	"completeOta bumps the version and resets the update block",
	sim2.completeOta(idleNa2.vin) === true &&
		idleNa2.firmwareVersion === OTA_TARGET_VERSION &&
		idleNa2.softwareUpdate.status === "" &&
		idleNa2.softwareUpdate.downloadPerc === 0,
	`${versionBefore} → ${idleNa2.firmwareVersion}`
);
check(
	"completeOta emitted the ota-complete ambient event",
	ambientEvents.some((e) => e.kind === "ota-complete" && e.vin === idleNa2.vin && e.message.includes(OTA_TARGET_VERSION)),
	ambientEvents.map((e) => e.kind).join(", ") || "none"
);

const idleStage2 = sim2.getVehicles().find((v) => v.personality === "idle" && v.cohort === "Stage")!;
const idleStageVersion = idleStage2.firmwareVersion;
sim2.beginOtaUpdate(idleStage2.vin, OTA_TARGET_VERSION);
sim2.setOtaProgress(idleStage2.vin, { downloadPerc: 30 });
check(
	"cancelOta restores idle without touching the installed version",
	sim2.cancelOta(idleStage2.vin) === true && idleStage2.firmwareVersion === idleStageVersion && idleStage2.softwareUpdate.status === "",
	idleStage2.firmwareVersion
);
check("begin against an asleep vehicle is refused", sim2.beginOtaUpdate(sleeper2.vin, OTA_TARGET_VERSION) === false);

console.log("");
console.log("sim: bus targeting");

sim2.drainFrames(10_000);
check("setBusTarget rejects unknown VINs", sim2.setBusTarget("NOSUCHVIN000000000") === false);
check("setBusTarget accepts a fleet VIN and flushes the ring", sim2.setBusTarget(sleeper2.vin) === true && sim2.bufferedFrameCount === 0);
let now2 = T0 + 60_000;
for (let i = 0; i < 8; i++) {
	now2 += 250;
	sim2.tick(now2);
}
check("an asleep bus target yields silence", sim2.bufferedFrameCount === 0, `${sim2.bufferedFrameCount} frames`);
sim2.setBusTarget(mover2.vin);
check("bus target resolves to the retargeted VIN", sim2.getBusTargetVin() === mover2.vin);
for (let i = 0; i < 8; i++) {
	now2 += 250;
	sim2.tick(now2);
}
check("retargeting to an online vehicle resumes traffic", sim2.bufferedFrameCount > 0, `${sim2.bufferedFrameCount} frames`);

console.log("");
console.log("can: annotation decoding");

// Exact round trip at a lattice point of the 0.08 factor: (100+40)/0.08 is a
// whole raw value, so encode→decode must reproduce 100.0 with no tolerance.
check(
	"DI_speed annotation decodes the encoded speed",
	decodeFrameAnnotation(encodeDiSpeed(T0, 100)) === "DI_speed  100.0 km/h",
	decodeFrameAnnotation(encodeDiSpeed(T0, 100))
);
check(
	"filler frames get no annotation",
	decodeFrameAnnotation({ timestamp: T0, id: 0x123, dlc: 8, data: [1, 2, 3, 4, 5, 6, 7, 8] }) === undefined
);

sim2.dispose();

// ────────────────────────────────────────────────────────────────────────────
// The DBC asset. `fleet:/fleet.dbc` is what "go to definition" jumps to and
// what hover cards quote, so its factors are not decoration: if they disagree
// with the encoders, the demo tells a reader one thing and puts another on the
// wire. Every check below decodes a frame produced by the REAL encoder using
// parameters parsed out of the REAL DBC text, so agreement is proved in the
// only direction that matters.
// ────────────────────────────────────────────────────────────────────────────

console.log("");
console.log("dbc: the file agrees with the encoders");

const dbc = parseDbcSignals();

check("FLEET_DBC has a VERSION header", FLEET_DBC.startsWith("VERSION "));
check("FLEET_DBC declares its nodes in a BU_ list", /^BU_: .*\bDI\b.*\bBMS\b/m.test(FLEET_DBC));

/** Decode a signal out of a frame using ONLY what the DBC text says. */
function decodeByDbc(canFrame: CanFrame, name: string): number {
	const signal = dbc.get(name)!;
	const raw = getBitsLE(canFrame.data, signal.startBit, signal.length);
	const value = signal.signed && raw >= 2 ** (signal.length - 1) ? raw - 2 ** signal.length : raw;
	return value * signal.factor + signal.offset;
}

// Every signal the CAN terminal annotates must be defined in the DBC — and
// nothing else, so the file cannot grow signals the simulator never emits.
const ENCODED_SIGNALS = [
	"DI_vehicleSpeed",
	"DI_torqueMotor",
	"DI_motorRPM",
	"DI_gear",
	"ESP_wheelSpeedFrL",
	"ESP_wheelSpeedFrR",
	"ESP_wheelSpeedReL",
	"ESP_wheelSpeedReR",
	"DOOR_STATE_FL",
	"DOOR_STATE_FR",
	"DOOR_STATE_RL",
	"DOOR_STATE_RR",
	"BMS_socUI"
];
const missingSignals = ENCODED_SIGNALS.filter((name) => !dbc.has(name));
check("DBC defines every signal the simulator encodes", missingSignals.length === 0, missingSignals.join(", ") || "none missing");
const extraSignals = [...dbc.keys()].filter((name) => !ENCODED_SIGNALS.includes(name));
check("DBC defines nothing the simulator does not encode", extraSignals.length === 0, extraSignals.join(", ") || "none extra");

// Arbitration ids: the BO_ the signal sits under must be the id the encoder
// actually stamps on the frame.
const ID_CASES: Array<[string, CanFrame]> = [
	["DI_vehicleSpeed", encodeDiSpeed(T0, 0)],
	["DI_torqueMotor", encodeDiTorque1(T0, 0, 0)],
	["DI_motorRPM", encodeDiTorque1(T0, 0, 0)],
	["DI_gear", encodeDiSystemStatus(T0, "P")],
	["ESP_wheelSpeedFrL", encodeWheelSpeeds(T0, [0, 0, 0, 0])],
	["BMS_socUI", encodeBmsSocUi(T0, 0)],
	["DOOR_STATE_FL", encodeGtwCarState(T0, seedFleet(T0)[0]!)]
];
const idMismatches = ID_CASES.filter(([name, canFrame]) => dbc.get(name)!.messageId !== canFrame.id);
check(
	"every BO_ id matches the id its encoder stamps",
	idMismatches.length === 0,
	idMismatches.map(([name, f]) => `${name}: dbc ${dbc.get(name)!.messageId} vs frame ${f.id}`).join("; ") || "7 signals checked"
);

// Byte order: every signal in this file is Intel (@1), because the simulator
// packs every frame through one pair of little-endian helpers. A future
// Motorola signal here would decode as garbage in the terminal.
check("every signal is Intel byte order (@1)", [...dbc.values()].every((s) => s.byteOrder === 1));
check(
	"only the torque and RPM signals are signed",
	[...dbc.values()].filter((s) => s.signed).map((s) => s.name).sort().join(",") === "DI_motorRPM,DI_torqueMotor",
	[...dbc.values()].filter((s) => s.signed).map((s) => s.name).join(",") || "none"
);

// Physical round-trips. Every input value below sits exactly on its signal's
// quantisation lattice, so these are exact-equality checks, not tolerances:
// 100 km/h is (100+40)/0.08 = 1750 raw; 125 Nm is 500 raw; 10 km/h is 250 raw
// at 0.04; 62.5% is 625 raw at 0.1.
check(
	"DI_vehicleSpeed decodes at the DBC's (0.08, −40)",
	decodeByDbc(encodeDiSpeed(T0, 100), "DI_vehicleSpeed") === 100,
	`${decodeByDbc(encodeDiSpeed(T0, 100), "DI_vehicleSpeed")}`
);
const torqueFrame = encodeDiTorque1(T0, 125, 8000);
check("DI_torqueMotor decodes at the DBC's 0.25 Nm/bit", decodeByDbc(torqueFrame, "DI_torqueMotor") === 125);
check("DI_motorRPM decodes at the DBC's 1 rpm/bit", decodeByDbc(torqueFrame, "DI_motorRPM") === 8000);
check(
	"DI_torqueMotor is signed at 13 bits (regen decodes negative)",
	decodeByDbc(encodeDiTorque1(T0, -80, -2000), "DI_torqueMotor") === -80 &&
		decodeByDbc(encodeDiTorque1(T0, -80, -2000), "DI_motorRPM") === -2000
);

const wheelFrame = encodeWheelSpeeds(T0, [10, 20, 30, 40]);
check(
	"all four ESP_wheelSpeed signals decode at 0.04 km/h/bit from their own start bits",
	decodeByDbc(wheelFrame, "ESP_wheelSpeedFrL") === 10 &&
		decodeByDbc(wheelFrame, "ESP_wheelSpeedFrR") === 20 &&
		decodeByDbc(wheelFrame, "ESP_wheelSpeedReL") === 30 &&
		decodeByDbc(wheelFrame, "ESP_wheelSpeedReR") === 40,
	[
		decodeByDbc(wheelFrame, "ESP_wheelSpeedFrL"),
		decodeByDbc(wheelFrame, "ESP_wheelSpeedFrR"),
		decodeByDbc(wheelFrame, "ESP_wheelSpeedReL"),
		decodeByDbc(wheelFrame, "ESP_wheelSpeedReR")
	].join(", ")
);
check("BMS_socUI decodes at 0.1 %/bit", decodeByDbc(encodeBmsSocUi(T0, 62.5), "BMS_socUI") === 62.5);
check("DI_gear decodes to the VAL_ table's D = 4", decodeByDbc(encodeDiSystemStatus(T0, "D"), "DI_gear") === 4);
check(
	"the VAL_ table names every gear the model has",
	["DI_GEAR_P", "DI_GEAR_R", "DI_GEAR_N", "DI_GEAR_D"].every((label) => FLEET_DBC.includes(`"${label}"`))
);

// The door fields are at irregular offsets in the real GTW_carState layout
// (RR at 29, not 30). Open exactly one door and check the DBC's start bits
// find it there and nowhere else — an off-by-one in either file fails this.
const ajar = seedFleet(T0)[0]!;
ajar.doors.RR.open = true;
const doorFrame = encodeGtwCarState(T0, ajar);
check(
	"DOOR_STATE_* start bits (12/14/22/29) isolate the open door",
	decodeByDbc(doorFrame, "DOOR_STATE_RR") === 1 &&
		decodeByDbc(doorFrame, "DOOR_STATE_FL") === 2 &&
		decodeByDbc(doorFrame, "DOOR_STATE_FR") === 2 &&
		decodeByDbc(doorFrame, "DOOR_STATE_RL") === 2,
	[
		decodeByDbc(doorFrame, "DOOR_STATE_FL"),
		decodeByDbc(doorFrame, "DOOR_STATE_FR"),
		decodeByDbc(doorFrame, "DOOR_STATE_RL"),
		decodeByDbc(doorFrame, "DOOR_STATE_RR")
	].join(", ")
);
check("DOOR_STATE_RR is documented as sitting at bit 29", dbc.get("DOOR_STATE_RR")!.startBit === 29);
check(
	"the convention-based BMS message carries a CM_ disclaimer",
	/^CM_ BO_ 658 "Not from the public Model 3 DBC/m.test(FLEET_DBC)
);

// Positions: the definition provider jumps to (line, column) computed here.
const speedSignal = dbc.get("DI_vehicleSpeed")!;
check(
	"parsed positions land on the signal name in the file",
	FLEET_DBC.split("\n")[speedSignal.line]!.slice(speedSignal.column, speedSignal.column + speedSignal.name.length) ===
		speedSignal.name,
	`line ${speedSignal.line}, col ${speedSignal.column}`
);

console.log("");
console.log("serialize: can_signals block");

const signalSim = new FleetSimulator(T0);
const signalMover = signalSim.getVehicles().find((v) => v.personality === "driving")!;
const signalFaulty = signalSim.getVehicles().find((v) => v.personality === "faulted")!;
const signalState = JSON.parse(signalSim.serializeState(signalMover.vin)) as Record<string, any>;

check(
	"state.json carries a can_signals block keyed by DBC signal name",
	ENCODED_SIGNALS.every((name) => signalState.can_signals?.[name] !== undefined),
	Object.keys(signalState.can_signals ?? {}).length + " keys"
);
check(
	"can_signals matches the snapshot the encoders produce",
	JSON.stringify(signalState.can_signals) === JSON.stringify(canSignalSnapshot(signalMover))
);
// The load-bearing property: the number in state.json is the number on the
// wire, quantised by the signal's own factor — not the model's raw float.
check(
	"can_signals.DI_vehicleSpeed equals the DBC decode of a live DI_speed frame",
	signalState.can_signals.DI_vehicleSpeed ===
		Number(decodeByDbc(encodeDiSpeed(T0, signalMover.speedKph), "DI_vehicleSpeed").toFixed(2)),
	`${signalState.can_signals.DI_vehicleSpeed} vs model ${signalMover.speedKph}`
);
check(
	"can_signals reports the derived powertrain values, not zeros",
	signalState.can_signals.DI_motorRPM === Math.round(motorRpmFor(signalMover)) &&
		Math.abs(signalState.can_signals.DI_torqueMotor - motorTorqueNmFor(signalMover)) <= 0.125,
	`${signalState.can_signals.DI_torqueMotor} Nm, ${signalState.can_signals.DI_motorRPM} rpm`
);
check(
	"enumerated signals report VAL_ labels",
	signalState.can_signals.DI_gear === "DI_GEAR_D" && signalState.can_signals.DOOR_STATE_FL === "CLOSED",
	`${signalState.can_signals.DI_gear} / ${signalState.can_signals.DOOR_STATE_FL}`
);

console.log("");
console.log("serialize: diagnostics anchors");

const faultyState = signalSim.serializeState(signalFaulty.vin);
const faultyDtcs = signalSim.serializeDtcs(signalFaulty.vin);
const faultyStateDoc = JSON.parse(faultyState) as Record<string, any>;

check("a faulted vehicle's state.json carries a diagnostics block", faultyStateDoc.diagnostics?.count === 5);
check("a healthy vehicle's state.json omits it entirely", signalState.diagnostics === undefined);
// This IS the diagnostics provider's search, run here: every code must be
// findable as a quoted string in BOTH files, or a Problems entry would have
// nowhere real to point.
const unanchored = signalFaulty.dtcs.filter(
	(dtc) => !faultyState.includes(`"${dtc.code}"`) || !faultyDtcs.includes(`"${dtc.code}"`)
);
check(
	"every DTC is findable as a quoted string in state.json and dtcs.json",
	unanchored.length === 0,
	unanchored.map((d) => d.code).join(", ") || "5 codes anchored in both files"
);
check(
	"each code appears exactly once per file (no ambiguous anchor)",
	signalFaulty.dtcs.every(
		(dtc) =>
			faultyState.split(`"${dtc.code}"`).length === 2 && faultyDtcs.split(`"${dtc.code}"`).length === 2
	)
);

signalSim.dispose();

console.log("");
console.log("decorations: badge rule and priority");

/**
 * VS Code counts badge length in grapheme clusters and DROPS the decoration
 * (throwing inside the extension host, where nobody sees it) when a badge is
 * longer than two. Segmenter where available, code points otherwise — the two
 * agree for every badge this module can emit, and disagreeing would itself be
 * worth knowing.
 */
const graphemeCount = (value: string): number =>
	typeof Intl !== "undefined" && "Segmenter" in Intl
		? [...new Intl.Segmenter().segment(value)].length
		: [...value].length;

const oversizedBadges = DECORATION_BADGES.filter((badge) => graphemeCount(badge) > 2);
check(
	"every badge is at most 2 grapheme clusters",
	oversizedBadges.length === 0,
	DECORATION_BADGES.map((b) => `${b}=${graphemeCount(b)}`).join(" ")
);

const decoFleet = seedFleet(T0);
const decoMover = decoFleet.find((v) => v.personality === "driving")!;
const decoCharger = decoFleet.find((v) => v.personality === "charging")!;
const decoSleeper = decoFleet.find((v) => v.personality === "asleep")!;
const decoFaulty = decoFleet.find((v) => v.personality === "faulted")!;

check("faulted → \"!\" with a DTC count tooltip", decorationFor(decoFaulty)?.badge === "!" && decorationFor(decoFaulty)?.tooltip === "5 DTCs", decorationFor(decoFaulty)?.tooltip);
check("charging → \"⚡\" with the live power", decorationFor(decoCharger)?.badge === "⚡" && decorationFor(decoCharger)!.tooltip.includes("kW"), decorationFor(decoCharger)?.tooltip);
check("asleep → \"zz\"", decorationFor(decoSleeper)?.badge === "zz");
check("an unremarkable vehicle gets no badge at all", decorationFor(decoMover) === undefined);

// Priority: the faulted vehicle is BOTH faulted and at 7% SoC. One badge fits, and it must
// be the fault — the ordering in status.ts is the entire design.
check("faulted outranks low SoC on the same vehicle", decoFaulty.charge.soc < 20 && decorationFor(decoFaulty)!.badge === "!", `${decoFaulty.charge.soc}% SoC`);
const lowOnly = decoFleet.find((v) => v.personality === "idle" && v.cohort === "Stage")!;
lowOnly.charge.soc = 11;
check("low SoC alone → \"%\" with the rounded charge", decorationFor(lowOnly)?.badge === "%" && decorationFor(lowOnly)?.tooltip === "Charge 11%", decorationFor(lowOnly)?.tooltip);
const chargingAndLow = decoFleet.find((v) => v.personality === "idle" && v.cohort === "North America")!;
chargingAndLow.charge.soc = 9;
chargingAndLow.charge.charging = true;
chargingAndLow.charge.powerKw = 122;
check("charging outranks low SoC (it is already being fixed)", decorationFor(chargingAndLow)?.badge === "⚡", decorationFor(chargingAndLow)?.tooltip);

// Every colour is referenced by id so the provider can wrap it in a
// ThemeColor; a typo'd id renders as the default foreground and nothing
// complains, so pin the four.
check(
	"each rule names its ThemeColor id",
	decorationFor(decoFaulty)?.colorId === "list.errorForeground" &&
		decorationFor(decoCharger)?.colorId === "charts.blue" &&
		decorationFor(lowOnly)?.colorId === "list.warningForeground" &&
		decorationFor(decoSleeper)?.colorId === "list.deemphasizedForeground"
);

console.log("");
console.log("diagnostics: DTC severity tiers");

check("P0A80 (replace the pack) is an Error", dtcSeverity("P0A80") === "error");
check("P0562 (12V low) is a Warning", dtcSeverity("P0562") === "warning");
check("U0100 (ECM off the bus) is a Warning", dtcSeverity("U0100") === "warning");
check("P0A7D and P0A7E are Information", dtcSeverity("P0A7D") === "information" && dtcSeverity("P0A7E") === "information");
check("an unrecognised code degrades to Information, not a crash", dtcSeverity("P1234") === "information");
check(
	"every seeded DTC maps to a known tier",
	decoFaulty.dtcs.every((dtc) => ["error", "warning", "information"].includes(dtcSeverity(dtc.code))),
	decoFaulty.dtcs.map((d) => `${d.code}=${dtcSeverity(d.code)}`).join(" ")
);

console.log("");
console.log("hover: the DBC signal table survives its own pipes");

// A DBC layout string is `startBit|length@byteOrder±`, and markdown splits
// table rows on `|` before it parses code spans — so an unescaped layout cell
// renders as "`12" and silently shifts every column after it. This is the
// regression that shipped once.
check("escapeTableCell backslash-escapes every pipe", escapeTableCell("12|12@1+") === "12\\|12@1+", escapeTableCell("12|12@1+"));
check("escapeTableCell leaves pipe-free values alone", escapeTableCell("km/h") === "km/h");
check("escapeTableCell accepts numbers", escapeTableCell(0.05) === "0.05");

const hoverSignals = parseDbcSignals();
const hoverSignal = hoverSignals.get("DI_vehicleSpeed") ?? [...hoverSignals.values()][0]!;
const hoverMarkdown = describeSignalMarkdown(hoverSignal);
const hoverLayout = `${hoverSignal.startBit}|${hoverSignal.length}@${hoverSignal.byteOrder}${hoverSignal.signed ? "-" : "+"}`;

check(
	"the layout cell carries the whole DBC layout string, escaped",
	hoverMarkdown.includes(`| layout | \`${escapeTableCell(hoverLayout)}\` |`),
	hoverLayout
);

// The structural assertion behind the cosmetic one: every table row must have
// exactly two cells once the escaped pipes are removed from consideration.
const hoverRows = hoverMarkdown
	.split("\n")
	.filter((line) => line.startsWith("|") && !line.startsWith("|---"));
const misshapenRows = hoverRows.filter((line) => line.replace(/\\\|/g, "").split("|").length !== 4);
check(
	"every hover row is exactly two columns wide",
	misshapenRows.length === 0,
	misshapenRows.join(" / ") || `${hoverRows.length} rows checked`
);

// Escaping is applied at every interpolation, not just the layout cell: a
// signal whose unit or name grew a pipe must not be able to break the table
// either.
const hostileSignal = { ...hoverSignal, name: "A|B", unit: "N|m" };
const hostileRows = describeSignalMarkdown(hostileSignal)
	.split("\n")
	.filter((line) => line.startsWith("|") && !line.startsWith("|---"));
check(
	"a pipe in any cell value stays inside its cell",
	hostileRows.every((line) => line.replace(/\\\|/g, "").split("|").length === 4),
	hostileRows.join(" / ")
);

console.log("");
if (failures > 0) {
	console.log(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("all checks passed");
