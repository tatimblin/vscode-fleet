/**
 * The fleet's CAN database, as a real `.dbc` file, plus the tiny parser that
 * reads it back.
 *
 * Why the DBC is a string in a TypeScript file rather than an asset on disk:
 * the web build runs in a Web Worker extension host with no file system, so
 * anything the extension must be able to *read* has to be in the bundle. The
 * FS provider then serves this string at `fleet:/fleet.dbc`, which is what
 * gives the definition provider somewhere to jump to.
 *
 * Why it is parsed rather than duplicated: hover cards and the "go to
 * definition" target are both derived from THIS text by `parseDbcSignals`, so
 * a hover can never quote a factor the file does not contain. The alternative
 * — a hand-written table of signal metadata next to the DBC — is two sources
 * of truth that agree on the day they are written and never again.
 *
 * Honesty notes, because this file makes claims about real hardware:
 *
 *   - The seeded fleet is Fisker Oceans, but this DBC is not a Fisker one:
 *     Fisker never published a CAN matrix and none was reverse-engineered, so
 *     the bus layer borrows the *structure* of the public Tesla Model 3 DBC
 *     rather than inventing message ids nobody can check. The signal names
 *     below (`DI_*`, `GTW_*`, `ESP_*`) are therefore Tesla's, deliberately —
 *     a made-up Fisker-flavoured DBC would be less honest, not more.
 *   - Message ids, signal names, factors, offsets and VAL_ tables come from
 *     the community-reverse-engineered Tesla Model 3 DBC (opendbc) where such
 *     a signal exists, and the lines are written in that file's shape.
 *   - Byte order is `@1` (Intel) throughout, INCLUDING `DI_torque1`, where
 *     the public DBC uses Motorola order. That is a deliberate divergence
 *     documented in can.ts: one pair of little-endian bit helpers encodes
 *     every frame in this simulator. The DBC here describes what this
 *     simulator actually puts on the wire, not what a real Model 3 does, and
 *     the `CM_` line below says so inside the file itself.
 *   - `BMS_socUI` is not in the public DBC at all. It follows Tesla's naming
 *     convention and sits in the BMS block of the id space; its `CM_` line
 *     admits that.
 *
 * No `vscode` import: the selftest parses this text and cross-checks every
 * factor against the encoders in can.ts.
 */

export const FLEET_DBC = `VERSION "fleet-demo-1.0"


NS_ :
	NS_DESC_
	CM_
	BA_DEF_
	BA_
	VAL_
	CAT_DEF_
	CAT_
	FILTER
	BA_DEF_DEF_
	EV_DATA_
	ENVVAR_DATA_
	SGTYPE_
	SGTYPE_VAL_
	BA_DEF_SGTYPE_
	BA_SGTYPE_
	SIG_TYPE_REF_
	VAL_TABLE_
	SIG_GROUP_
	SIG_VALTYPE_
	SIGTYPE_VALTYPE_
	BO_TX_BU_
	BA_DEF_REL_
	BA_REL_
	BA_DEF_DEF_REL_
	BU_SG_REL_
	BU_EV_REL_
	BU_BO_REL_
	SG_MUL_VAL_

BS_:

BU_: DI ESP GTW BMS VEH


BO_ 262 DI_torque1: 8 DI
 SG_ DI_torqueMotor : 0|13@1- (0.25,0) [-1024|1023] "Nm"  VEH
 SG_ DI_motorRPM : 16|16@1- (1,0) [-32768|32767] "rpm"  VEH

BO_ 280 DI_systemStatus: 8 DI
 SG_ DI_gear : 21|3@1+ (1,0) [0|7] ""  VEH

BO_ 373 ESP_wheelSpeeds: 8 ESP
 SG_ ESP_wheelSpeedFrL : 0|13@1+ (0.04,0) [0|327.64] "kph"  VEH
 SG_ ESP_wheelSpeedFrR : 13|13@1+ (0.04,0) [0|327.64] "kph"  VEH
 SG_ ESP_wheelSpeedReL : 26|13@1+ (0.04,0) [0|327.64] "kph"  VEH
 SG_ ESP_wheelSpeedReR : 39|13@1+ (0.04,0) [0|327.64] "kph"  VEH

BO_ 599 DI_speed: 8 DI
 SG_ DI_vehicleSpeed : 12|12@1+ (0.08,-40) [-40|285] "kph"  VEH

BO_ 658 BMS_socUI: 8 BMS
 SG_ BMS_socUI : 10|10@1+ (0.1,0) [0|100] "%"  VEH

BO_ 792 GTW_carState: 8 GTW
 SG_ DOOR_STATE_FL : 12|2@1+ (1,0) [0|3] ""  VEH
 SG_ DOOR_STATE_FR : 14|2@1+ (1,0) [0|3] ""  VEH
 SG_ DOOR_STATE_RL : 22|2@1+ (1,0) [0|3] ""  VEH
 SG_ DOOR_STATE_RR : 29|2@1+ (1,0) [0|3] ""  VEH


CM_ BO_ 262 "Byte order is Intel here; the public Model 3 DBC packs DI_torque1 in Motorola order. This file describes what the fleet simulator encodes, and it encodes every frame little-endian through one pair of bit helpers (see sim/can.ts).";
CM_ SG_ 792 DOOR_STATE_RR "Bit 29, not 30: the four door fields are not evenly spaced in the real GTW_carState layout, and the gap is reproduced rather than tidied.";
CM_ BO_ 658 "Not from the public Model 3 DBC. No verified UI state-of-charge signal exists there, so this message only follows Tesla's BMS_ naming convention and sits in the BMS block of the id space to keep the stream's sort order plausible.";
CM_ SG_ 658 BMS_socUI "Convention-based, not reverse-engineered. Present so the demo has a battery signal to decode.";


VAL_ 280 DI_gear 0 "DI_GEAR_SNA" 1 "DI_GEAR_P" 2 "DI_GEAR_R" 3 "DI_GEAR_N" 4 "DI_GEAR_D" ;
VAL_ 792 DOOR_STATE_FL 0 "SNA" 1 "OPEN" 2 "CLOSED" ;
VAL_ 792 DOOR_STATE_FR 0 "SNA" 1 "OPEN" 2 "CLOSED" ;
VAL_ 792 DOOR_STATE_RL 0 "SNA" 1 "OPEN" 2 "CLOSED" ;
VAL_ 792 DOOR_STATE_RR 0 "SNA" 1 "OPEN" 2 "CLOSED" ;
`;

