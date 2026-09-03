/**
 * The extension host provides a `console`, but no DOM lib and no `@types/node`
 * are loaded here (see the note in tsconfig.json on why both are deliberately
 * excluded), so nothing declares it. Rather than widen `lib`/`types` — which
 * would also hand this code `document`, `window`, `fetch`, `fs` and `process`,
 * none of which exist in *both* the Node and Web Worker extension hosts — this
 * declares only the sliver that genuinely exists in both.
 */
declare const console: {
	log(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
};

/**
 * Timers exist in both extension hosts (and in Bun, where the selftest drives
 * the simulator), but with different return types: Node hands back a `Timeout`
 * object, the worker host a number. Declaring the handle as `unknown` is the
 * honest intersection — code can hold it and hand it back to `clearInterval`,
 * and nothing can accidentally do Node-only arithmetic or `.unref()` on it,
 * which would typecheck on the desktop and crash in the worker.
 */
declare function setInterval(handler: () => void, timeoutMs?: number): unknown;
declare function clearInterval(handle: unknown): void;
declare function setTimeout(handler: () => void, timeoutMs?: number): unknown;
declare function clearTimeout(handle: unknown): void;

/**
 * `TextEncoder` is a global in Node ≥ 11 and in every Web Worker, so the file
 * system provider can rely on it to turn serialized JSON into the `Uint8Array`
 * that `FileSystemProvider.readFile` must return. Declared here (rather than
 * pulling in the DOM lib) for the same reason as `console` above.
 */
declare class TextEncoder {
	readonly encoding: string;
	encode(input?: string): Uint8Array;
}
