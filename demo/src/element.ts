const IFRAME_SRC = "/fleet-demo/index.html";
const READY_TIMEOUT_MS = 60_000;

type DemoState = "poster" | "priming" | "launching" | "ready" | "error";

/**
 * <fleet-demo> — click-to-run VS Code embed.
 *
 * The consumer authors the poster in light DOM (a picture plus a
 * `[data-launch]` button, optionally `[data-poster]` wrapping the visual and
 * `[data-caption]` for the small-viewport note). The element enhances that
 * markup: it prefetches the workbench page when scrolled near, swaps in an
 * iframe on click, tracks boot progress messages from the iframe, and only
 * reveals the workbench once the extension's vehicle tree has really
 * rendered. Without JavaScript the poster is just a poster — nothing breaks.
 *
 * Once ready it also renders a thin chrome strip above the frame carrying a
 * "Reset demo" control — the reader's way back out of a tangled workbench
 * without knowing the command palette exists.
 *
 * State machine (reflected as `data-state` for CSS):
 *   poster → priming → launching → ready
 *                          ↘ error (timeout or iframe-reported) → retry → launching
 *
 * There is deliberately NO viewport gate. This used to refuse below 768px: the
 * poster stayed and the launch button rendered disabled — but still labelled
 * "Launch the demo". A disabled control whose label has not changed reads as
 * breakage, not as a limit; a reader on an iPhone tapped it, nothing happened,
 * and the honest conclusion from outside is that the software is broken. So the
 * gate is gone. The workbench IS genuinely hard to use at phone width — the
 * tree, editor and panel all fight over ~350px — and shipping that is the
 * informed trade: a cramped-but-real workbench a curious reader can poke at
 * beats a dead button that tells them no.
 */
export class FleetDemoElement extends HTMLElement {
	private launchButton: HTMLButtonElement | null = null;
	private iframe: HTMLIFrameElement | null = null;
	private progressBar: HTMLElement | null = null;
	private progressFill: HTMLElement | null = null;
	private errorNote: HTMLElement | null = null;
	private chrome: HTMLElement | null = null;
	private prefetchLink: HTMLLinkElement | null = null;
	private observer: IntersectionObserver | null = null;
	private abortController: AbortController | null = null;
	private readyTimeout: ReturnType<typeof setTimeout> | null = null;
	private listeners: Array<() => void> = [];
	private launched = false;

