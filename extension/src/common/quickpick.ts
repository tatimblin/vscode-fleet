import * as vscode from "vscode";
import type { FleetSimulator } from "./sim/clock";
import type { FleetCohort, Vehicle } from "./model/types";
import type { CanStreamManager } from "./providers/canTerminal";
import { describeVehicle, iconFor } from "./model/status";
import { vinTail } from "./model/vin";

/**
 * `fleet.switchVehicle` — the palette-driven way into a vehicle, for people
 * who never open the sidebar.
 *
 * Built on `createQuickPick` rather than the one-liner `showQuickPick`,
 * because two of the things that make this feel like a real switcher are
 * simply not expressible in the convenience API:
 *
 *   - separators, so the cohorts are headings rather than a prefix repeated
 *     down the list;
 *   - per-item buttons, so a row can offer a *second* action — open the CAN
 *     stream for that vehicle — without leaving the picker or occupying a
 *     whole extra row.
 *
 * The cost is owning the lifecycle by hand: `onDidHide` must dispose, or the
 * picker leaks its event registrations every time the user presses Escape.
 */

/** A row that stands for a vehicle; separators carry no VIN. */
interface VehicleItem extends vscode.QuickPickItem {
	vin?: string;
}

/** The button attached to every vehicle row. */
const CAN_BUTTON: vscode.QuickInputButton = {
	iconPath: new vscode.ThemeIcon("pulse"),
	tooltip: "Open CAN stream"
};

export function showVehicleQuickPick(simulator: FleetSimulator, canStreams: CanStreamManager): void {
	const picker = vscode.window.createQuickPick<VehicleItem>();
	picker.title = "Switch vehicle";
	picker.placeholder = "VIN or model";
	// The description carries the live telemetry and the detail carries the
	// full VIN and model, so filtering must reach both: typing "Ultra", "VCF"
	// or "charging" should all narrow the list, and by default the picker matches
	// the label alone — which here is only the VIN's last six characters.
	picker.matchOnDescription = true;
	picker.matchOnDetail = true;
	picker.items = buildItems(simulator.getVehicles(), [CAN_BUTTON]);

	// Snapshot taken once, deliberately NOT refreshed on the simulator's tick:
	// reassigning `items` while a picker is open resets the active row and the
	// filter text, so a live-updating list would fight the user's typing. The
	// switcher is a moment, not a dashboard — the status bar is the thing that
	// stays current.

	picker.onDidTriggerItemButton((event) => {
		const vin = event.item.vin;
		picker.hide();
		if (vin) canStreams.open(vin);
	});

	picker.onDidAccept(() => {
		const vin = picker.selectedItems[0]?.vin;
		picker.hide();
		if (vin) {
			void vscode.commands.executeCommand("fleet.openControls", vin);
		}
	});

	picker.onDidHide(() => picker.dispose());
	picker.show();
}

/**
 * `fleet.openState`'s picker: the same listing, minus the per-row button (a
 * button with no `onDidTriggerItemButton` handler would render and do
 * nothing), resolved to a VIN. Shared with the switcher so both surfaces name
 * and group the fleet identically.
 */
export async function pickVehicleVin(
	simulator: FleetSimulator,
	options: { title: string; placeholder: string }
): Promise<string | undefined> {
	const choice = await vscode.window.showQuickPick(buildItems(simulator.getVehicles(), []), {
		title: options.title,
		placeHolder: options.placeholder,
		matchOnDescription: true,
		matchOnDetail: true
	});
	return choice?.vin;
}

/**
 * Group the fleet under COHORT separators — the same three headings, in the
 * same order, as the tree's directories.
 *
 * This used to group by "Online" / "Asleep", which had two problems the
 * cohorts fix. It was a second grouping vocabulary for the same six vehicles,
 * so the picker and the sidebar taught the user different mental models of
 * one fleet; and it was grouping by a LIVE field, so waking a vehicle made
 * its row jump headings mid-demo — and emptied a group, which is why the old
 * version needed the "skip a group with no members" rule at all. Cohort is a
 * static property, so the list's shape is now fixed and every group always
 * has members.
 *
 * Nothing is lost: online/asleep still reads off each row, twice, from the
 * `$(circle-slash)` glyph and the "asleep" description.
 */
function buildItems(vehicles: readonly Vehicle[], buttons: vscode.QuickInputButton[]): VehicleItem[] {
	const items: VehicleItem[] = [];
	const cohorts: readonly FleetCohort[] = ["Stage", "North America", "EMEA"];

	for (const cohort of cohorts) {
		const members = vehicles.filter((v) => v.cohort === cohort);
		if (members.length === 0) continue;
		items.push({ label: cohort, kind: vscode.QuickPickItemKind.Separator });
		for (const vehicle of members) {
			items.push({
				// The codicon renders inline in the label. Per-STATE rather than
				// a generic vehicle glyph — `$(car)` is not in @vscode/codicons
				// at all and renders as an empty box. The tree's rows are
				// deliberately neutral; this is the surface where comparing six
				// vehicles at once is the whole task, so the glyph earns its place.
				label: `$(${iconFor(vehicle)}) ${vinTail(vehicle.vin)}`,
				description: describeVehicle(vehicle),
				// Full VIN here rather than in the label: 17 characters crowd out
				// the description on a narrow picker, and the detail line is also
				// what `matchOnDetail` searches — so typing any part of a VIN,
				// not just its tail, still finds the vehicle.
				detail: `${vehicle.vin} · ${vehicle.year} ${vehicle.make} ${vehicle.model}`,
				buttons,
				vin: vehicle.vin
			});
		}
	}

	return items;
}
