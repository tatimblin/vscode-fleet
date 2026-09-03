import { seedFleet } from "../model/fleet";
import type { CanFrame, DoorId, Vehicle } from "../model/types";
import { vinTail } from "../model/vin";
import { generateBusTraffic } from "./can";
import { serializeDtcs, serializeVehicleState } from "./serialize";
import { Emitter } from "./emitter";
import type { Disposable, Listener } from "./emitter";

/**
 * The single clock behind the whole demo.
 *
 * ONE `FleetSimulator` instance owns the `Vehicle[]` and one ~250 ms interval
 * advances everything: physics, CAN traffic, ambient events. Every consumer —
 * tree view, file system, controls webview, (next unit) CAN terminal — reads
 * from this instance and subscribes to its events.
 *
 * Why exactly one clock, enforced this hard: the moment two components each
 * run their own timer over their own copy of the state, the demo develops the
 * tell that kills mock UIs — the tree says 87% while the open editor says 86%
 * and `state.json` says something else again. Divergence is not a risk to
 * mitigate; with one owner and one tick it is structurally impossible. It also
 * means suspending the demo is `dispose()` on one object, not a hunt for stray
 * intervals that keep a Web Worker warm.
 *
 * NO `vscode` import here, transitively or otherwise. The Bun selftest
 * constructs this class directly and drives `tick()` by hand; see emitter.ts
 * for why that property must hold. Anything vscode-flavoured (URIs, FileSystem
 * events, TreeItems) belongs in `src/common/providers/`, which *adapts* these
 * events, never replaces them.
 */

/** Something noteworthy but non-critical happened; the UI may toast it. */
export interface AmbientEvent {
	kind: "charge-complete" | "blip" | "ota-complete";
	vin: string;
	message: string;
}

/**
 * How many frames the ring buffer retains. At the simulated ~1,200 frames/sec
 * this is roughly 3.5 s of bus history — enough that the next unit's terminal
 * never starves between drains, small enough that a terminal nobody opens
 * costs a few hundred KB, not unbounded growth for the life of the window.
 */
const FRAME_BUFFER_CAP = 4096;

/** Simulated bus rate, frames per second. Real buses run far higher; this is
 * the highest rate a scrolling terminal at ~10 displayed lines/sec can imply
 * without the drain arithmetic in the next unit needing to skip thousands. */
const BUS_FRAMES_PER_SECOND = 1200;

/** Wall-clock tick period when the interval is running. */
export const TICK_MS = 250;

export class FleetSimulator {
	private vehicles: Vehicle[];

	/**
	 * Monotonic per-VIN version counters, and the epoch they map onto.
	 *
	 * The FS provider derives each file's `mtime` from these, and VS Code uses
	 * mtime (not content) to decide whether an open editor needs re-reading: if
	 * two different contents ever share an mtime, the editor keeps showing the
	 * first one and the demo looks frozen. So: bumped on EVERY mutation, never
	 * reset (see `reset()`), and mapped to `epochBase + version` ms so the
	 * number also reads as a believable, always-advancing timestamp.
	 */
	private versions = new Map<string, number>();
	private readonly epochBase: number;

	/** Drop-oldest ring buffer of simulated bus traffic; see `drainFrames`. */
	private frames: CanFrame[] = [];

	/**
	 * VIN whose bus the frame buffer simulates; null = the seeded driving
	 * vehicle (the default that made sense before `fleet.openCanStream` could
	 * ask for anyone else). See `setBusTarget`.
	 */
	private busTargetVin: string | null = null;

	private lastTickMs: number;
	private intervalHandle: unknown = null;
	private disposed = false;

	/** Phase accumulator for the driving vehicle's speed oscillation. */
	private drivePhase = 0;

	private readonly vehicleChangedEmitter = new Emitter<string>();
	private readonly ambientEmitter = new Emitter<AmbientEvent>();

	/** Fires with a VIN whenever that vehicle's observable state mutated. */
	readonly onVehicleChanged: (listener: Listener<string>) => Disposable = this.vehicleChangedEmitter.event;

	/** Fires sparingly — charge completions, idle blips. Toast material. */
	readonly onAmbientEvent: (listener: Listener<AmbientEvent>) => Disposable = this.ambientEmitter.event;

