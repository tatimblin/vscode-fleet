import * as vscode from "vscode";
import type { FleetSimulator } from "../sim/clock";
import type { Vehicle } from "../model/types";
import { FLEET_DBC } from "../sim/dbcText";

/**
 * The `fleet:` file system — the simulator's state, dressed as files.
 *
 * Layout:
 *
 *   fleet:/
 *     fleet.dbc            the CAN database (readonly, static)
 *     <VIN>/
 *       state.json         full vehicle state (readonly)
 *       dtcs.json          stored trouble codes (readonly; only on vehicles
 *                          that carry codes — see serialize.ts for why)
 *       controls.vehicle   zero-byte marker the custom controls editor binds
 *
 * Why a FileSystemProvider at all, when a webview could show the same data:
 * files get VS Code's entire machinery for free — diffing, search, "Open to
 * the Side", keybindings, the JSON language service colouring `state.json` —
 * and that machinery working on fake vehicles is the demo's whole thesis.
 *
 * Everything is readonly at this layer. Mutations flow through the simulator
 * API (commands, the controls editor) and re-emerge here as change events;
 * letting a text edit to `state.json` write back would mean parsing arbitrary
 * user JSON into the model, and a typo'd edit corrupting the simulation is a
 * failure mode this demo does not need. `FilePermission.Readonly` also makes
 * VS Code render the padlock and refuse edits in the UI itself, which is
 * better signposting than a save-time error.
 */

/** UTF-8 encoder, shared: readFile is called on every editor refresh. */
const encoder = new TextEncoder();

/** The DBC's bytes, encoded once — the text is a module constant. */
const dbcBytes = encoder.encode(FLEET_DBC);

/** Marker filename the custom editor's selector binds to (see package.json). */
const CONTROLS_FILE = "controls.vehicle";
const STATE_FILE = "state.json";
const DTCS_FILE = "dtcs.json";

/**
 * The one file that lives at the ROOT rather than inside a vehicle directory:
 * the CAN database every vehicle's bus is described by. It belongs at the root
 * because it is fleet-wide — six copies of an identical DBC, one per VIN,
 * would imply the vehicles speak different dialects.
 *
 * Its bytes are computed once and its mtime is a constant, because the content
 * genuinely never changes. That is the one case where a fixed mtime is safe:
 * the monotonic-mtime rule in clock.ts exists so an editor re-reads changed
 * content, and content that cannot change has nothing to re-read.
 */
const DBC_FILE = "fleet.dbc";
const DBC_MTIME = 0;

export class FleetFsProvider implements vscode.FileSystemProvider {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.changeEmitter.event;

	private readonly subscriptions: { dispose(): void }[] = [];

	/**
	 * DTC fingerprints from the last change notification, keyed by VIN. The
	 * simulator fires one coarse "vehicle changed" event; `state.json` always
	 * changed when it fires, but `dtcs.json` only changed if the codes did, and
	 * telling VS Code a file changed when it did not forces a pointless re-read
	 * of every open diagnostics tab four times a second.
	 */
	private readonly dtcFingerprints = new Map<string, string>();

	constructor(private readonly simulator: FleetSimulator) {
		for (const vehicle of simulator.getVehicles()) {
			this.dtcFingerprints.set(vehicle.vin, fingerprintDtcs(vehicle));
		}

		this.subscriptions.push(
			simulator.onVehicleChanged((vin) => {
				const vehicle = simulator.getVehicle(vin);
				if (!vehicle) return;

				const events: vscode.FileChangeEvent[] = [
					{ type: vscode.FileChangeType.Changed, uri: vscode.Uri.parse(`fleet:/${vin}/${STATE_FILE}`) }
				];

				const fingerprint = fingerprintDtcs(vehicle);
				if (fingerprint !== this.dtcFingerprints.get(vin)) {
					this.dtcFingerprints.set(vin, fingerprint);
					events.push({
						type: vscode.FileChangeType.Changed,
						uri: vscode.Uri.parse(`fleet:/${vin}/${DTCS_FILE}`)
					});
				}

				this.changeEmitter.fire(events);
			})
		);
	}

	dispose(): void {
		for (const subscription of this.subscriptions) subscription.dispose();
		this.changeEmitter.dispose();
	}

	// ── Reads ──────────────────────────────────────────────────────────────────

	stat(uri: vscode.Uri): vscode.FileStat {
		const { vin, file } = this.parse(uri);

		if (vin === undefined) {
			// fleet:/fleet.dbc — the only file at the root.
			if (file === DBC_FILE) {
				return {
					type: vscode.FileType.File,
					ctime: 0,
					mtime: DBC_MTIME,
					size: dbcBytes.byteLength,
					permissions: vscode.FilePermission.Readonly
				};
			}

			// fleet:/ — the root directory.
			return {
				type: vscode.FileType.Directory,
				ctime: 0,
				mtime: this.newestMtime(),
				size: 0
			};
		}

		const vehicle = this.requireVehicle(uri, vin);
		const mtime = this.simulator.mtimeOf(vin);

		// fleet:/<VIN> — a vehicle directory.
		if (file === undefined) {
			return { type: vscode.FileType.Directory, ctime: 0, mtime, size: 0 };
		}

		const content = this.contentFor(uri, vehicle, file);
		return {
			type: vscode.FileType.File,
			ctime: 0,
			// The vehicle's monotonic counter, mapped to an advancing epoch by the
			// simulator. This MUST strictly advance on every content change: the
			// editor compares mtimes to decide whether to re-read, and an mtime
			// that repeats pins stale bytes on screen forever.
			mtime,
			size: content.byteLength,
			permissions: vscode.FilePermission.Readonly
		};
	}

	readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
		const { vin, file } = this.parse(uri);

		if (vin === undefined) {
			if (file === DBC_FILE) {
				throw vscode.FileSystemError.FileNotADirectory(uri);
			}
			const entries: [string, vscode.FileType][] = this.simulator
				.getVehicles()
				.map((v) => [v.vin, vscode.FileType.Directory]);
			entries.push([DBC_FILE, vscode.FileType.File]);
			return entries;
		}

		if (file !== undefined) {
			throw vscode.FileSystemError.FileNotADirectory(uri);
		}

		const vehicle = this.requireVehicle(uri, vin);
		const entries: [string, vscode.FileType][] = [
			[STATE_FILE, vscode.FileType.File],
			[CONTROLS_FILE, vscode.FileType.File]
		];
		// dtcs.json exists only where there are codes to read.
		if (vehicle.dtcs.length > 0) {
			entries.splice(1, 0, [DTCS_FILE, vscode.FileType.File]);
		}
		return entries;
	}

	readFile(uri: vscode.Uri): Uint8Array {
		const { vin, file } = this.parse(uri);
		if (vin === undefined) {
			if (file === DBC_FILE) return dbcBytes;
			throw vscode.FileSystemError.FileIsADirectory(uri);
		}
		if (file === undefined) {
			throw vscode.FileSystemError.FileIsADirectory(uri);
		}
		const vehicle = this.requireVehicle(uri, vin);
		return this.contentFor(uri, vehicle, file);
	}

	/**
	 * No-op by contract: change notification is push-based from the simulator,
	 * so there is nothing to start or stop per-watch. VS Code still requires a
	 * Disposable back.
	 */
	watch(): vscode.Disposable {
		return new vscode.Disposable(() => {});
	}

	// ── Writes: uniformly refused ──────────────────────────────────────────────
	// NoPermissions (not a raw Error): raw errors surface as "Unknown error"
	// toasts, while FileSystemError maps to the proper "not permitted" UX and
	// lets callers like the explorer grey out the operation.

	createDirectory(uri: vscode.Uri): never {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	writeFile(uri: vscode.Uri): never {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	delete(uri: vscode.Uri): never {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	rename(uri: vscode.Uri): never {
		throw vscode.FileSystemError.NoPermissions(uri);
	}

	// ── Internals ──────────────────────────────────────────────────────────────

	/**
	 * Split fleet:/<VIN>/<file> into its segments (either may be absent).
	 *
	 * `fleet:/fleet.dbc` is the one shape that breaks the pattern: a single
	 * segment that names a FILE rather than a vehicle directory. It comes back
	 * as `{ file }` with no `vin`, so every caller's existing
	 * `vin === undefined` branch — the one that used to mean "the root" — is
	 * the single place that has to tell the two apart.
	 */
	private parse(uri: vscode.Uri): { vin?: string; file?: string } {
		const segments = uri.path.split("/").filter((s) => s.length > 0);
		if (segments.length > 2) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		if (segments.length === 1 && segments[0] === DBC_FILE) {
			return { file: DBC_FILE };
		}
		return { vin: segments[0], file: segments[1] };
	}

	private requireVehicle(uri: vscode.Uri, vin: string): Vehicle {
		const vehicle = this.simulator.getVehicle(vin);
		if (!vehicle) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		return vehicle;
	}

	private contentFor(uri: vscode.Uri, vehicle: Vehicle, file: string): Uint8Array {
		switch (file) {
			case STATE_FILE:
				return encoder.encode(this.simulator.serializeState(vehicle.vin));
			case DTCS_FILE:
				if (vehicle.dtcs.length === 0) {
					throw vscode.FileSystemError.FileNotFound(uri);
				}
				return encoder.encode(this.simulator.serializeDtcs(vehicle.vin));
			case CONTROLS_FILE:
				// Zero bytes on purpose: the file is an address for the custom
				// editor to bind to, not a document. Giving it content would invite
				// the text editor to open it via "Open With…" and show garbage.
				return new Uint8Array(0);
			default:
				throw vscode.FileSystemError.FileNotFound(uri);
		}
	}

	private newestMtime(): number {
		let newest = 0;
		for (const vehicle of this.simulator.getVehicles()) {
			newest = Math.max(newest, this.simulator.mtimeOf(vehicle.vin));
		}
		return newest;
	}
}

/** Cheap identity of a vehicle's DTC list, for change detection. */
function fingerprintDtcs(vehicle: Vehicle): string {
	return vehicle.dtcs.map((d) => `${d.code}:${d.status}:${d.timestamp}`).join("|");
}
