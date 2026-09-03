import * as vscode from "vscode";
import type { FleetSimulator } from "../sim/clock";
import type { DoorId, Vehicle } from "../model/types";
import { buildControlsHtml } from "../webview/controlsHtml";
import { runVehicleCommand } from "../commandUi";
import { vinTail } from "../model/vin";

/**
 * The "Vehicle Controls" custom editor (viewType `fleet.controlsEditor`),
 * bound by the manifest's glob to every `controls.vehicle` marker file.
 *
 * Why a custom *editor* rather than a webview panel: an editor participates
 * in the workbench — it lives in a tab, splits, reopens on window reload, and
 * is addressed by a URI in the fleet: file system, so "open the controls for
 * Atlas" is just opening a file. That URI-addressability is also what lets
 * tree items open it with a plain command and what will let the blog post
 * deep-link it.
 *
 * `CustomReadonlyEditorProvider` specifically, because the document has no
 * edit model: the file is a zero-byte marker, and mutations (door locks) go
 * straight to the simulator over `postMessage`, not through a document edit /
 * save cycle. Using the editable provider would put a misleading dirty dot on
 * the tab every time someone pressed a button.
 *
 * Message protocol (all JSON-safe — see model/types.ts on structured clone):
 *   webview → host:  { type: "ready" }
 *                    { type: "setDoorLock", door: DoorId, locked: boolean }
 *   host → webview:  { type: "state", state: ControlsState }
 *                    { type: "commandResult", door: DoorId, ok: boolean,
 *                      reason?: string }
 *
 * `commandResult` exists because mutations now ride the async command layer
 * (vehicleCommands.ts) with its ~600–900 ms simulated round trip: the tile
 * shows a busy state from click until this message lands, and on success the
 * actual new lock state arrives separately via the ordinary `state` push.
 * Rejection toasts are the HOST's job (commandUi.ts) — the webview only
 * clears its busy state, so the reason renders once, natively, not twice.
 * That is also why the panel's door tiles stay clickable for an asleep
 * vehicle (dimmed, not disabled): the ASLEEP rejection is what carries the
 * "Wake Vehicle" offer, and a disabled tile would make the wake flow
 * unreachable from here. The woken vehicle arrives on the ordinary
 * onVehicleChanged push; the rejected command is NOT auto-retried.
 *
 * Push gating: state pushes are skipped while the panel is hidden. With
 * `retainContextWhenHidden` the hidden webview still exists and would happily
 * process 4 messages/sec per background tab; gating on `panel.visible` (and
 * re-syncing once on the visibility flip) keeps N open vehicle tabs from
 * multiplying the simulator's tick into N render loops.
 */

/** The JSON-safe projection of a Vehicle that the webview renders. */
interface ControlsState {
	/** Heading text — `2023 Fisker Ocean Extreme`. */
	title: string;
	vin: string;
	personality: string;
	online: boolean;
	locked: boolean;
	doors: Record<DoorId, { locked: boolean; open: boolean }>;
	gear: string;
	speedKph: number;
	charge: { soc: number; charging: boolean; powerKw: number; rangeKm: number };
}

const VALID_DOORS: readonly DoorId[] = ["FL", "FR", "RL", "RR"];

export class ControlsEditorProvider implements vscode.CustomReadonlyEditorProvider {
	static readonly viewType = "fleet.controlsEditor";

	constructor(private readonly simulator: FleetSimulator) {}

