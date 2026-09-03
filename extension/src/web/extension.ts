import type * as vscode from "vscode";
import { activateCommon, deactivateCommon } from "../common/extension";

/**
 * Web Worker entry point — the file named by `browser` in package.json, loaded
 * by vscode.dev and by the monaco-vscode-api embed.
 *
 * The mirror image of src/node/extension.ts, and equally thin for the same
 * reason. Note that this host has no file system, no child processes and no
 * `require` of Node builtins; the esbuild `platform: "browser"` build is what
 * catches a violation at build time rather than as an extension that never
 * activates in the browser.
 */
export function activate(context: vscode.ExtensionContext): void {
	activateCommon(context);
}

export function deactivate(): void {
	deactivateCommon();
}
