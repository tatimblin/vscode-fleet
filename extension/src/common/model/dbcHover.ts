import type { DbcSignal } from "../sim/dbcText";

/**
 * The hover card's markdown, as a pure string builder.
 *
 * Split out of `providers/dbcNavigation.ts` (which must import `vscode` to
 * hand VS Code a `MarkdownString`) so the table's escaping rules are testable
 * from the Bun selftest without an extension host — the same split that keeps
 * vehicleCommands.ts free of the host.
 */

/**
 * Make a value safe to sit inside a markdown *table* cell.
 *
 * Markdown splits table rows on `|` BEFORE it parses inline code spans, so a
 * backticked value containing a pipe — every DBC layout string, e.g.
 * `12|12@1+` — silently loses everything after the first pipe and shifts the
 * remaining columns. Backticks are not protection here; a backslash escape is.
 */
export function escapeTableCell(value: string | number): string {
	return String(value).replace(/\|/g, "\\|");
}

/**
 * A two-column table of everything the `SG_` line says.
 *
 * Every cell is read from the parsed signal, including the byte-order and
 * sign notation, which is reassembled into DBC syntax (`12|12@1+`) rather
 * than translated into prose. A reader hovering a signal in this demo is
 * someone who reads DBC files; showing them "12 bits, little-endian,
 * unsigned" would be translating out of the language they came in speaking.
 */
export function describeSignalMarkdown(signal: DbcSignal): string {
	const layout = `${signal.startBit}|${signal.length}@${signal.byteOrder}${signal.signed ? "-" : "+"}`;
	const unit = signal.unit === "" ? "—" : signal.unit;

	// Every interpolated cell goes through escapeTableCell: the layout string
	// is the one that pipes today, but a DBC unit or message name could too,
	// and a table that breaks only for some signals is worse than one that
	// breaks for all of them.
	return (
		`**\`${escapeTableCell(signal.name)}\`**\n\n` +
		"| | |\n|---|---|\n" +
		`| message | \`${escapeTableCell(signal.messageName)}\` (${escapeTableCell(toHexId(signal.messageId))}) |\n` +
		`| layout | \`${escapeTableCell(layout)}\` |\n` +
		`| factor / offset | \`${escapeTableCell(signal.factor)}\` / \`${escapeTableCell(signal.offset)}\` |\n` +
		`| range | \`${escapeTableCell(signal.min)}\` … \`${escapeTableCell(signal.max)}\` |\n` +
		`| unit | ${escapeTableCell(unit)} |\n`
	);
}

/** "599" → "0x257 · 599" — DBC files are decimal, candump output is hex. */
export function toHexId(id: number): string {
	return `0x${id.toString(16).toUpperCase().padStart(3, "0")} · ${id}`;
}
