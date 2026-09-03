/**
 * VIN (Vehicle Identification Number) construction and validation, per the
 * ISO 3779 layout and the FMVSS 565 check-digit algorithm used in North
 * America.
 *
 * A VIN is 17 characters:
 *
 *   pos  1– 3  WMI          world manufacturer identifier ("VCF" = Fisker)
 *   pos  4– 8  VDS          vehicle descriptor (model, body, restraint system)
 *   pos     9  check digit  computed from the other 16 characters
 *   pos    10  model year   a letter/digit from a 30-year cycle
 *   pos    11  plant        assembly plant code
 *   pos 12–17  serial       sequential build number
 *
 * The demo bothers with the real algorithm instead of random strings because a
 * VIN is the one string in this fleet a reader might paste into a decoder. A
 * fake one fails there; a real one decodes to the right manufacturer and year,
 * and that single detail is what makes the mock read as a system rather than
 * as lorem ipsum.
 */

/**
 * The 33 characters legal in a VIN. I, O and Q are excluded by the standard
 * precisely because they are visually confusable with 1, 0 and 0 on a stamped
 * plate — a scanner or a human transcribing a VIN would produce ambiguity that
 * the check digit could not catch.
 */
const VIN_ALPHABET = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ";

/**
 * Transliteration table: each letter's numeric value for the check digit.
 *
 * This is a lookup table and NOT arithmetic on the character code, which is the
 * tempting shortcut. The values restart at 1 twice (A–H = 1–8, then J–R = 1–9)
 * but the third run does NOT restart: S = 2, not 1. Any formula of the form
 * "(code - 'A') mod 9 + 1" gets S, T, U … wrong by exactly one and produces
 * check digits that look plausible and validate against nothing. The table is
 * the only representation that cannot drift.
 *
 * Digits transliterate to their own value and are handled separately.
 */
const TRANSLITERATION: Readonly<Record<string, number>> = {
	A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
	J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
	S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9
};

/**
 * Positional weights, index 0 = VIN position 1. Position 9 has weight 0, which
 * is how the check digit excludes itself from its own sum — so `computeCheckDigit`
 * can be handed a full VIN, or one with any placeholder in position 9, and get
 * the same answer.
 */
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2] as const;

export const VIN_LENGTH = 17;

/** How many trailing VIN characters the short form shows. */
const TAIL_LENGTH = 6;

/**
 * The short form of a VIN: `…002314`.
 *
 * Every compact surface in the extension refers to a vehicle this way — the
 * editor tab, the terminal name, toasts, the switcher's label, the status bar
 * tooltip — because the tree already carries the full 17 characters and a
 * sidebar of them is unreadable. Six is not arbitrary: positions 12–17 are the
 * sequential build number, so the tail is the part that actually differs
 * between two cars off the same line, and it is what a technician reads aloud.
 *
 * It lives HERE, in the host-free model, rather than beside the tree that
 * shows it, because the simulator writes it into ambient event messages and
 * `src/common/sim/` must not import `vscode`. One formatter, or the ellipsis
 * and the digit count drift apart between two surfaces showing the same car.
 */
export function vinTail(vin: string): string {
	return `…${vin.slice(-TAIL_LENGTH)}`;
}

/**
 * Model year codes for position 10. The cycle is 30 long and skips I, O, Q, U,
 * Z and 0, so it is not derivable from the year by arithmetic either. Only the
 * range this demo can produce is listed; anything outside it is a programming
 * error, not a runtime input, so it throws.
 */
const YEAR_CODES: Readonly<Record<number, string>> = {
	2010: "A", 2011: "B", 2012: "C", 2013: "D", 2014: "E", 2015: "F",
	2016: "G", 2017: "H", 2018: "J", 2019: "K", 2020: "L", 2021: "M",
	2022: "N", 2023: "P", 2024: "R", 2025: "S", 2026: "T", 2027: "V",
	2028: "W", 2029: "X", 2030: "Y"
};

/** Numeric value of one VIN character, or `null` if the character is not legal. */
function transliterate(char: string): number | null {
	if (char >= "0" && char <= "9") return char.charCodeAt(0) - 48;
	const value = TRANSLITERATION[char];
	return value === undefined ? null : value;
}

/**
 * Compute the check digit for a 17-character VIN.
 *
 * Whatever sits in position 9 of the input is ignored (its weight is 0), so
 * callers may pass a complete VIN to verify it, or a VIN with a placeholder to
 * fill it in. Returns "0"–"9", or "X" when the remainder is 10 — the standard's
 * escape for the fact that a remainder mod 11 needs eleven symbols and only ten
 * digits exist.
 *
 * Throws on anything that is not 17 legal VIN characters, because a silently
 * returned digit for a malformed VIN would be indistinguishable from a correct
 * one.
 */
