/**
 * The controls editor's HTML, as a template string.
 *
 * A template string rather than a bundled asset because the webview is small
 * enough that a second build target (its own esbuild entry, its own tsconfig
 * realm, a media/ copy step) would cost more than it buys; the next unit can
 * graduate it if the panel grows. The trade-off accepted here: the script is
 * plain JS inside a string, so TypeScript does not check it. Keep it dumb —
 * receive state, render state, post intents — and keep every decision in the
 * extension host where the compiler can see it.
 *
 * Styling rule (hard): colors, fonts and borders come EXCLUSIVELY from
 * `--vscode-*` theme variables. The panel must look native in any theme the
 * host is running — including a high-contrast one — and a single hardcoded
 * hex value is the difference between "VS Code grew vehicle controls" and
 * "someone iframed their website into my editor". No site tokens, ever.
 *
 * Security: the CSP below allows exactly two things — inline styles from this
 * document and the one script tagged with the per-load nonce. No network, no
 * images, no frames. `state.json`-derived strings are inserted with
 * `textContent`, never `innerHTML`, so a vehicle name could contain markup
 * and it would render as text.
 */

export interface ControlsHtmlOptions {
	/** Per-load random nonce; must match the CSP's script-src. */
	nonce: string;
	/** `webview.cspSource` of the hosting panel. */
	cspSource: string;
}

