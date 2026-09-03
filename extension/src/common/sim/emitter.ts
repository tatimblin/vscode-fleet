/**
 * A minimal typed event emitter, shaped like `vscode.EventEmitter` on purpose.
 *
 * Why not just use `vscode.EventEmitter`: everything under `src/common/sim/`
 * and `src/common/model/` must stay importable *outside* an extension host —
 * the Bun selftest drives the simulator directly, and the moment any file in
 * that graph does `import * as vscode from "vscode"` the import fails at
 * module-load time (there is no `vscode` module on Bun's resolution path) and
 * the entire pure-logic test surface disappears. The failure would not even be
 * a test failure; it would be the tests becoming unrunnable, which reads like
 * tooling breakage rather than the architectural regression it actually is.
 *
 * The API mirrors vscode's (`event(listener) => Disposable`, `fire(value)`),
 * so provider code that bridges a sim event into a vscode event does it in one
 * line and nobody has to context-switch between two subscription idioms.
 */

/** Structural match for `vscode.Disposable` — no import required. */
export interface Disposable {
	dispose(): void;
}

export type Listener<T> = (value: T) => void;

export class Emitter<T> {
	private listeners = new Set<Listener<T>>();
	private disposed = false;

	/**
	 * Subscribe. Bound as an arrow function so it can be handed around detached
	 * (`sim.onVehicleChanged` is exposed as `emitter.event`) without losing
	 * `this` — the classic bug where a detached method subscribes listeners onto
	 * `undefined` and every event silently reaches nobody.
	 */
	readonly event = (listener: Listener<T>): Disposable => {
		if (this.disposed) return { dispose: () => {} };
		this.listeners.add(listener);
		return {
			dispose: () => {
				this.listeners.delete(listener);
			}
		};
	};

	fire(value: T): void {
		if (this.disposed) return;
		// Snapshot before iterating: a listener that disposes its own
		// subscription (or subscribes a new one) while handling an event must not
		// mutate the collection mid-iteration.
		for (const listener of [...this.listeners]) {
			listener(value);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
	}
}
