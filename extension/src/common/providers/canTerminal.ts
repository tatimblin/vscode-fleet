import * as vscode from "vscode";
import type { FleetSimulator } from "../sim/clock";
import type { CanFrame } from "../model/types";
import { decodeFrameAnnotation } from "../sim/can";
import { vinTail } from "../model/vin";

/**
 * The CAN stream terminal: `fleet.openCanStream` opens a `Pseudoterminal`
 * in the panel that renders the simulator's ring buffer candump-style, with
 * a live decode annotation on the signal-bearing frames.
 *
 * Why a terminal and not a webview or output channel: the terminal is the
 * surface a CAN stream *belongs* on — monospace, ANSI colour, scrollback,
 * find-in-terminal all come free, and `candump` output in a VS Code panel is
 * instantly legible to anyone who has ever pointed candump at real hardware.
 * An output channel strips the colour; a webview reimplements scrollback
 * badly.
 *
 * Three rates, deliberately decoupled:
 *
 *   bus rate      (~1,200 frames/s)  what the simulator generates;
 *   drain rate    (~30 Hz)           how often we empty the ring buffer;
 *   display rate  (`fleet.canDisplayRate` lines/s, default 10)
 *                                    how many lines actually render.
 *
 * The drain must keep pace with the bus or the ring buffer permanently sits
 * at its drop-oldest cap; the display must NOT keep pace with the bus or the
 * terminal is an unreadable blur. So each drain takes everything and renders
 * a sampled subset — which is also what real candump users do with a filter,
 * and why the header admits the sampling instead of hiding it.
 */

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[;H";

/** Drain cadence. ~30 Hz is fast enough that the buffer never approaches its
 * 4,096 cap (40 frames/drain at the simulated rate) and slow enough that the
 * one `writeEmitter.fire` per drain stays a trivial ext-host RPC load. */
const DRAIN_INTERVAL_MS = 33;

/** Frame filter modes `f` cycles through. "annotated" hides the filler noise
 * so only decodable signal frames scroll — the closest useful analogue to
 * candump's ID filters without a prompt breaking the stream. */
type FilterMode = "all" | "annotated";

class CanStreamPty implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<void>();
	readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
	readonly onDidClose: vscode.Event<void> = this.closeEmitter.event;

	/**
	 * Output queued before `open()`. VS Code silently DROPS anything fired on
	 * `onDidWrite` before it calls `open()` — the terminal's renderer does not
	 * exist yet — so everything goes through `write()`, which buffers until
	 * open and flushes then. (Post-open writes while the panel is collapsed
	 * are fine: VS Code buffers those itself.)
	 */
	private pending: string[] = [];
	private opened = false;

	private intervalHandle: unknown = null;
	private paused = false;
	private filter: FilterMode = "all";

	/** Displayed lines/s, live from `fleet.canDisplayRate`. */
	private displayRate: number;
	/** Fractional line budget carried between drains — at 10 lines/s and a
	 * 33 ms drain each pass earns 0.33 of a line, so the remainder must
	 * accumulate or a low rate would round to zero lines forever. */
	private lineBudget = 0;
	private lastDrainMs = 0;

	private readonly configSubscription: vscode.Disposable;

	constructor(
		private readonly simulator: FleetSimulator,
		private readonly vehicleName: string
	) {
		this.displayRate = readDisplayRate();
		this.configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("fleet.canDisplayRate")) {
				this.displayRate = readDisplayRate();
			}
		});
	}

	open(): void {
		// May fire with the panel collapsed; also fine — see `pending`.
		this.opened = true;
		const queued = this.pending;
		this.pending = [];
		for (const text of queued) this.writeEmitter.fire(text);

		this.write(
			`${DIM}interface can0 · bitrate 500000 · ${this.vehicleName} · sampled at ${this.displayRate} lines/s · ` +
				`p pause · f filter · c clear · q quit${RESET}\r\n\r\n`
		);

		this.lastDrainMs = Date.now();
		this.intervalHandle = setInterval(() => this.drain(), DRAIN_INTERVAL_MS);
	}

	close(): void {
		// Called by VS Code when the terminal is disposed (user closes the tab,
		// the manager retargets, or the window shuts down). The interval MUST
		// die here: a leaked 30 Hz drain keeps draining the simulator's buffer
		// out from under a successor terminal — and keeps a web worker alive.
		this.stop();
	}

	dispose(): void {
		this.stop();
		this.writeEmitter.dispose();
		this.closeEmitter.dispose();
	}

	handleInput(data: string): void {
		for (const char of data) {
			switch (char) {
				case "p":
					this.paused = !this.paused;
					this.write(`\r\n${YELLOW}-- ${this.paused ? "PAUSED" : "RESUMED"} --${RESET}\r\n`);
					break;
				case "f":
					this.filter = this.filter === "all" ? "annotated" : "all";
					this.write(
						`\r\n${YELLOW}-- FILTER: ${this.filter === "annotated" ? "annotated frames only" : "off"} --${RESET}\r\n`
					);
					break;
				case "c":
					this.write(CLEAR_SCREEN);
					break;
				case "q":
				case "\x03": // Ctrl+C
					this.closeEmitter.fire();
					break;
			}
		}
	}

	private stop(): void {
		if (this.intervalHandle !== null) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = null;
		}
		this.configSubscription.dispose();
	}

	/** Buffer-or-fire — the only way output leaves this class. */
	private write(text: string): void {
		if (this.opened) {
			this.writeEmitter.fire(text);
		} else {
			this.pending.push(text);
		}
	}

	private drain(): void {
		const now = Date.now();
		const elapsed = now - this.lastDrainMs;
		this.lastDrainMs = now;

		// Always drain, even paused: pause freezes the DISPLAY, not the bus.
		// Leaving frames in the ring while paused would replay a burst of
		// stale traffic on resume instead of the present.
		const frames = this.simulator.drainFrames(2048);
		if (this.paused) return;

		// Earn display budget from real elapsed time, capped at one second's
		// worth so a hidden panel does not bank minutes of allowance and dump
		// it as a wall of lines on reveal.
		this.lineBudget = Math.min(this.displayRate, this.lineBudget + (this.displayRate * elapsed) / 1000);

		const candidates = this.filter === "annotated" ? frames.filter((f) => f.label !== undefined) : frames;
		const lines = Math.min(Math.floor(this.lineBudget), candidates.length);
		if (lines === 0) return;
		this.lineBudget -= lines;

		// Sample evenly across the batch rather than taking the head: the
		// rendered subset should span the whole interval, or the displayed
		// timestamps bunch up and the stream looks like it stutters.
		let out = "";
		for (let i = 0; i < lines; i++) {
			const pick = candidates[Math.floor((i * candidates.length) / lines)];
			if (pick) out += formatFrame(pick);
		}
		// ONE fire per drain batch. Every fire crosses the extension-host RPC
		// boundary to the renderer; per-frame fires at bus rate would be
		// thousands of RPCs a second for the same pixels.
		this.writeEmitter.fire(out);
	}
}

