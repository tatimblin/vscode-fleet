import * as vscode from "vscode";
import type { FleetSimulator } from "../sim/clock";
import type { FleetCohort, Vehicle } from "../model/types";

/**
 * The "Vehicles" tree (view id `fleetExplorer`): three cohort directories,
 * each holding its vehicles, each vehicle labelled with its full VIN.
 *
 * The sidebar is deliberately the QUIETEST surface in the extension. An
 * earlier version gave every row a callsign, a per-personality icon and a
 * live `62% · D · 103 km/h` description, and the result read as a toy — six
 * named pets, each shouting its telemetry, in a panel that is supposed to be
 * scannable at a glance while you work on something else. What survives here
 * is what a fleet operator actually needs from a list: which cohort a vehicle
 * is in, its VIN, and whether it is answering the phone. Everything richer
 * lives one click away (the controls editor), or in surfaces the user opened
 * *asking* for it (the switcher, the status bar tooltip).
 *
 * The state that still matters at a glance reaches the rows through
 * `FileDecorationProvider` badges (`!`, `⚡`, `%`, `zz`) keyed on each row's
 * `fleet:/<VIN>` resourceUri — which is VS Code's own vocabulary for exactly
 * this, subtle by construction, and costs no horizontal room.
 *
 * NOTE the tree is a *view*, not the storage layout: the fleet: file system
 * stays flat at `fleet:/<VIN>/…` regardless of cohort. The custom editor's
 * glob, the diagnostics anchors and the decorations all key on those URIs,
 * and folding a display grouping into them would couple the sidebar's shape
 * to every one of them.
 *
 * Refresh is THROTTLED, and that throttle is not an optimisation, it is
 * correctness of feel. The simulator ticks 4×/sec and the driving vehicle
 * changes on every tick; firing `onDidChangeTreeData` for each event makes
 * VS Code re-request and re-render rows fast enough that hover highlights
 * flicker and click targets move under the cursor. One coalesced refresh per
 * second keeps the row visibly alive while staying calmer than the pointer.
 */

/** Coalescing window for tree refreshes. */
const REFRESH_THROTTLE_MS = 1000;

/** A cohort directory row. */
interface CohortNode {
	/** Discriminator — `Vehicle` has no `kind`, so a plain check separates them. */
	kind: "cohort";
	cohort: FleetCohort;
}

/**
 * The cohort rows, built once at module scope rather than per `getChildren`.
 *
 * Tree elements are matched by object identity between calls, so freshly
 * allocated group objects would make VS Code treat every refresh as three new
 * directories: the expansion state resets and the whole tree blinks shut once
 * a second. Frozen because these are shared across every provider instance.
 *
 * Order is fixed and deliberate — Stage first because it is where a person
 * debugging a fleet looks first, then the regions. Not sorted by size or by
 * name: a list whose order depends on live data reorders itself under the
 * cursor.
 */
const COHORTS: readonly CohortNode[] = Object.freeze(
	(["Stage", "North America", "EMEA"] as const).map((cohort) =>
		Object.freeze({ kind: "cohort", cohort }) as CohortNode
	)
);

/** Either level of the tree. */
export type FleetNode = CohortNode | Vehicle;

const isCohort = (node: FleetNode): node is CohortNode => "kind" in node;