	constructor(now: number = Date.now()) {
		this.vehicles = seedFleet(now);
		this.epochBase = now;
		this.lastTickMs = now;
		for (const vehicle of this.vehicles) {
			this.versions.set(vehicle.vin, 1);
		}
	}

	// ── Reading ────────────────────────────────────────────────────────────────

	getVehicles(): readonly Vehicle[] {
		return this.vehicles;
	}

	getVehicle(vin: string): Vehicle | undefined {
		return this.vehicles.find((v) => v.vin === vin);
	}

	/** Current version counter for a VIN; strictly increases across mutations. */
	versionOf(vin: string): number {
		return this.versions.get(vin) ?? 0;
	}

	/**
	 * The mtime the FS provider should report for this vehicle's files. Epoch
	 * milliseconds that strictly advance on every mutation — see `versions`.
	 */
	mtimeOf(vin: string): number {
		return this.epochBase + this.versionOf(vin);
	}

	serializeState(vin: string): string {
		const vehicle = this.requireVehicle(vin);
		return serializeVehicleState(vehicle);
	}

	serializeDtcs(vin: string): string {
		const vehicle = this.requireVehicle(vin);
		return serializeDtcs(vehicle);
	}

	/**
	 * Remove and return up to `max` of the OLDEST buffered frames. The next
	 * unit's terminal calls this on its render cadence; this unit only keeps
	 * the buffer alive and bounded so that opening the terminal later starts
	 * mid-stream instead of from silence.
	 */
	drainFrames(max: number): CanFrame[] {
		if (max <= 0) return [];
		return this.frames.splice(0, Math.min(max, this.frames.length));
	}

	/** Buffered frame count — exposed for the selftest's bounds assertions. */
	get bufferedFrameCount(): number {
		return this.frames.length;
	}

	// ── Mutating (commands / controls editor) ──────────────────────────────────

	/** Lock or unlock one door. No-op (returns false) for unknown VINs. */
	setDoorLock(vin: string, doorId: DoorId, locked: boolean): boolean {
		const vehicle = this.getVehicle(vin);
		if (!vehicle) return false;
		vehicle.doors[doorId].locked = locked;
		// The vehicle-level flag is the AND of the doors: that is what the tree
		// row and `state.json`'s `locked` field report.
		vehicle.locked = (Object.values(vehicle.doors) as { locked: boolean }[]).every((d) => d.locked);
		this.touch(vehicle);
		return true;
	}

	/** Lock or unlock every door on one vehicle. */
	setVehicleLocked(vin: string, locked: boolean): boolean {
		const vehicle = this.getVehicle(vin);
		if (!vehicle) return false;
		for (const door of Object.values(vehicle.doors)) {
			door.locked = locked;
		}
		vehicle.locked = locked;
		this.touch(vehicle);
		return true;
	}

	/**
	 * Wake an asleep vehicle: it comes back online as an idler. This is the
	 * *end* of the wake flow — the ~3 s "Waking…" theatre lives in the UI
	 * layer (commandUi.ts), because the simulator must stay synchronous and
	 * clock-driven; a sim that sleeps inside its own mutation would stall the
	 * tick for every other vehicle.
	 */
	wake(vin: string): boolean {
		const vehicle = this.getVehicle(vin);
		if (!vehicle || vehicle.online) return false;
		vehicle.online = true;
		vehicle.personality = "idle";
		this.touch(vehicle);
		return true;
	}

	/**
	 * Put an awake, parked vehicle back to sleep. Nothing calls this yet — it
	 * exists as `wake`'s inverse so the pair can be property-tested together
	 * and so a future idle-timeout feature has a real API to reach for.
	 */
	sleep(vin: string): boolean {
		const vehicle = this.getVehicle(vin);
		if (!vehicle || !vehicle.online || vehicle.speedKph > 0) return false;
		vehicle.online = false;
		vehicle.personality = "asleep";
		this.touch(vehicle);
		return true;
	}

