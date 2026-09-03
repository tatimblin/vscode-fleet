import * as vscode from "vscode";
import type { FleetSimulator } from "../sim/clock";
import type { Vehicle } from "../model/types";
import { dtcSeverity } from "../model/status";

/**
 * Stored trouble codes, published into the Problems panel.
 *
 * This is the feature that makes the demo's central claim land: the fleet is
 * files, so the *editor's own* diagnostics machinery works on it. Nothing here
 * draws a list of faults — it hands VS Code a `DiagnosticCollection` and gets
 * the Problems panel, the ⚠ counts in the status bar, `F8` to step through
 * codes, and squiggles in the open JSON for free.
 *
 * Diagnostics are published against BOTH files a code appears in:
 *
 *   fleet:/<VIN>/dtcs.json   the scan-tool dump, where the code is the point;
 *   fleet:/<VIN>/state.json  the vehicle snapshot, whose `diagnostics.codes`
 *                            array exists partly so this provider has real
 *                            text there to anchor to (see serialize.ts).
 *
 * "Real text" is the constraint that shapes the rest of this file. A
 * `Diagnostic` whose range is invented — line 0, or a whole-file range —
 * produces a Problems entry that navigates the reader somewhere arbitrary,
 * and the illusion collapses the first time somebody clicks one. So every
 * range is found by searching the *actual serialized bytes* for the code
 * string. The serializers are deterministic, and this provider asks the
 * simulator for the same string the FS provider will hand the editor, so the
 * two cannot disagree.
 */

/** Files the codes are published against, relative to the vehicle directory. */
const STATE_FILE = "state.json";
const DTCS_FILE = "dtcs.json";

const SEVERITIES: Record<ReturnType<typeof dtcSeverity>, vscode.DiagnosticSeverity> = {
	error: vscode.DiagnosticSeverity.Error,
	warning: vscode.DiagnosticSeverity.Warning,
	information: vscode.DiagnosticSeverity.Information
};

export class DtcDiagnostics implements vscode.Disposable {
	private readonly collection = vscode.languages.createDiagnosticCollection("fleet");
	private readonly subscription: { dispose(): void };

	/**
	 * Fault-set fingerprints, keyed by VIN — the same trick fleetFsProvider
	 * uses, and for the same reason. `onVehicleChanged` fires 4×/sec for the
	 * moving vehicle; the codes change roughly never. Re-serializing two files
	 * and re-publishing diagnostics on every tick would burn work to produce
	 * an identical Problems panel, and (worse) VS Code re-sorts the panel on
	 * every `set`, so the list would visibly twitch under the cursor.
	 */
	private readonly fingerprints = new Map<string, string>();

	constructor(private readonly simulator: FleetSimulator) {
		for (const vehicle of simulator.getVehicles()) {
			this.publish(vehicle);
		}
		this.subscription = simulator.onVehicleChanged((vin) => {
			const vehicle = simulator.getVehicle(vin);
			if (!vehicle) return;
			if (fingerprintDtcs(vehicle) === this.fingerprints.get(vin)) return;
			this.publish(vehicle);
		});
	}

	dispose(): void {
		this.subscription.dispose();
		this.collection.dispose();
	}

	/**
	 * (Re)publish one vehicle's codes. A vehicle whose codes cleared — which is
	 * what `fleet.reset` does to anything the demo faulted by hand — must have
	 * its entries *deleted*, not set to an empty array: an empty array still
	 * leaves the file listed in the Problems panel with a zero count.
	 */
	private publish(vehicle: Vehicle): void {
		this.fingerprints.set(vehicle.vin, fingerprintDtcs(vehicle));

		const stateUri = vscode.Uri.parse(`fleet:/${vehicle.vin}/${STATE_FILE}`);
		const dtcsUri = vscode.Uri.parse(`fleet:/${vehicle.vin}/${DTCS_FILE}`);

		if (vehicle.dtcs.length === 0) {
			this.collection.delete(stateUri);
			this.collection.delete(dtcsUri);
			return;
		}

		this.collection.set(stateUri, this.diagnosticsFor(vehicle, this.simulator.serializeState(vehicle.vin)));
		this.collection.set(dtcsUri, this.diagnosticsFor(vehicle, this.simulator.serializeDtcs(vehicle.vin)));
	}

	/**
	 * Build one diagnostic per code, anchored to that code's position in
	 * `text`. Codes the search cannot find are skipped rather than given a
	 * fallback range — a diagnostic pointing at the wrong characters is a
	 * worse outcome than a missing one, and the selftest's serializer coverage
	 * is what keeps the search from silently missing.
	 */
	private diagnosticsFor(vehicle: Vehicle, text: string): vscode.Diagnostic[] {
		const diagnostics: vscode.Diagnostic[] = [];

		for (const dtc of vehicle.dtcs) {
			// Quoted, so the search lands on the JSON *string value* rather than
			// on an occurrence of the same letters inside a description.
			const range = locate(text, `"${dtc.code}"`);
			if (!range) continue;

			const diagnostic = new vscode.Diagnostic(
				// Trim the quotes back off: the squiggle belongs under the code,
				// not under the punctuation around it.
				new vscode.Range(
					range.start.translate(0, 1),
					range.end.translate(0, -1)
				),
				`${dtc.code} — ${dtc.description}`,
				SEVERITIES[dtcSeverity(dtc.code)]
			);
			diagnostic.source = "fleet-dtc";
			// The code, not an index: VS Code shows it in the Problems row and
			// makes it filterable, which is exactly how a technician would want
			// to narrow a list of faults.
			diagnostic.code = dtc.code;
			// A pending code has been seen once and is not yet confirmed across
			// drive cycles — VS Code's own vocabulary for "true but provisional"
			// is the unnecessary/deprecated tag set, which does not fit, so the
			// distinction rides in the message tail instead.
			if (dtc.status === "pending") {
				diagnostic.message += " (pending)";
			}
			diagnostics.push(diagnostic);
		}

		return diagnostics;
	}
}

/**
 * Find `needle` in `text` and return its range, counting newlines by hand.
 *
 * Not `TextDocument.positionAt`: that would require the document to be open,
 * and the Problems panel must be populated for vehicles nobody has opened yet
 * — which is the whole point of a diagnostics panel.
 */
function locate(text: string, needle: string): vscode.Range | undefined {
	const index = text.indexOf(needle);
	if (index < 0) return undefined;

	let line = 0;
	let lineStart = 0;
	for (let i = 0; i < index; i++) {
		if (text.charCodeAt(i) === 10) {
			line++;
			lineStart = i + 1;
		}
	}
	const character = index - lineStart;
	return new vscode.Range(line, character, line, character + needle.length);
}

/** Cheap identity of a vehicle's DTC list, for change detection. */
function fingerprintDtcs(vehicle: Vehicle): string {
	return vehicle.dtcs.map((dtc) => `${dtc.code}:${dtc.status}:${dtc.timestamp}`).join("|");
}