	connectedCallback() {
		const abortController = new AbortController();
		this.abortController = abortController;
		this.launchButton = this.querySelector<HTMLButtonElement>("[data-launch]");

		// Bound ONCE per connection, not per launch(). The error path offers a
		// retry that calls launch() again, so a per-launch registration would
		// stack a second listener on top of the first — and the first would
		// still pass its own guards, because that guard reads `this.iframe` at
		// event time and by then it points at the NEW frame. Every boot
		// message would be handled once per attempt (N retries → N+1 calls to
		// onReady()). That same lazy read is what lets one long-lived listener
		// serve whichever iframe launch() has most recently mounted.
		window.addEventListener("message", (event: MessageEvent) => this.onFrameMessage(event), {
			signal: abortController.signal
		});

		if (this.launchButton) {
			const onLaunch = () => this.launch();
			this.launchButton.addEventListener("click", onLaunch);
			this.listeners.push(() => this.launchButton?.removeEventListener("click", onLaunch));
		}

		// Prefetch the workbench page once the element scrolls near the viewport;
		// the browser pipelines the rest of the chunk graph on actual launch.
		this.observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) this.prime();
			},
			{ rootMargin: "200px" }
		);
		this.observer.observe(this);
	}

	disconnectedCallback() {
		this.abortController?.abort();
		this.abortController = null;
		this.observer?.disconnect();
		this.observer = null;
		if (this.readyTimeout !== null) clearTimeout(this.readyTimeout);
		this.readyTimeout = null;
		this.listeners.forEach((off) => off());
		this.listeners = [];
		this.iframe?.remove();
		this.iframe = null;
		this.progressBar?.remove();
		this.progressBar = null;
		this.progressFill = null;
		this.errorNote?.remove();
		this.errorNote = null;
		this.chrome?.remove();
		this.chrome = null;
		this.prefetchLink?.remove();
		this.prefetchLink = null;
		this.launched = false;
		this.removeAttribute("data-state");
	}

	private get state(): DemoState {
		return (this.getAttribute("data-state") as DemoState) ?? "poster";
	}

	private setState(state: DemoState) {
		this.setAttribute("data-state", state);
	}

	/** Near-viewport warmup: prefetch the iframe document, once. */
	private prime() {
		this.observer?.disconnect();
		this.observer = null;
		if (this.prefetchLink != null || this.launched) return;
		if (this.state === "poster") this.setState("priming");
		const link = document.createElement("link");
		link.rel = "prefetch";
		link.href = IFRAME_SRC;
		document.head.appendChild(link);
		this.prefetchLink = link;
	}

	private launch() {
		if (this.launched) return;
		this.launched = true;
		this.errorNote?.remove();
		this.errorNote = null;
		this.setState("launching");
		this.launchButton?.setAttribute("disabled", "");

		const iframe = document.createElement("iframe");
		iframe.src = IFRAME_SRC;
		iframe.title = "Fleet demo — VS Code";
		iframe.loading = "eager";
		iframe.allow = "clipboard-write";
		iframe.setAttribute("data-fleet-demo-frame", "");
		this.appendChild(iframe);
		this.iframe = iframe;

		this.mountProgressBar();

		this.readyTimeout = setTimeout(() => this.onError(), READY_TIMEOUT_MS);
	}

	/** Boot messages from the workbench iframe (bound in connectedCallback). */
	private onFrameMessage(event: MessageEvent) {
		// Source AND origin: the frame is same-origin by construction
		// (IFRAME_SRC is a site path), so anything arriving from elsewhere is
		// not the workbench and must not drive this element's state machine.
		// The source check also drops messages from a frame a previous,
		// failed launch left behind.
		if (event.origin !== window.location.origin) return;
		if (this.iframe == null || event.source !== this.iframe.contentWindow) return;
		const data = event.data as { type?: string; pct?: number; message?: string } | null;
		switch (data?.type) {
			case "fleet-demo:progress":
				this.setProgress(typeof data.pct === "number" ? data.pct : null);
				break;
			case "fleet-demo:ready":
				this.onReady();
				break;
			case "fleet-demo:error":
				this.onError();
				break;
		}
	}

	private mountProgressBar() {
		const bar = document.createElement("div");
		bar.className = "fleet-demo-progress";
		bar.setAttribute("role", "progressbar");
		bar.setAttribute("aria-label", "Starting VS Code");
		bar.setAttribute("aria-valuemin", "0");
		bar.setAttribute("aria-valuemax", "100");
		const fill = document.createElement("div");
		fill.className = "fleet-demo-progress-fill";
		bar.appendChild(fill);
		this.appendChild(bar);
		this.progressBar = bar;
		this.progressFill = fill;
		this.setProgress(5);
	}

	private setProgress(pct: number | null) {
		if (pct == null || this.progressFill == null || this.progressBar == null) return;
		const clamped = Math.max(0, Math.min(100, pct));
		this.progressFill.style.width = `${clamped}%`;
		this.progressBar.setAttribute("aria-valuenow", String(clamped));
	}

	private onReady() {
		if (this.readyTimeout !== null) clearTimeout(this.readyTimeout);
		this.readyTimeout = null;
		this.progressBar?.remove();
		this.progressBar = null;
		this.progressFill = null;
		this.mountChrome();
		this.setState("ready");
	}

	/**
	 * The reset affordance, rendered by the ELEMENT rather than inside the
	 * workbench.
	 *
	 * A reader can close every editor, hide the sidebar and flood the panel in
	 * about four clicks, and the way back — "Fleet: Reset Demo" — is behind a
	 * command palette they have no reason to know about. So the escape hatch
	 * lives in the host page, where it cannot itself be closed or hidden.
	 *
	 * It gets its own strip ABOVE the frame instead of floating over a corner
	 * of it. Every corner of a booted workbench is already a control surface:
	 * the status bar at the bottom (which a floating chip would read as part
	 * of), the editor group's action bar at the top right, the view title at
	 * the top left. A strip covers nothing and steals ~28px of a 16:10 box.
	 */
	private mountChrome() {
		if (this.chrome != null) return;
		const chrome = document.createElement("div");
		chrome.className = "fleet-demo-chrome";

		const reset = document.createElement("button");
		reset.type = "button";
		reset.className = "fleet-demo-reset";
		reset.textContent = "Reset demo";
		reset.setAttribute("data-reset", "");
		reset.title = "Re-seed the fleet and restore the demo layout";
		reset.addEventListener("click", () => this.requestReset(), {
			signal: this.abortController?.signal
		});

		chrome.appendChild(reset);
		this.appendChild(chrome);
		this.chrome = chrome;
	}

	/**
	 * Ask the workbench to reset itself, rather than reloading the iframe.
	 *
	 * A reload looks simpler and is worse: the workbench runs on the default
	 * BrowserStorageService (IndexedDB-backed — no `databaseFactories` are
	 * passed in workbench.ts), so part visibility and sizes SURVIVE a reload.
	 * A reader who hid the sidebar would reload straight back into the state
	 * they were trying to escape. The message path is also seconds faster: no
	 * re-parse of the 11 MB chunk, no second extension-host spin-up, and no
	 * second boot handshake for this element's state machine to sit through.
	 *
	 * Origin-pinned rather than "*": nothing about this message is public.
	 */
	private requestReset() {
		this.iframe?.contentWindow?.postMessage({ type: "fleet-demo:reset" }, window.location.origin);
	}

	private onError() {
		if (this.readyTimeout !== null) clearTimeout(this.readyTimeout);
		this.readyTimeout = null;
		this.launched = false;
		this.iframe?.remove();
		this.iframe = null;
		this.progressBar?.remove();
		this.progressBar = null;
		this.progressFill = null;
		this.chrome?.remove();
		this.chrome = null;
		this.setState("error");
		this.launchButton?.removeAttribute("disabled");

		if (this.errorNote == null) {
			const note = document.createElement("div");
			note.className = "fleet-demo-error";
			note.setAttribute("role", "alert");
			const text = document.createElement("span");
			text.textContent = "The demo didn’t start.";
			const retry = document.createElement("button");
			retry.type = "button";
			retry.textContent = "Try again";
			retry.setAttribute("data-retry", "");
			retry.addEventListener("click", () => this.launch(), {
				signal: this.abortController?.signal
			});
			note.append(text, retry);
			this.appendChild(note);
			this.errorNote = note;
		}
	}
}

if (!customElements.get("fleet-demo")) {
	customElements.define("fleet-demo", FleetDemoElement);
}