/** One `SG_` line, parsed, plus where it sits in the file. */
export interface DbcSignal {
	name: string;
	/** Enclosing `BO_` message name, e.g. "DI_speed". */
	messageName: string;
	/** Enclosing `BO_` arbitration id, decimal as the DBC writes it. */
	messageId: number;
	startBit: number;
	length: number;
	/** DBC byte order digit: 1 = Intel/little-endian, 0 = Motorola. */
	byteOrder: 0 | 1;
	signed: boolean;
	factor: number;
	offset: number;
	min: number;
	max: number;
	/** Unit string from the quoted field; "" for enumerated signals. */
	unit: string;
	/** 0-based line index of the `SG_` line within `FLEET_DBC`. */
	line: number;
	/** 0-based column at which `name` starts on that line. */
	column: number;
}

/**
 * `BO_ <id> <name>: <dlc> <transmitter>` — the message header. Kept loose on
 * whitespace because real DBC files in the wild are inconsistent about the
 * space before the colon.
 */
const MESSAGE_PATTERN = /^BO_\s+(\d+)\s+([A-Za-z_][\w]*)\s*:\s*(\d+)/;

/**
 * ` SG_ <name> : <start>|<len>@<order><sign> (<factor>,<offset>) [<min>|<max>] "<unit>" <receivers>`
 *
 * Multiplexed signals (`SG_ name m0 :`) are deliberately NOT handled: this DBC
 * has none, and a parser that silently mis-reads a multiplex indicator as part
 * of the name is worse than one that skips the line.
 */
const SIGNAL_PATTERN =
	/^\s*SG_\s+([A-Za-z_][\w]*)\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]+)\)\s*\[([^|]*)\|([^\]]*)\]\s*"([^"]*)"/;

/**
 * Parse every `SG_` line into a name-keyed map.
 *
 * Deliberately not memoised: `FLEET_DBC` is ~100 lines and the callers are a
 * hover and a definition lookup, both already on a user-interaction timescale.
 * A module-level cache would only be a chance for a future caller to hand in
 * different text and get the first caller's answer.
 */
export function parseDbcSignals(text: string = FLEET_DBC): Map<string, DbcSignal> {
	const signals = new Map<string, DbcSignal>();
	const lines = text.split("\n");

	let messageName = "";
	let messageId = -1;

	for (let line = 0; line < lines.length; line++) {
		const raw = lines[line]!;

		const message = MESSAGE_PATTERN.exec(raw);
		if (message) {
			messageId = Number(message[1]);
			messageName = message[2]!;
			continue;
		}

		const signal = SIGNAL_PATTERN.exec(raw);
		if (!signal || messageId < 0) continue;

		const name = signal[1]!;
		signals.set(name, {
			name,
			messageName,
			messageId,
			startBit: Number(signal[2]),
			length: Number(signal[3]),
			byteOrder: signal[4] === "1" ? 1 : 0,
			signed: signal[5] === "-",
			factor: Number(signal[6]),
			offset: Number(signal[7]),
			min: Number(signal[8]),
			max: Number(signal[9]),
			unit: signal[10]!,
			line,
			// The name's real column, found by search rather than assumed: the
			// definition provider highlights exactly these characters, and an
			// assumed " SG_ ".length would drift the moment a line is indented
			// with a tab instead of a space.
			column: raw.indexOf(name)
		});
	}

	return signals;
}

/** Every signal name the DBC defines. Convenience for the selftest's sweep. */
export function dbcSignalNames(text: string = FLEET_DBC): string[] {
	return [...parseDbcSignals(text).keys()];
}