	/**
	 * Release the charge-port latch (unplug). The command layer guards this
	 * with CHARGING_IN_PROGRESS — a latch that releases mid-session is how
	 * connectors get arc damage — so by the time this runs, `charging` is
	 * already false and the only mutation left is the cable coming off.
	 */
	unlatchChargePort(vin: string): boolean {
		const vehicle = this.getVehicle(vin);
		if (!vehicle || !vehicle.charge.pluggedIn) return false;
		vehicle.charge.pluggedIn = false;
		vehicle.charge.charging = false;
		vehicle.charge.powerKw = 0;
		this.touch(vehicle);
		return true;
	}

	// ── OTA transitions ────────────────────────────────────────────────────────
	//
	// Four small synchronous mutations rather than one long-running method: the
	// withProgress choreography (stage timing, cancellation tokens, byte-count
	// messages) lives in otaFlow.ts where vscode is allowed. The simulator only
	// records which phase the installer is in, so `state.json` — and anything
	// else reading the model — reflects the update as it happens.

	/** Start a campaign: status → downloading, target version recorded. */
	beginOtaUpdate(vin: string, targetVersion: string): boolean {
		const vehicle = this.getVehicle(vin);
		if (!vehicle || !vehicle.online || vehicle.softwareUpdate.status !== "") return false;
		vehicle.softwareUpdate = { status: "downloading", version: targetVersion, downloadPerc: 0, installPerc: 0 };
		this.touch(vehicle);
		return true;
	}

	/** Advance the in-flight campaign; also flips downloading → installing. */
	setOtaProgress(
		vin: string,
		progress: { status?: "downloading" | "installing"; downloadPerc?: number; installPerc?: number }
	): boolean {
		const vehicle = this.getVehicle(vin);
		if (!vehicle || vehicle.softwareUpdate.status === "") return false;
		if (progress.status !== undefined) vehicle.softwareUpdate.status = progress.status;
		if (progress.downloadPerc !== undefined) {
			vehicle.softwareUpdate.downloadPerc = Math.max(0, Math.min(100, progress.downloadPerc));
		}
		if (progress.installPerc !== undefined) {
			vehicle.softwareUpdate.installPerc = Math.max(0, Math.min(100, progress.installPerc));
		}
		this.touch(vehicle);
		return true;
	}

	/** Land the campaign: version bumped, update block back to idle, toast. */
	completeOta(vin: string): boolean {
		const vehicle = this.getVehicle(vin);
		if (!vehicle || vehicle.softwareUpdate.status === "") return false;
		const version = vehicle.softwareUpdate.version;
		vehicle.firmwareVersion = version;
		vehicle.softwareUpdate = { status: "", version: "", downloadPerc: 0, installPerc: 0 };
		this.touch(vehicle);
		this.ambientEmitter.fire({
			kind: "ota-complete",
			vin,
			message: `${vinTail(vin)} updated to ${version}`
		});
		return true;
	}

	/** Abandon the campaign: the installed version is untouched by design. */
	cancelOta(vin: string): boolean {
		const vehicle = this.getVehicle(vin);
		if (!vehicle || vehicle.softwareUpdate.status === "") return false;
		vehicle.softwareUpdate = { status: "", version: "", downloadPerc: 0, installPerc: 0 };
		this.touch(vehicle);
		return true;
	}

	// ── Bus targeting ──────────────────────────────────────────────────────────

	/**
	 * Point the simulated bus at a different vehicle. The buffer is flushed on
	 * retarget: frames already queued were encoded from the *previous*
	 * vehicle's state, and a terminal that opens on Beacon showing three
	 * seconds of Atlas's speed frames is a lie with a decoder-shaped audience.
	 */
	setBusTarget(vin: string): boolean {
		if (!this.getVehicle(vin)) return false;
		if (this.busTargetVin === vin) return true;
		this.busTargetVin = vin;
		this.frames = [];
		return true;
	}

	/** VIN the frame buffer currently simulates (after default resolution). */
	getBusTargetVin(): string | undefined {
		return this.resolveBusVehicle()?.vin;
	}

	/**
	 * Re-seed the fleet. Version counters deliberately survive: they only ever
	 * go up, because a reset that rewound them would rewind mtimes with them,
	 * and any editor holding a pre-reset `state.json` would compare mtimes,
	 * conclude nothing changed, and pin the stale bytes on screen — the exact
	 * failure the monotonic counter exists to prevent.
	 */
	reset(): void {
		this.vehicles = seedFleet();
		this.frames = [];
		this.busTargetVin = null;
		this.drivePhase = 0;
		for (const vehicle of this.vehicles) {
			this.bumpVersion(vehicle.vin);
		}
		for (const vehicle of this.vehicles) {
			this.vehicleChangedEmitter.fire(vehicle.vin);
		}
	}

