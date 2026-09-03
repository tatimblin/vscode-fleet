import type { CanFrame, Vehicle } from "../model/types";

/**
 * CAN frame generation: the simulated bus of one vehicle.
 *
 * The stream mixes two kinds of frames, and the distinction is the whole
 * point:
 *
 *   - Signal-bearing frames use arbitration IDs, signal names and scalings
 *     from the community-reverse-engineered Tesla Model 3 DBC (opendbc). Their
 *     payload bytes genuinely encode the vehicle's *current* simulated state,
 *     so a reader who pauses the stream and decodes 0x257 by hand gets the
 *     speed shown in the controls editor. That round-trip is what separates a
 *     simulation from a scrolling wall of random hex.
 *
 *   - Filler frames carry plausible IDs and random payloads, because a real
 *     bus is mostly traffic you are not looking for. A stream that is 100%
 *     decodable signals reads as staged; the noise is what sells it.
 *
 * Bit-layout honesty note: `DI_vehicleSpeed` is encoded at its true DBC layout
 * (12|12@1+, factor 0.08, offset −40) because the selftest and the next unit's
 * terminal decoder round-trip it. The other signal frames keep their real IDs,
 * names, scalings and VAL_ tables but place fields little-endian even where
 * the public DBC uses Motorola byte order (`DI_torque1` in particular), so one
 * pair of bit helpers serves every frame. If a future unit decodes those too,
 * it must use these helpers — not the DBC's byte order.
 */

/**
 * Set `length` bits of `raw` into `data` starting at little-endian bit
 * position `startBit` (bit 0 = byte 0, LSB — Intel order in DBC terms, `@1`).
 *
 * A loop over single bits rather than shifted byte masks: payloads here cross
 * byte boundaries at odd offsets (12|12, 13-bit wheels), and the masked-shift
 * version of this function is exactly where off-by-one endianness bugs live.
 * At the frame rates involved the per-bit cost is irrelevant.
 */
export function setBitsLE(data: number[], startBit: number, length: number, raw: number): void {
	for (let i = 0; i < length; i++) {
		const bit = startBit + i;
		const byte = bit >> 3;
		if (raw & (1 << i)) {
			data[byte] = (data[byte] ?? 0) | (1 << (bit & 7));
		}
	}
}

/** Inverse of `setBitsLE`; reads an unsigned value. */
export function getBitsLE(data: number[], startBit: number, length: number): number {
	let raw = 0;
	for (let i = 0; i < length; i++) {
		const bit = startBit + i;
		const byte = bit >> 3;
		if (((data[byte] ?? 0) >> (bit & 7)) & 1) {
			raw |= 1 << i;
		}
	}
	return raw;
}

/** Two's-complement clamp of a physical value into a signed raw field. */
function toSignedRaw(value: number, bits: number): number {
	const max = (1 << (bits - 1)) - 1;
	const min = -(1 << (bits - 1));
	const clamped = Math.max(min, Math.min(max, Math.round(value)));
	return clamped < 0 ? clamped + (1 << bits) : clamped;
}

function frame(timestamp: number, id: number, data: number[], label?: string): CanFrame {
	// Pad to a fixed 8-byte payload: every signal frame here is a periodic
	// broadcast message, and those are full-length on the real bus.
	while (data.length < 8) data.push(0);
	return { timestamp, id, dlc: data.length, data, label };
}

/** VAL_ table from the DBC: gear as `DI_gear` encodes it (0 = SNA). */
const GEAR_VALUES: Record<Vehicle["gear"], number> = { P: 1, R: 2, N: 3, D: 4 };

/**
 * Powertrain values derived from road speed, exported because TWO consumers
 * need the same numbers: the bus traffic generator below, and the
 * `can_signals` block `serialize.ts` writes into `state.json`. Computing them
 * twice is exactly the drift the single-clock rule exists to prevent — a
 * reader who compares the torque in `state.json` against the torque decoded
 * from a paused `DI_torque1` frame must find the same value.
 *
 * A single-speed EV's motor turns ~9 rev per metre of travel at these gear
 * ratios; close enough for a torque frame that only needs to look coupled to
 * the speed frame next to it.
 */
export function motorRpmFor(vehicle: Vehicle): number {
	return vehicle.speedKph * 78;
}

/** Motor torque in Nm: only a vehicle in D is actually pulling. */
export function motorTorqueNmFor(vehicle: Vehicle): number {
	return vehicle.gear === "D" ? 40 + vehicle.speedKph * 0.6 : 0;
}

/** VAL_ table for `GTW_carState` door fields: 0 = SNA, 1 = OPEN, 2 = CLOSED. */
const DOOR_OPEN = 1;
const DOOR_CLOSED = 2;