export function computeCheckDigit(vin17: string): string {
	if (vin17.length !== VIN_LENGTH) {
		throw new Error(`VIN must be ${VIN_LENGTH} characters, got ${vin17.length}`);
	}

	const vin = vin17.toUpperCase();
	let sum = 0;

	for (let i = 0; i < VIN_LENGTH; i++) {
		// Position 9 is the check digit itself. Its weight is 0 so the arithmetic
		// would already neutralise it, but it is also the one position allowed to
		// hold "X" or a placeholder, so skip validating it as a data character.
		if (i === 8) continue;

		const value = transliterate(vin[i]!);
		if (value === null) {
			throw new Error(`Illegal VIN character "${vin[i]}" at position ${i + 1}`);
		}
		sum += value * WEIGHTS[i]!;
	}

	const remainder = sum % 11;
	return remainder === 10 ? "X" : String(remainder);
}

/**
 * True when `vin` is 17 legal characters whose check digit matches.
 *
 * This is total: it returns false rather than throwing for any input, so it can
 * be pointed at user-supplied or deserialised strings.
 */
export function isValidVin(vin: string): boolean {
	if (typeof vin !== "string" || vin.length !== VIN_LENGTH) return false;

	const upper = vin.toUpperCase();

	// Position 9 may legally be "X"; every other position must be in the
	// alphabet. Checking this up front is what lets computeCheckDigit throw.
	for (let i = 0; i < VIN_LENGTH; i++) {
		const char = upper[i]!;
		if (i === 8) {
			if (char !== "X" && !(char >= "0" && char <= "9")) return false;
			continue;
		}
		if (!VIN_ALPHABET.includes(char)) return false;
	}

	try {
		return computeCheckDigit(upper) === upper[8];
	} catch {
		return false;
	}
}

export interface GenerateVinOptions {
	/** World manufacturer identifier, 3 legal VIN characters, e.g. "VCF". */
	wmi: string;
	/** Model year, 2010–2030 (the span covered by `YEAR_CODES`). */
	year: number;
	/** Sequential build number, 0–999999; rendered as positions 12–17. */
	serial: number;
	/** Assembly plant code (position 11). Defaults to "G" (Graz, Austria —
	 * Magna Steyr, where the seeded fleet's Oceans were built). */
	plant?: string;
}

/**
 * Characters used to fill the VDS (positions 4–8). Restricted to a plausible,
 * unambiguous subset rather than the full alphabet so the generated descriptors
 * read like real ones — real VDS fields are dense with letters and rarely
 * contain long digit runs.
 */
const VDS_FILL = "ABCDEFGHJKLMNPRSTUVWXYZ";

/**
 * Build a valid 17-character VIN.
 *
 * The VDS is derived deterministically from the WMI and serial rather than
 * randomly: the seeded fleet must produce the same VINs on every reload, or the
 * demo's virtual file system would hand out different paths each time the
 * extension host restarts and every open editor tab would 404.
 */
export function generateVin(opts: GenerateVinOptions): string {
	const wmi = opts.wmi.toUpperCase();
	if (wmi.length !== 3 || [...wmi].some((c) => !VIN_ALPHABET.includes(c))) {
		throw new Error(`WMI must be 3 legal VIN characters, got "${opts.wmi}"`);
	}

	const yearCode = YEAR_CODES[opts.year];
	if (!yearCode) {
		throw new Error(`No VIN year code for ${opts.year} (supported: 2010–2030)`);
	}

	if (!Number.isInteger(opts.serial) || opts.serial < 0 || opts.serial > 999999) {
		throw new Error(`Serial must be an integer 0–999999, got ${opts.serial}`);
	}

	const plant = (opts.plant ?? "G").toUpperCase();
	if (plant.length !== 1 || !VIN_ALPHABET.includes(plant)) {
		throw new Error(`Plant code must be 1 legal VIN character, got "${opts.plant}"`);
	}

	// Cheap deterministic spread (an FNV-1a-flavoured mix) over the WMI and
	// serial, so two vehicles from the same manufacturer do not share a VDS.
	let hash = 2166136261;
	for (const char of `${wmi}:${opts.serial}`) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619) >>> 0;
	}

	let vds = "";
	for (let i = 0; i < 5; i++) {
		vds += VDS_FILL[hash % VDS_FILL.length]!;
		hash = Math.floor(hash / VDS_FILL.length) + i * 7919;
	}

	const serial = String(opts.serial).padStart(6, "0");

	// Position 9 gets a "0" placeholder; its weight is 0, so the check digit
	// computed over this string is the one that belongs in it.
	const withPlaceholder = `${wmi}${vds}0${yearCode}${plant}${serial}`;
	const check = computeCheckDigit(withPlaceholder);

	return `${wmi}${vds}${check}${yearCode}${plant}${serial}`;
}