	// ── The clock ──────────────────────────────────────────────────────────────

	/** Start the wall-clock interval. Idempotent. */
	start(): void {
		if (this.intervalHandle !== null || this.disposed) return;
		this.intervalHandle = setInterval(() => this.tick(), TICK_MS);
	}

	/**
	 * Advance the simulation once. Public and parameterised on `now` so the
	 * selftest can march virtual time forward deterministically without ever
	 * starting (or sleeping on) the real interval.
	 */
	tick(now: number = Date.now()): void {
		// Clamp dt: after a laptop lid-close the first tick back would otherwise
		// integrate hours of "driving" in one step and teleport the fleet.
		const dtMs = Math.min(Math.max(now - this.lastTickMs, 0), 2000);
		this.lastTickMs = now;
		const dt = dtMs / 1000;
		if (dt === 0) return;

		const changed = new Set<string>();

		for (const vehicle of this.vehicles) {
			switch (vehicle.personality) {
				case "driving":
					this.tickDriving(vehicle, dt, now);
					changed.add(vehicle.vin);
					break;
				case "charging":
					if (this.tickCharging(vehicle, dt, now)) changed.add(vehicle.vin);
					break;
				case "idle":
					if (this.tickIdle(vehicle, dt, now)) changed.add(vehicle.vin);
					break;
				// "asleep" and "faulted" hold still by design: an offline vehicle
				// whose odometer creeps, or a dead-packed one that keeps driving,
				// is the classic mock-data tell.
				case "asleep":
				case "faulted":
					break;
			}
		}

		this.generateFrames(dtMs, now);

		for (const vin of changed) {
			this.bumpVersion(vin);
		}
		for (const vin of changed) {
			this.vehicleChangedEmitter.fire(vin);
		}
	}

