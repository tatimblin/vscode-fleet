import * as vscode from "vscode";
import type { DbcSignal } from "../sim/dbcText";
import { parseDbcSignals } from "../sim/dbcText";
import { describeSignalMarkdown } from "../model/dbcHover";

/**
 * Language features over the `fleet:` scheme: **F12 on a CAN signal name in
 * `state.json` jumps to its `SG_` line in `fleet.dbc`**, and hovering it shows
 * the signal's bit layout and scaling.
 *
 * This is the demo's sharpest claim about virtual file systems, so it is worth
 * being precise about what is actually happening: neither of these providers
 * knows anything about vehicles. They are ordinary `DefinitionProvider` and
 * `HoverProvider` registrations against a document selector, and VS Code's
 * whole navigation stack — go-to-definition, peek definition, ctrl-click,
 * hover cards, the back button — works on documents that exist only in
 * memory, in a simulator, in a Web Worker.
 *
 * Both providers read their answers out of `FLEET_DBC` by parsing it. Nothing
 * here holds a second copy of a factor or a bit offset, so a hover card cannot
 * describe a signal differently from the file it links to.
 *
 * The registration covers the whole `fleet:` scheme rather than
 * `{ scheme: "fleet", language: "json" }` — the DBC file itself is plaintext,
 * and a reader who ctrl-clicks a signal name *inside* `fleet.dbc` reasonably
 * expects to land on its definition rather than nothing.
 */

const DBC_URI = "fleet:/fleet.dbc";

/**
 * Word pattern for signal names. Explicit rather than relying on the
 * language's default: JSON's default word pattern happens to include
 * underscores, but "happens to" is not a guarantee across language
 * contributions, and `DI_vehicleSpeed` splitting at the underscore would make
 * every lookup miss.
 */
const SIGNAL_WORD = /[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Register both providers. Returns one disposable holding both, so the caller
 * pushes a single subscription and cannot half-dispose the pair.
 */
export function registerDbcNavigation(): vscode.Disposable {
	const selector: vscode.DocumentSelector = { scheme: "fleet" };
	const signals = parseDbcSignals();

	const definitions = vscode.languages.registerDefinitionProvider(selector, {
		provideDefinition(document, position) {
			const signal = signalAt(signals, document, position);
			if (!signal) return undefined;
			return new vscode.Location(
				vscode.Uri.parse(DBC_URI),
				new vscode.Range(
					signal.line,
					signal.column,
					signal.line,
					signal.column + signal.name.length
				)
			);
		}
	});

	const hovers = vscode.languages.registerHoverProvider(selector, {
		provideHover(document, position) {
			const range = document.getWordRangeAtPosition(position, SIGNAL_WORD);
			const signal = signalAt(signals, document, position);
			if (!signal) return undefined;
			return new vscode.Hover(describeSignal(signal), range);
		}
	});

	return vscode.Disposable.from(definitions, hovers);
}

/** The DBC signal named by the word under `position`, if there is one. */
function signalAt(
	signals: Map<string, DbcSignal>,
	document: vscode.TextDocument,
	position: vscode.Position
): DbcSignal | undefined {
	const range = document.getWordRangeAtPosition(position, SIGNAL_WORD);
	if (!range) return undefined;
	return signals.get(document.getText(range));
}

/**
 * The hover card. The markdown itself is built by a pure helper in
 * `model/dbcHover.ts` — including the table-cell escaping that keeps a layout
 * string like `12|12@1+` from being read as three columns — so the selftest
 * can assert the formatting without an extension host.
 */
function describeSignal(signal: DbcSignal): vscode.MarkdownString {
	return new vscode.MarkdownString(describeSignalMarkdown(signal));
}
