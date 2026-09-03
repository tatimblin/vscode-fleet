import type * as vscode from "vscode";
import { activateCommon, deactivateCommon } from "../common/extension";

/**
 * Desktop entry point — the file named by `main` in package.json.
 *
 * It is deliberately a two-line wrapper. Any logic that lands here is logic the
 * web build (src/web/extension.ts) does not get, and the failure mode is a
 * feature that works on the desktop and is silently missing in the blog post's
 * embedded editor. If something needs Node specifically, it belongs behind an
 * interface passed *into* `activateCommon`, not inlined here.
 */
export function activate(context: vscode.ExtensionContext): void {
	activateCommon(context);
}

export function deactivate(): void {
	deactivateCommon();
}