export function buildControlsHtml(options: ControlsHtmlOptions): string {
	const { nonce, cspSource } = options;
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Vehicle Controls</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			margin: 0;
			padding: 16px 20px;
		}
		.header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
		.header h1 { font-size: 1.3em; font-weight: 600; margin: 0; }
		.vin {
			font-family: var(--vscode-editor-font-family);
			color: var(--vscode-descriptionForeground);
			font-size: 0.85em;
		}
		.badge {
			font-size: 0.75em;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			padding: 2px 8px;
			border-radius: 8px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
		}
		.section { margin-top: 20px; }
		.section h2 {
			font-size: 0.8em;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--vscode-descriptionForeground);
			margin: 0 0 8px;
		}
		.doors { display: grid; grid-template-columns: repeat(2, minmax(120px, 220px)); gap: 8px; }
		.door {
			border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
			background: var(--vscode-input-background);
			border-radius: 4px;
			padding: 10px 12px;
			display: flex;
			flex-direction: column;
			gap: 6px;
		}
		/* Asleep: dimmed, NOT disabled. The tile stays clickable so the click
		   reaches the command layer, gets the ASLEEP rejection, and the host
		   can offer "Wake Vehicle" — a greyed-out button would make that whole
		   path unreachable from this panel. */
		.door.asleep { opacity: 0.55; }
		.door .row { display: flex; justify-content: space-between; align-items: center; }
		.door .corner { font-weight: 600; }
		.door .status { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
		.door .status.ajar { color: var(--vscode-editorWarning-foreground); }
		button {
			font-family: inherit;
			font-size: 0.9em;
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
			border: 1px solid var(--vscode-button-border, transparent);
			border-radius: 2px;
			padding: 4px 10px;
			cursor: pointer;
		}
		button:hover { background: var(--vscode-button-hoverBackground); }
		button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
		button.secondary {
			color: var(--vscode-button-secondaryForeground);
			background: var(--vscode-button-secondaryBackground);
		}
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		/* In-flight command: the async layer's ~600–900 ms round trip needs a
		   visible pending state or the button reads as broken until the
		   result lands. Opacity rather than a spinner: theme-agnostic. */
		button:disabled { opacity: 0.45; cursor: default; }
		.charge-track {
			height: 10px;
			border-radius: 5px;
			background: var(--vscode-progressBar-background, var(--vscode-input-background));
			opacity: 0.25;
		}
		.charge-wrap { position: relative; max-width: 456px; }
		.charge-fill {
			position: absolute; top: 0; left: 0; height: 10px; border-radius: 5px;
			background: var(--vscode-charts-green);
			transition: width 0.4s ease;
		}
		.charge-fill.low { background: var(--vscode-charts-red); }
		.charge-label { margin-top: 6px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
		.gear-row { display: flex; gap: 6px; }
		.gear {
			width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
			border-radius: 4px; font-weight: 600;
			color: var(--vscode-descriptionForeground);
			border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
		}
		.gear.active {
			color: var(--vscode-list-activeSelectionForeground);
			background: var(--vscode-list-activeSelectionBackground);
			border-color: transparent;
		}
		.speed { display: flex; align-items: baseline; gap: 6px; }
		.speed .value {
			font-family: var(--vscode-editor-font-family);
			font-size: 2.2em;
			font-variant-numeric: tabular-nums;
		}
		.speed .unit { color: var(--vscode-descriptionForeground); }
		.offline { color: var(--vscode-descriptionForeground); font-style: italic; margin-top: 20px; }
	</style>
</head>
<body>
	<div class="header">
		<h1 id="title">—</h1>
		<span class="badge" id="personality">—</span>
		<span class="vin" id="vin"></span>
	</div>

	<div class="section">
		<h2>Doors</h2>
		<div class="doors" id="doors"></div>
	</div>

	<div class="section">
		<h2>Charge</h2>
		<div class="charge-wrap">
			<div class="charge-track"></div>
			<div class="charge-fill" id="chargeFill" style="width: 0%"></div>
		</div>
		<div class="charge-label" id="chargeLabel">—</div>
	</div>

	<div class="section">
		<h2>Drive</h2>
		<div class="gear-row" id="gearRow"></div>
		<div class="speed section">
			<span class="value" id="speed">0</span>
			<span class="unit">km/h</span>
		</div>
	</div>

	<!--
		NEXT UNIT: windows (per-corner sliders), alarm (honk/flash), the OTA
		firmware panel (fleet.installFirmwareUpdate already runs via the
		palette; this pane will surface its progress), and the map preview of
		drive_state. This section is reserved so the layout does not reflow
		when they land.
	-->
	<div class="section" id="futureControls"></div>

	<script nonce="${nonce}">
		(function () {
			const vscode = acquireVsCodeApi();
			const DOORS = ["FL", "FR", "RL", "RR"];
			const GEARS = ["P", "R", "N", "D"];

			// Doors with a command in flight. Session-local on purpose (NOT in
			// vscode.setState): a pending flag that survived a webview reload
			// would have no commandResult coming to ever clear it.
			const pendingDoors = {};

			// Build the static skeletons once; renders only update text/classes.
			const doorsEl = document.getElementById("doors");
			const doorEls = {};
			for (const id of DOORS) {
				const tile = document.createElement("div");
				tile.className = "door";
				const top = document.createElement("div");
				top.className = "row";
				const corner = document.createElement("span");
				corner.className = "corner";
				corner.textContent = id;
				const status = document.createElement("span");
				status.className = "status";
				top.append(corner, status);
				const bottom = document.createElement("div");
				bottom.className = "row";
				const lockLabel = document.createElement("span");
				lockLabel.className = "status";
				const button = document.createElement("button");
				button.addEventListener("click", () => {
					if (pendingDoors[id]) return;
					const state = vscode.getState();
					const locked = state && state.doors ? state.doors[id].locked : false;
					// Busy until the host's commandResult for this door comes back;
					// the ~1 s round trip is the async command layer's simulated
					// latency, and an un-disabled button invites double-sends.
					pendingDoors[id] = true;
					button.disabled = true;
					button.textContent = "…";
					vscode.postMessage({ type: "setDoorLock", door: id, locked: !locked });
				});
				bottom.append(lockLabel, button);
				tile.append(top, bottom);
				doorsEl.append(tile);
				doorEls[id] = { tile, status, lockLabel, button };
			}

			const gearRow = document.getElementById("gearRow");
			const gearEls = {};
			for (const gear of GEARS) {
				const el = document.createElement("div");
				el.className = "gear";
				el.textContent = gear;
				gearRow.append(el);
				gearEls[gear] = el;
			}

			function render(state) {
				// Cache in webview state: with retainContextWhenHidden the DOM
				// survives tab switches, but this also gives the lock buttons a
				// current-state source without a DOM read.
				vscode.setState(state);

				document.getElementById("title").textContent = state.title;
				document.getElementById("vin").textContent = state.vin;
				document.getElementById("personality").textContent = state.personality;

				for (const id of DOORS) {
					const door = state.doors[id];
					const els = doorEls[id];
					els.status.textContent = door.open ? "ajar" : "closed";
					els.status.classList.toggle("ajar", door.open);
					els.lockLabel.textContent = door.locked ? "locked" : "unlocked";
					if (pendingDoors[id]) {
						// A state push can land mid-command (the simulator ticks 4×/s);
						// the tile stays busy until its own commandResult clears it.
						els.button.textContent = "…";
						els.button.disabled = true;
					} else {
						els.button.textContent = door.locked ? "Unlock" : "Lock";
						// Only a command in flight disables a button. An asleep
						// vehicle is a REJECTION, not a missing affordance: the
						// press is what surfaces "Command rejected: ASLEEP" and
						// the Wake Vehicle offer, and after a successful wake the
						// panel snaps live off the host's next state push.
						els.button.disabled = false;
					}
					els.tile.classList.toggle("asleep", !state.online);
					els.button.classList.toggle("secondary", door.locked);
				}

				const fill = document.getElementById("chargeFill");
				fill.style.width = Math.max(0, Math.min(100, state.charge.soc)) + "%";
				fill.classList.toggle("low", state.charge.soc < 15);
				const socText = state.charge.soc.toFixed(0) + "%";
				document.getElementById("chargeLabel").textContent = state.charge.charging
					? socText + " · charging at " + state.charge.powerKw + " kW"
					: socText + " · " + state.charge.rangeKm + " km range";

				for (const gear of GEARS) {
					gearEls[gear].classList.toggle("active", state.gear === gear);
				}
				document.getElementById("speed").textContent = String(Math.round(state.speedKph));
			}

			window.addEventListener("message", (event) => {
				const message = event.data;
				if (message && message.type === "state") {
					render(message.state);
				}
				if (message && message.type === "commandResult") {
					// Success or rejection, the busy state ends here. The rejection
					// reason is deliberately NOT rendered in-panel — the host
					// already toasted it, and re-render from cache snaps the button
					// back to the (unchanged, on rejection) truth.
					delete pendingDoors[message.door];
					const cachedState = vscode.getState();
					if (cachedState) render(cachedState);
				}
			});

			// Re-render from cache immediately (tab restore), then ask the
			// extension for fresh state.
			const cached = vscode.getState();
			if (cached) render(cached);
			vscode.postMessage({ type: "ready" });
		})();
	</script>
</body>
</html>`;
}
