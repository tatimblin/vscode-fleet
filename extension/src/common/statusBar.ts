import * as vscode from "vscode";
import type { FleetSimulator } from "./sim/clock";
import { describeVehicle } from "./model/status";
import { vinTail } from "./model/vin";

/**
 * The always-visible fleet summary: `⚡ 5/6 online`, bottom-left, clickable
 * straight into the vehicle switcher.
 *
 * Its job is to be the one piece of the demo that stays on screen when every
 * panel is closed. Someone who has collapsed the sidebar to read code still
 * has a live fleet in the corner of the window, and clicking it is one step
 * from any vehicle — which is exactly the affordance a real fleet console's
 * status bar earns.
 *
 * Throttled to 1 Hz for the same reason as the tree and the decorations: the
 * simulator ticks 4×/sec, and a status bar item whose text is reassigned that
 * often flickers in the corner of the eye even when the *rendered* string is
 * identical.
 */

/** Coalescing window for status refreshes; matches the tree's. */
const REFRESH_THROTTLE_MS = 1000;

export class FleetStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private readonly subscription: { dispose(): void };
	private throttleHandle: unknown = null;
	private disposed = false;

	constructor(private readonly simulator: FleetSimulator) {
		// The id argument matters: it is what lets a user hide this specific
		// item from the status bar's context menu and have the choice persist.
		// The anonymous overload gives an item nobody can turn off.
		this.item = vscode.window.createStatusBarItem(
			"fleet.status",
			vscode.StatusBarAlignment.Left,
			100
		);
		// Shown in the "Hide/Show" context menu, so the entry there reads
		// "Fleet Status" rather than the raw item text of the moment.
		this.item.name = "Fleet Status";
		this.item.command = "fleet.switchVehicle";

		this.render();
		this.item.show();

		this.subscription = simulator.onVehicleChanged(() => this.scheduleRefresh());
	}

	dispose(): void {
		this.disposed = true;
		this.subscription.dispose();
		if (this.throttleHandle !== null) {
			clearTimeout(this.throttleHandle);
			this.throttleHandle = null;
		}
		this.item.dispose();
	}

	private render(): void {
		const vehicles = this.simulator.getVehicles();
		const online = vehicles.filter((vehicle) => vehicle.online).length;
		const faulted = vehicles.filter((vehicle) => vehicle.dtcs.length > 0).length;

		this.item.text = `$(pulse) ${online}/${vehicles.length} online`;

		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown("**Fleet**\n\n");
		for (const vehicle of vehicles) {
			// VIN tail, not the full 17 — a tooltip is a compact surface, and six
			// stacked VINs read as a wall of noise nobody scans.
			tooltip.appendMarkdown(`${vinTail(vehicle.vin)} — ${describeVehicle(vehicle)}\n\n`);
		}
		tooltip.appendMarkdown("_Click to switch vehicle._");
		this.item.tooltip = tooltip;

		// Only `statusBarItem.errorBackground` and `.warningBackground` are
		// honoured — VS Code ignores any other ThemeColor here, so a stored
		// fault gets the warning wash and everything else gets none. Error
		// background is left unused on purpose: it paints the whole corner red,
		// which is the right volume for "the extension is broken", not for "one
		// of six vehicles needs a battery pack".
		this.item.backgroundColor =
			faulted > 0 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
	}

	/** Trailing-edge throttle, matching FleetTreeProvider's. */
	private scheduleRefresh(): void {
		if (this.disposed || this.throttleHandle !== null) return;
		this.throttleHandle = setTimeout(() => {
			this.throttleHandle = null;
			if (!this.disposed) this.render();
		}, REFRESH_THROTTLE_MS);
	}
}