/**
 * `DI_speed`, id 599 (0x257): DI_vehicleSpeed at 12|12@1+, factor 0.08,
 * offset −40 km/h. This is the one frame encoded exactly per the public DBC —
 * see the module comment. raw = (kph + 40) / 0.08.
 */
export function encodeDiSpeed(timestamp: number, speedKph: number): CanFrame {
	const data: number[] = [];
	const raw = Math.max(0, Math.min(0xfff, Math.round((speedKph + 40) / 0.08)));
	setBitsLE(data, 12, 12, raw);
	return frame(timestamp, 599, data, "DI_speed");
}

/**
 * `DI_torque1`, id 262 (0x106): DI_torqueMotor at 0.25 Nm/bit signed, plus
 * DI_motorRPM. Real scalings; simplified little-endian placement (torque
 * 0|13@1−, RPM 16|16@1−).
 */
export function encodeDiTorque1(timestamp: number, torqueNm: number, motorRpm: number): CanFrame {
	const data: number[] = [];
	setBitsLE(data, 0, 13, toSignedRaw(torqueNm / 0.25, 13));
	setBitsLE(data, 16, 16, toSignedRaw(motorRpm, 16));
	return frame(timestamp, 262, data, "DI_torque1");
}

/**
 * `ESP_wheelSpeeds`, id 373 (0x175): four 13-bit wheel speeds at 0.04 km/h
 * per bit, packed FL 0|13, FR 13|13, RL 26|13, RR 39|13.
 */
export function encodeWheelSpeeds(timestamp: number, wheelsKph: [number, number, number, number]): CanFrame {
	const data: number[] = [];
	wheelsKph.forEach((kph, i) => {
		const raw = Math.max(0, Math.min(0x1fff, Math.round(kph / 0.04)));
		setBitsLE(data, i * 13, 13, raw);
	});
	return frame(timestamp, 373, data, "ESP_wheelSpeeds");
}

/**
 * `DI_systemStatus`, id 280 (0x118): DI_gear at 21|3@1+ with the VAL_ table
 * P=1 R=2 N=3 D=4 (0 = SNA).
 */
export function encodeDiSystemStatus(timestamp: number, gear: Vehicle["gear"]): CanFrame {
	const data: number[] = [];
	setBitsLE(data, 21, 3, GEAR_VALUES[gear]);
	return frame(timestamp, 280, data, "DI_systemStatus");
}

/**
 * `GTW_carState`, id 792 (0x318): door states as 2-bit fields at the DBC's
 * real (and irregular — note RR at 29, not 30) offsets: FL 12|2, FR 14|2,
 * RL 22|2, RR 29|2.
 */
export function encodeGtwCarState(timestamp: number, vehicle: Vehicle): CanFrame {
	const data: number[] = [];
	const doorRaw = (open: boolean) => (open ? DOOR_OPEN : DOOR_CLOSED);
	setBitsLE(data, 12, 2, doorRaw(vehicle.doors.FL.open));
	setBitsLE(data, 14, 2, doorRaw(vehicle.doors.FR.open));
	setBitsLE(data, 22, 2, doorRaw(vehicle.doors.RL.open));
	setBitsLE(data, 29, 2, doorRaw(vehicle.doors.RR.open));
	return frame(timestamp, 792, data, "GTW_carState");
}

/**
 * `BMS_socUI`: state of charge, 10|10@1+ at 0.1 %/bit.
 *
 * NOT from the public DBC — the community Model 3 DBC has no verified UI-SoC
 * signal, so this one only *follows* the BMS_* naming convention. The id
 * (0x292) sits in the BMS block of the real ID space to keep the stream's
 * sort order plausible.
 */
export function encodeBmsSocUi(timestamp: number, soc: number): CanFrame {
	const data: number[] = [];
	setBitsLE(data, 10, 10, Math.max(0, Math.min(1000, Math.round(soc * 10))));
	return frame(timestamp, 658, data, "BMS_socUI");
}

/**
 * Arbitration IDs for the filler traffic. Drawn from ranges the real bus
 * populates (chassis 0x0xx–0x1xx, gateway 0x2xx–0x3xx, body 0x4xx+) so the
 * noise interleaves believably with the signal frames when sorted or grepped.
 */
const FILLER_IDS = [
	0x082, 0x0a2, 0x0e5, 0x123, 0x132, 0x1d5, 0x1f9, 0x20c, 0x21c, 0x243,
	0x2a7, 0x2e1, 0x312, 0x321, 0x33a, 0x3b6, 0x3f5, 0x401, 0x43d, 0x4f7,
	0x528, 0x55b, 0x5d5, 0x612, 0x6f2, 0x711, 0x757
];