	dispose(): void {
		if (this.intervalHandle !== null) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = null;
		}
		this.disposed = true;
		this.vehicleChangedEmitter.dispose();
		this.ambientEmitter.dispose();
	}

	// ── Per-personality physics ────────────────────────────────────────────────

	/**
	 * Driving: speed oscillates in the 90–115 km/h band a real highway cruise
	 * occupies — a slow sinusoid (surrounding traffic) plus small jitter
	 * (cruise-control hunting) — and the GPS fix integrates that speed along
	 * the heading, which itself wanders a degree or two.
	 */
	private tickDriving(vehicle: Vehicle, dt: number, now: number): void {
		this.drivePhase += dt;
		const base = 102.5 + 10 * Math.sin(this.drivePhase / 9);
		const jitter = (Math.random() - 0.5) * 2;
		vehicle.speedKph = Math.min(115, Math.max(90, base + jitter));

		const distanceKm = (vehicle.speedKph * dt) / 3600;
		vehicle.odometerKm += distanceKm;
		vehicle.charge.soc = Math.max(0, vehicle.charge.soc - distanceKm * 0.16);
		vehicle.charge.rangeKm = Math.max(0, vehicle.charge.rangeKm - distanceKm * 1.05);

		vehicle.position.heading = (vehicle.position.heading + (Math.random() - 0.5) * 1.5 + 360) % 360;
		const headingRad = (vehicle.position.heading * Math.PI) / 180;
		// Equirectangular advance: 1° latitude ≈ 111.32 km; longitude scaled by
		// cos(lat). Exact great-circle math is overkill for metres per tick.
		vehicle.position.lat += (distanceKm * Math.cos(headingRad)) / 111.32;
		vehicle.position.lon +=
			(distanceKm * Math.sin(headingRad)) / (111.32 * Math.cos((vehicle.position.lat * Math.PI) / 180));

		vehicle.lastUpdated = now;
	}

	/**
	 * Charging: SoC climbs and the power tapers as the pack fills, the way a
	 * real DC session's charge curve bends. The rate is demo-timescale — about
	 * a quarter percent per second — so a viewer watching the gauge for ten
	 * seconds sees it move, which is the entire reason this vehicle exists.
	 */
	private tickCharging(vehicle: Vehicle, dt: number, now: number): boolean {
		if (!vehicle.charge.charging) return false;

		// Taper: linear falloff toward the 90% demo charge limit, floored at the
		// ~11 kW an AC session would hold. Recomputed from SoC each tick so the
		// power readout and the SoC gauge visibly move together.
		const limit = 90;
		const headroom = Math.max(0, limit - vehicle.charge.soc) / limit;
		vehicle.charge.powerKw = Math.max(11, Math.round(250 * headroom * 1.35));

		vehicle.charge.soc = Math.min(limit, vehicle.charge.soc + vehicle.charge.powerKw * dt * 0.0018);
		vehicle.charge.rangeKm = Math.round(vehicle.charge.soc * 4.96);
		vehicle.charge.batteryTempC = Math.min(42, vehicle.charge.batteryTempC + dt * 0.01);

		if (vehicle.charge.soc >= limit) {
			vehicle.charge.charging = false;
			vehicle.charge.powerKw = 0;
			this.ambientEmitter.fire({
				kind: "charge-complete",
				vin: vehicle.vin,
				message: `${vinTail(vehicle.vin)} finished charging at ${limit}%`
			});
		}

		vehicle.lastUpdated = now;
		return true;
	}

	/**
	 * Idle: mostly nothing — which is itself load-bearing, because a fleet
	 * where every row wiggles reads as randomly generated. Roughly once a
	 * minute an idler blips (climate cycles, a window vents a crack) so the
	 * quiet rows still prove they are alive.
	 */
	private tickIdle(vehicle: Vehicle, dt: number, now: number): boolean {
		// dt-scaled probability ≈ one blip per vehicle per ~75 s of wall time.
		if (Math.random() > dt / 75) return false;

		if (Math.random() < 0.5) {
			vehicle.climateOn = !vehicle.climateOn;
			this.ambientEmitter.fire({
				kind: "blip",
				vin: vehicle.vin,
				message: `${vinTail(vehicle.vin)}: climate ${vehicle.climateOn ? "on (cabin overheat protection)" : "off"}`
			});
		} else {
			const window = vehicle.windows.FL;
			window.position = window.position > 0 ? 0 : 8;
		}
		vehicle.lastUpdated = now;
		return true;
	}

	// ── Internals ──────────────────────────────────────────────────────────────

	/**
	 * The buffer simulates the bus of ONE vehicle — by default the seeded
	 * driving one, whose traffic is the most interesting stream; `setBusTarget`
	 * retargets it. An offline (asleep) target yields silence, which is also
	 * correct: no network, no frames.
	 */
	private resolveBusVehicle(): Vehicle | undefined {
		return (
			(this.busTargetVin !== null ? this.getVehicle(this.busTargetVin) : undefined) ??
			this.vehicles.find((v) => v.personality === "driving") ??
			this.vehicles[0]
		);
	}

	private generateFrames(dtMs: number, now: number): void {
		const bus = this.resolveBusVehicle();
		if (!bus || !bus.online) return;

		const count = Math.min(600, Math.round((BUS_FRAMES_PER_SECOND * dtMs) / 1000));
		if (count === 0) return;

		this.frames.push(...generateBusTraffic(bus, count, now - dtMs, now));

		// Drop-oldest: the reader (if any) wants the present, and an unread
		// buffer must cost O(cap), not O(uptime).
		const overflow = this.frames.length - FRAME_BUFFER_CAP;
		if (overflow > 0) {
			this.frames.splice(0, overflow);
		}
	}

	private touch(vehicle: Vehicle): void {
		vehicle.lastUpdated = Date.now();
		this.bumpVersion(vehicle.vin);
		this.vehicleChangedEmitter.fire(vehicle.vin);
	}

	private bumpVersion(vin: string): void {
		this.versions.set(vin, this.versionOf(vin) + 1);
	}

	private requireVehicle(vin: string): Vehicle {
		const vehicle = this.getVehicle(vin);
		if (!vehicle) {
			throw new Error(`Unknown VIN: ${vin}`);
		}
		return vehicle;
	}
}