export class FleetTreeProvider implements vscode.TreeDataProvider<FleetNode>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData: vscode.Event<void> = this.changeEmitter.event;

	private readonly subscription: { dispose(): void };
	private throttleHandle: unknown = null;
	private disposed = false;

	constructor(private readonly simulator: FleetSimulator) {
		this.subscription = simulator.onVehicleChanged(() => this.scheduleRefresh());
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

	getChildren(element?: FleetNode): FleetNode[] {
		// Root: the cohorts. Under a cohort: its vehicles, in seed order — the
		// per-vehicle files live in the fleet: file system, not in this tree, so
		// there is nothing below a vehicle. Duplicating those files here would
		// give two competing ways to open the same thing.
		if (!element) return [...COHORTS];
		if (!isCohort(element)) return [];
		return this.simulator.getVehicles().filter((vehicle) => vehicle.cohort === element.cohort);
	}

	/**
	 * Supplied so `TreeView.reveal` works: revealing a vehicle now requires
	 * knowing which directory to expand, and VS Code asks this rather than
	 * searching. Nothing in the extension calls `reveal` today — it is three
	 * lines, and the alternative is a runtime error in whatever adds the first
	 * "Show in Vehicles" command.
	 */
	getParent(element: FleetNode): FleetNode | undefined {
		if (isCohort(element)) return undefined;
		return COHORTS.find((node) => node.cohort === element.cohort);
	}

	getTreeItem(node: FleetNode): vscode.TreeItem {
		return isCohort(node) ? this.cohortItem(node) : vehicleItem(node);
	}

	private cohortItem(node: CohortNode): vscode.TreeItem {
		const members = this.simulator
			.getVehicles()
			.filter((vehicle) => vehicle.cohort === node.cohort);
		const online = members.filter((vehicle) => vehicle.online).length;

		// Expanded, not Collapsed: a fleet console that opens showing three
		// closed folders has hidden its entire subject matter behind three
		// clicks. Grouping is here to make six rows legible, not to hide them.
		const item = new vscode.TreeItem(node.cohort, vscode.TreeItemCollapsibleState.Expanded);
		// Prefixed id: a cohort and a vehicle must never collide in the tree's
		// id space, and "EMEA" is a string a VIN could not be but a future
		// label might.
		item.id = `cohort:${node.cohort}`;
		// The same idiom the status bar uses ("5/6 online"), for the same
		// reason the two vehicle-level surfaces share their formatter: a user
		// comparing the corner of the window against the sidebar should not
		// have to translate. Counting online vehicles is on-message here;
		// aggregate charge or fault stats would be the dashboard creep this
		// redesign removed from the rows.
		item.description = `${online}/${members.length} online`;
		item.iconPath = new vscode.ThemeIcon("folder");
		item.contextValue = "cohort";
		return item;
	}

	/**
	 * Trailing-edge throttle: the first event starts a timer; every event
	 * inside the window rides along with it. (A leading-edge fire would still
	 * allow one refresh per event under a 1 Hz event stream — exactly the load
	 * pattern the simulator produces.)
	 */
	private scheduleRefresh(): void {
		if (this.disposed || this.throttleHandle !== null) return;
		this.throttleHandle = setTimeout(() => {
			this.throttleHandle = null;
			if (!this.disposed) {
				this.changeEmitter.fire();
			}
		}, REFRESH_THROTTLE_MS);
	}
}

function vehicleItem(vehicle: Vehicle): vscode.TreeItem {
	// The full 17-character VIN, not the tail: this is the one surface with
	// room for it, and it is what an operator scans, copies and pastes into a
	// decoder. Every compact surface shortens it — see `vinTail`.
	const item = new vscode.TreeItem(vehicle.vin, vscode.TreeItemCollapsibleState.None);

	// Stable id = VIN: without it, VS Code matches rows positionally across
	// refreshes and a selected row visually "jumps" vehicles when the list
	// re-renders.
	item.id = vehicle.vin;
	// The ONLY status text on a row, and only when there is something to say.
	// Online is the default state of a fleet and needs no annotation; a
	// description on all six rows is a column, and a column invites the live
	// telemetry back.
	item.description = vehicle.online ? undefined : "offline";
	item.tooltip = `${vehicle.year} ${vehicle.make} ${vehicle.model}\n${vehicle.vin}`;
	item.contextValue = "vehicle";
	// The vehicle's directory in the fleet: scheme — what the
	// FileDecorationProvider keys its badges on, and what makes "Reveal" style
	// commands line up with the file system.
	item.resourceUri = vscode.Uri.parse(`fleet:/${vehicle.vin}`);
	// ONE icon for every vehicle, whatever it is doing. A per-personality
	// glyph makes the sidebar a status board that redraws under the eye; the
	// decoration badge already carries the exceptional states, and it does so
	// in the gutter where VS Code puts such things natively.
	item.iconPath = new vscode.ThemeIcon("circle-large-outline");
	item.command = {
		command: "fleet.openControls",
		title: "Open Vehicle Controls",
		arguments: [vehicle.vin]
	};
	return item;
}