function fillerFrame(timestamp: number, random: () => number): CanFrame {
	const id = FILLER_IDS[Math.floor(random() * FILLER_IDS.length)]!;
	const dlc = 8;
	const data: number[] = [];
	for (let i = 0; i < dlc; i++) data.push(Math.floor(random() * 256));
	return { timestamp, id, dlc, data };
}

/**
 * Generate one tick's worth of bus traffic for `vehicle`.
 *
 * @param count      How many frames to emit; the clock derives this from the
 *                   elapsed time so the simulated bus rate is independent of
 *                   tick jitter.
 * @param fromMs/toMs  Timestamps are spread evenly across the tick interval
 *                   rather than all stamped "now" — a stream view rendering
 *                   arrival times from a batch stamped identically looks like
 *                   the bus hiccups 4 times a second.
 * @param random     Injectable RNG so tests can make the filler deterministic.
 *
 * Roughly 1 frame in 3 is signal-bearing (every 6th is DI_speed, every 6th
 * cycles the other encoders), so each signal repeats several times per second
 * at `count` ≈ 300 — often enough that a paused stream always has a decodable
 * frame on screen — while the remaining two-thirds stay noise.
 */
export function generateBusTraffic(
	vehicle: Vehicle,
	count: number,
	fromMs: number,
	toMs: number,
	random: () => number = Math.random
): CanFrame[] {
	const frames: CanFrame[] = [];
	const span = Math.max(1, toMs - fromMs);

	const motorRpm = motorRpmFor(vehicle);
	const torqueNm = motorTorqueNmFor(vehicle);

	for (let i = 0; i < count; i++) {
		const timestamp = fromMs + Math.floor((i / count) * span);
		switch (i % 6) {
			case 0:
				frames.push(encodeDiSpeed(timestamp, vehicle.speedKph));
				break;
			case 2: {
				const jitter = () => vehicle.speedKph + (random() - 0.5) * 0.4;
				switch (Math.floor(random() * 4)) {
					case 0:
						frames.push(encodeDiTorque1(timestamp, torqueNm, motorRpm));
						break;
					case 1:
						frames.push(encodeWheelSpeeds(timestamp, [jitter(), jitter(), jitter(), jitter()]));
						break;
					case 2:
						frames.push(encodeDiSystemStatus(timestamp, vehicle.gear));
						break;
					default:
						frames.push(
							random() < 0.5
								? encodeGtwCarState(timestamp, vehicle)
								: encodeBmsSocUi(timestamp, vehicle.charge.soc)
						);
				}
				break;
			}
			default:
				frames.push(fillerFrame(timestamp, random));
		}
	}
	return frames;
}

/** Undo `toSignedRaw`: interpret an unsigned raw field as two's complement. */
function fromSignedRaw(raw: number, bits: number): number {
	return raw >= 1 << (bits - 1) ? raw - (1 << bits) : raw;
}

/** VAL_ table inverse for `DI_gear`; index 0 is SNA (signal not available). */
const GEAR_NAMES = ["SNA", "P", "R", "N", "D"] as const;

/**
 * Decode a signal-bearing frame into the annotation the CAN terminal appends
 * after the hex bytes — e.g. `DI_speed  106.3 km/h`. Returns undefined for
 * filler frames (no label), which is what visually separates signal from
 * noise in the stream.
 *
 * This is the OTHER HALF of the encoders above and must live next to them:
 * the module comment warns that most frames here are packed little-endian
 * even where the public DBC says Motorola order, so any decoder that reaches
 * for a real DBC file instead of these helpers decodes garbage. Keeping
 * encode and decode in one file makes that drift a one-screen code review.
 */
export function decodeFrameAnnotation(canFrame: CanFrame): string | undefined {
	switch (canFrame.label) {
		case "DI_speed": {
			const kph = getBitsLE(canFrame.data, 12, 12) * 0.08 - 40;
			return `DI_speed  ${kph.toFixed(1)} km/h`;
		}
		case "DI_torque1": {
			const torque = fromSignedRaw(getBitsLE(canFrame.data, 0, 13), 13) * 0.25;
			const rpm = fromSignedRaw(getBitsLE(canFrame.data, 16, 16), 16);
			return `DI_torque1  ${torque.toFixed(0)} Nm  ${rpm} rpm`;
		}
		case "ESP_wheelSpeeds": {
			const wheels = [0, 1, 2, 3].map((i) => (getBitsLE(canFrame.data, i * 13, 13) * 0.04).toFixed(1));
			return `ESP_wheelSpeeds  FL ${wheels[0]}  FR ${wheels[1]}  RL ${wheels[2]}  RR ${wheels[3]}`;
		}
		case "DI_systemStatus": {
			const gear = GEAR_NAMES[getBitsLE(canFrame.data, 21, 3)] ?? "SNA";
			return `DI_gear  ${gear}`;
		}
		case "GTW_carState": {
			// 2-bit door fields at the DBC's irregular offsets (RR at 29).
			const doors: Array<[string, number]> = [["FL", 12], ["FR", 14], ["RL", 22], ["RR", 29]];
			const open = doors.filter(([, bit]) => getBitsLE(canFrame.data, bit, 2) === DOOR_OPEN).map(([name]) => name);
			return `GTW_carState  doors ${open.length === 0 ? "closed" : `ajar: ${open.join(" ")}`}`;
		}
		case "BMS_socUI": {
			const soc = getBitsLE(canFrame.data, 10, 10) * 0.1;
			return `BMS_socUI  ${soc.toFixed(1)} %`;
		}
		default:
			return undefined;
	}
}

