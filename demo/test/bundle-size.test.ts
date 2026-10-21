import { expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The built embed has not quietly doubled in size. Reads what `bun run build`
 * just wrote to demo/dist, so it needs no browser and no server.
 *
 * The guard is not about page weight in the abstract — it is about a specific,
 * easy mistake. workbench.ts leaves several monaco-vscode-api service overrides
 * OUT on purpose (views-service-override corrupts the grid; see its comment).
 * Adding one back pulls in a large slice of VS Code, and the only symptom is
 * that the demo takes longer to start on a connection nobody testing it has.
 */
const root = fileURLToPath(new URL("../dist", import.meta.url));

test("the built embed has not quietly doubled in size", () => {
	expect(existsSync(join(root, "index.html")), "demo/dist is missing — run `bun run build` first").toBe(true);

	let total = 0;
	let largestJs = 0;
	let largestJsName = "";
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			const { size } = statSync(path);
			total += size;
			if (entry.name.endsWith(".js") && size > largestJs) {
				largestJs = size;
				largestJsName = entry.name;
			}
		}
	};
	walk(root);

	const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

	// Headroom over today's ~15 MB total / ~11.1 MB main chunk: enough that honest
	// growth does not trip it, tight enough that a re-added override does.
	expect(total, `demo/dist is ${mb(total)} MB`).toBeLessThanOrEqual(25 * 1024 * 1024);
	expect(
		largestJs,
		`${largestJsName} is ${mb(largestJs)} MB — did a service override come back?`
	).toBeLessThanOrEqual(13 * 1024 * 1024);
});
