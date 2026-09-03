import * as vscode from "vscode";
import type { FleetSimulator } from "../sim/clock";
import { decorationFor } from "../model/status";

/**
 * Badges on `fleet:` resources — the tree rows (which set
 * `resourceUri = fleet:/<VIN>`) and any open `fleet:` editor tabs.
 *
 * The rules themselves live in `model/status.ts`, host-free, so the selftest
 * can enforce the badge-length constraint that VS Code enforces silently. All
 * this file does is adapt them: `colorId` → `ThemeColor`, and the change
 * plumbing.
 *
 * Two things about that plumbing are easy to get wrong and worth stating:
 *
 *   1. Decoration changes do NOT propagate to parents. Firing the event for
 *      `fleet:/<VIN>/dtcs.json` alone leaves the collapsed `fleet:/<VIN>` row
 *      — the one the tree actually shows — painted with the previous badge
 *      forever. So every fire names the directory AND its files.
 *   2. The refresh is throttled to ~1 Hz, matching the tree. The simulator
 *      ticks 4×/sec; asking VS Code to re-decorate every row four times a
 *      second makes the badge column visibly strobe next to a tree that is
 *      calmly updating once a second, and the mismatch is more distracting
 *      than either rate alone.
 */

/** Coalescing window for decoration refreshes; matches the tree's. */
const REFRESH_THROTTLE_MS = 1000;

/** Files that exist under a vehicle directory — see the FS provider. */
const VEHICLE_FILES = ["state.json", "dtcs.json", "controls.vehicle"];

export class FleetDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri[]>();
	readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri[]> = this.changeEmitter.event;

	private readonly subscription: { dispose(): void };
	/** VINs touched since the last fire, coalesced by the throttle below. */
	private readonly pending = new Set<string>();
	private throttleHandle: unknown = null;
	private disposed = false;

	constructor(private readonly simulator: FleetSimulator) {
		this.subscription = simulator.onVehicleChanged((vin) => {
			this.pending.add(vin);
			this.scheduleRefresh();
		});
	}

	dispose(): void {
		this.disposed = true;
		this.subscription.dispose();
		if (this.throttleHandle !== null) {
			clearTimeout(this.throttleHandle);
			this.throttleHandle = null;
		}
		this.changeEmitter.dispose();
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== "fleet") return undefined;

		// The VIN is the first path segment, whether the URI names the vehicle
		// directory or a file inside it: a badged `state.json` tab and a badged
		// tree row are the same vehicle's status, told twice.
		const vin = uri.path.split("/").filter((segment) => segment.length > 0)[0];
		if (vin === undefined) return undefined;

		const vehicle = this.simulator.getVehicle(vin);
		if (!vehicle) return undefined;

		const decoration = decorationFor(vehicle);
		if (!decoration) return undefined;

		return {
			badge: decoration.badge,
			tooltip: decoration.tooltip,
			color: new vscode.ThemeColor(decoration.colorId)
			// `propagate` is left off deliberately: the fleet root has no badge
			// of its own to inherit one, and propagation would paint the
			// workspace root with whichever vehicle happened to change last.
		};
	}

	/** Trailing-edge throttle, matching FleetTreeProvider's. */
	private scheduleRefresh(): void {
		if (this.disposed || this.throttleHandle !== null) return;
		this.throttleHandle = setTimeout(() => {
			this.throttleHandle = null;
			if (this.disposed || this.pending.size === 0) return;

			const uris: vscode.Uri[] = [];
			for (const vin of this.pending) {
				uris.push(vscode.Uri.parse(`fleet:/${vin}`));
				for (const file of VEHICLE_FILES) {
					uris.push(vscode.Uri.parse(`fleet:/${vin}/${file}`));
				}
			}
			this.pending.clear();
			this.changeEmitter.fire(uris);
		}, REFRESH_THROTTLE_MS);
	}
}