/**
 * VAL_ table labels exactly as `fleet.dbc` writes them. The `can_signals`
 * block in `state.json` reports enumerated signals by label rather than raw
 * number, so a reader can match `"DI_gear": "DI_GEAR_D"` against the VAL_
 * line in the DBC without decoding anything by hand.
 */
const GEAR_VAL_LABELS = ["DI_GEAR_SNA", "DI_GEAR_P", "DI_GEAR_R", "DI_GEAR_N", "DI_GEAR_D"] as const;
const DOOR_VAL_LABELS = ["SNA", "OPEN", "CLOSED", "SNA"] as const;

/** Trim float noise to the precision the signal's own factor can express. */
const quantise = (value: number, decimals: number): number => Number(value.toFixed(decimals));

/**
 * The vehicle's live signal values, keyed by DBC signal name.
 *
 * This is deliberately computed by ENCODING each frame from the current
 * vehicle state and DECODING it straight back through the same helpers the
 * CAN terminal uses — not by reading the model's fields directly. Two reasons,
 * both load-bearing:
 *
 *   1. The values reported are the values that are actually on the wire,
 *      quantised by each signal's factor. `state.json` saying 103.0 km/h while
 *      every DI_speed frame decodes to 102.96 would be a lie told at one
 *      decimal place — precisely the kind a reader who decodes a paused frame
 *      by hand would catch.
 *   2. It cannot drift. If an encoder's bit layout changes, this block changes
 *      with it, because it goes through that encoder.
 *
 * Wheel speeds are reported without the per-frame jitter `generateBusTraffic`
 * adds: the jitter models four sensors disagreeing at the millisecond scale,
 * and a state snapshot that flickers in its third decimal every tick is noise,
 * not information.
 */
export function canSignalSnapshot(vehicle: Vehicle): Record<string, number | string> {
	const t = vehicle.lastUpdated;

	const speedFrame = encodeDiSpeed(t, vehicle.speedKph);
	const torqueFrame = encodeDiTorque1(t, motorTorqueNmFor(vehicle), motorRpmFor(vehicle));
	const wheelFrame = encodeWheelSpeeds(t, [
		vehicle.speedKph,
		vehicle.speedKph,
		vehicle.speedKph,
		vehicle.speedKph
	]);
	const gearFrame = encodeDiSystemStatus(t, vehicle.gear);
	const doorFrame = encodeGtwCarState(t, vehicle);
	const socFrame = encodeBmsSocUi(t, vehicle.charge.soc);

	const doorLabel = (startBit: number): string =>
		DOOR_VAL_LABELS[getBitsLE(doorFrame.data, startBit, 2)] ?? "SNA";

	return {
		DI_vehicleSpeed: quantise(getBitsLE(speedFrame.data, 12, 12) * 0.08 - 40, 2),
		DI_torqueMotor: quantise(fromSignedRaw(getBitsLE(torqueFrame.data, 0, 13), 13) * 0.25, 2),
		DI_motorRPM: fromSignedRaw(getBitsLE(torqueFrame.data, 16, 16), 16),
		DI_gear: GEAR_VAL_LABELS[getBitsLE(gearFrame.data, 21, 3)] ?? "DI_GEAR_SNA",
		ESP_wheelSpeedFrL: quantise(getBitsLE(wheelFrame.data, 0, 13) * 0.04, 2),
		ESP_wheelSpeedFrR: quantise(getBitsLE(wheelFrame.data, 13, 13) * 0.04, 2),
		ESP_wheelSpeedReL: quantise(getBitsLE(wheelFrame.data, 26, 13) * 0.04, 2),
		ESP_wheelSpeedReR: quantise(getBitsLE(wheelFrame.data, 39, 13) * 0.04, 2),
		DOOR_STATE_FL: doorLabel(12),
		DOOR_STATE_FR: doorLabel(14),
		DOOR_STATE_RL: doorLabel(22),
		DOOR_STATE_RR: doorLabel(29),
		BMS_socUI: quantise(getBitsLE(socFrame.data, 10, 10) * 0.1, 1)
	};
}