	static register(simulator: FleetSimulator): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			ControlsEditorProvider.viewType,
			new ControlsEditorProvider(simulator),
			{
				webviewOptions: {
					// Keep the DOM alive across tab switches: the panel re-renders
					// from pushed state, but a cold reload on every tab focus makes
					// the charge bar visibly re-animate from zero each time.
					retainContextWhenHidden: true
				},
				// One controls panel per vehicle URI. Two live panels on the same
				// vehicle would both be correct (both subscribe to the simulator),
				// but the demo gains nothing from proving it.
				supportsMultipleEditorsPerDocument: false
			}
		);
	}

	openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
		// The marker file carries no content, so the "document" is just the URI.
		return { uri, dispose: () => {} };
	}

	resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
		const vin = vinFromUri(document.uri);

		// Titled from the URI rather than from a lookup: the tab must be named
		// before anything is known to exist at that path, and a vehicle the
		// simulator has never heard of still gets an honest tab.
		panel.title = `Vehicle · ${vinTail(vin)}`;
		panel.webview.options = { enableScripts: true };
		panel.webview.html = buildControlsHtml({
			nonce: makeNonce(),
			cspSource: panel.webview.cspSource
		});

		const pushState = (): void => {
			const current = this.simulator.getVehicle(vin);
			if (!current) return;
			void panel.webview.postMessage({ type: "state", state: projectState(current) });
		};

		const subscriptions: vscode.Disposable[] = [];

		// Commands take a simulated ~600–900 ms round trip; the user can close
		// the tab mid-flight, and postMessage on a disposed webview throws.
		let panelDisposed = false;

		subscriptions.push(
			panel.webview.onDidReceiveMessage((message: { type?: string; door?: string; locked?: boolean }) => {
				if (message?.type === "ready") {
					pushState();
					return;
				}
				if (message?.type === "setDoorLock") {
					// Validate: the message crossed a postMessage boundary from a
					// scriptable surface, so treat it as untrusted input even though
					// we wrote the sender.
					const door = VALID_DOORS.find((d) => d === message.door);
					if (door && typeof message.locked === "boolean") {
						// Through the async command layer: simulated round-trip
						// latency, state-derived rejections, toasts on the host
						// side. The webview only learns ok/reason (to clear its
						// busy tile); the actual new lock state rides the ordinary
						// onVehicleChanged → state push below.
						void runVehicleCommand(this.simulator, vin, {
							kind: "setDoorLock",
							door,
							locked: message.locked
						}).then((result) => {
							if (panelDisposed) return;
							void panel.webview.postMessage({
								type: "commandResult",
								door,
								ok: result.ok,
								reason: result.ok ? undefined : result.reason
							});
						});
					}
				}
			})
		);

		subscriptions.push(
			this.simulator.onVehicleChanged((changedVin) => {
				if (changedVin === vin && panel.visible) {
					pushState();
				}
			})
		);

		subscriptions.push(
			panel.onDidChangeViewState(() => {
				// The panel skipped pushes while hidden; hand it the present the
				// moment it comes back.
				if (panel.visible) pushState();
			})
		);

		panel.onDidDispose(() => {
			panelDisposed = true;
			for (const subscription of subscriptions) subscription.dispose();
		});
	}
}

/** fleet:/<VIN>/controls.vehicle → <VIN>. */
function vinFromUri(uri: vscode.Uri): string {
	return uri.path.split("/").filter((s) => s.length > 0)[0] ?? "";
}

function projectState(vehicle: Vehicle): ControlsState {
	return {
		// The trim, not a name: the webview's header pairs it with the VIN
		// underneath, which is the vehicle's actual identity. Nothing in this
		// fleet has a name.
		title: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
		vin: vehicle.vin,
		personality: vehicle.personality,
		online: vehicle.online,
		locked: vehicle.locked,
		doors: {
			FL: { ...vehicle.doors.FL },
			FR: { ...vehicle.doors.FR },
			RL: { ...vehicle.doors.RL },
			RR: { ...vehicle.doors.RR }
		},
		gear: vehicle.gear,
		speedKph: vehicle.speedKph,
		charge: {
			soc: vehicle.charge.soc,
			charging: vehicle.charge.charging,
			powerKw: vehicle.charge.powerKw,
			rangeKm: Math.round(vehicle.charge.rangeKm)
		}
	};
}

/**
 * 32 characters of webview script nonce. `Math.random` rather than
 * `crypto.getRandomValues` on purpose: neither extension host guarantees a
 * typed `crypto` global under this tsconfig (no DOM lib), and the nonce's job
 * here is CSP cache-busting inside a local, non-network webview — not
 * cryptography.
 */
function makeNonce(): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let nonce = "";
	for (let i = 0; i < 32; i++) {
		nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return nonce;
}