/**
 * One candump-flavoured line:
 *
 *   (1756857600.123456)  can0  257  [8]  4F 33 00 00 00 00 00 00  · DI_speed  106.3 km/h
 *
 * Timestamp dim (it is context, not content), arbitration ID cyan (it is the
 * thing a bus-watcher's eye scans for), annotation only on signal-bearing
 * frames — the unannotated majority is what makes the annotated minority
 * pop. Fault-flavoured annotations render red; the generator does not emit
 * them today, but the path exists so streaming a faulted vehicle's DTC
 * traffic (a future unit) needs no formatter change.
 */
function formatFrame(f: CanFrame): string {
	// Frame timestamps are whole milliseconds; real candump shows microseconds.
	// Derive the sub-ms digits from the frame identity — deterministic, so a
	// re-render shows the same value — because ".000" three columns deep in
	// every line is the kind of tell this whole extension exists to avoid.
	const micros = (f.id * 7919 + f.timestamp) % 1000;
	const seconds = Math.floor(f.timestamp / 1000);
	const fraction = `${String(f.timestamp % 1000).padStart(3, "0")}${String(micros).padStart(3, "0")}`;

	const id = f.id.toString(16).toUpperCase().padStart(3, "0");
	const bytes = f.data.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

	let line = `${DIM}(${seconds}.${fraction})${RESET}  can0  ${CYAN}${id}${RESET}  [${f.dlc}]  ${bytes}`;

	const annotation = decodeFrameAnnotation(f);
	if (annotation !== undefined) {
		const colour = isFaultAnnotation(f) ? RED : "";
		line += `  ${DIM}·${RESET}  ${colour}${annotation}${colour ? RESET : ""}`;
	}
	return line + "\r\n";
}

/** Fault frames (none generated yet — see formatFrame) render red. */
function isFaultAnnotation(f: CanFrame): boolean {
	return f.label !== undefined && (f.label.startsWith("DTC") || f.label.includes("fault"));
}

function readDisplayRate(): number {
	const rate = vscode.workspace.getConfiguration("fleet").get<number>("canDisplayRate", 10);
	// Clamp: 0 or negative would starve the stream silently, and a huge value
	// re-creates the unreadable-blur problem the setting exists to solve.
	return Math.max(1, Math.min(120, rate));
}

/**
 * Owns at most ONE CAN terminal at a time, because the simulator owns at
 * most one bus: `drainFrames` is destructive, so two terminals draining the
 * same ring would each see half the traffic, interleaved arbitrarily.
 *
 *   same vehicle again → reveal the existing terminal;
 *   different vehicle  → retarget the simulator's bus (flushing the ring —
 *                        see `setBusTarget`), dispose the old terminal, open
 *                        a fresh one.
 */
export class CanStreamManager implements vscode.Disposable {
	private current: { vin: string; terminal: vscode.Terminal } | null = null;
	private readonly closeSubscription: vscode.Disposable;

	constructor(private readonly simulator: FleetSimulator) {
		this.closeSubscription = vscode.window.onDidCloseTerminal((terminal) => {
			// User closed it (or `q` fired the close emitter): forget it, so the
			// next openCanStream builds a fresh one instead of revealing a corpse.
			if (this.current?.terminal === terminal) {
				this.current = null;
			}
		});
	}

	/** Open (or reveal) the stream for `vin`, defaulting to the current bus. */
	open(vin?: string): void {
		const target = vin ?? this.simulator.getBusTargetVin();
		const vehicle = target !== undefined ? this.simulator.getVehicle(target) : undefined;
		if (!vehicle) return;

		if (this.current?.vin === vehicle.vin) {
			this.current.terminal.show();
			return;
		}

		this.current?.terminal.dispose();
		this.simulator.setBusTarget(vehicle.vin);

		const pty = new CanStreamPty(this.simulator, vinTail(vehicle.vin));
		const terminal = vscode.window.createTerminal({
			// Tab titles are the tightest surface in the window, so the VIN tail
			// rather than all 17 characters.
			name: `CAN · ${vinTail(vehicle.vin)}`,
			pty,
			iconPath: new vscode.ThemeIcon("pulse"),
			location: vscode.TerminalLocation.Panel,
			// Transient: a pseudoterminal cannot be revived by process
			// reconnection, so persisting it across a window reload would
			// restore a dead pane with stale scrollback.
			isTransient: true
		});
		this.current = { vin: vehicle.vin, terminal };
		terminal.show();
	}

	dispose(): void {
		this.closeSubscription.dispose();
		this.current?.terminal.dispose();
		this.current = null;
	}
}
