# @tristimb/fleet-demo

The browser embed that boots **real VS Code** (via
[monaco-vscode-api](https://github.com/CodinGame/monaco-vscode-api)) with the
fleet extension from [`../extension`](../extension/README.md) installed, for the
blog post.

Two deliverables live here:

1. **The workbench page** (`index.html` + `src/workbench.ts` +
   `src/extension-host.ts`) — a standalone page built to `dist/` (for
   `base: "/fleet-demo/"`) and loaded in an iframe. It initializes the VS Code
   workbench, registers the fleet extension's real manifest, and runs the
   extension's real web bundle.
2. **The `<fleet-demo>` custom element** (`src/element.ts` + `src/element.css`)
   — the host-page poster/launch wrapper the blog post uses. Poster → prefetch
   when scrolled near → iframe on click → progress bar → reveal when the
   vehicle tree has rendered. It launches at **any** viewport width: below
   768px the frame goes portrait (`aspect-ratio: 3 / 4`, capped at `80svh`) and
   the caption warns that it will be tight. A workbench on a phone is genuinely
   cramped — but a disabled button labelled "Launch the demo" reads as broken
   software, which is worse.

## What the package ships

`npm pack` (see the root README's release steps) produces a tarball with
`dist/` plus `src/element.ts` / `src/element.css`, exported as
`@tristimb/fleet-demo` and `@tristimb/fleet-demo/element.css`. Every monaco
package is a **devDependency**: the consumer gets the prebuilt page and never
installs or bundles monaco-vscode-api itself. That separation is the point —
monaco-vscode-api needs its own Vite pipeline (CSS-as-string resolution,
ES-module workers, `esnext` target, a dedicated dependency graph) that must not
leak into, or inherit from, the host site's bundler. The host copies `dist/` to
its own `/fleet-demo/` and imports only the element.

```
bun run build   # from the repo root:
                #   1. extension  build:web
                #   2. demo       build  → demo/dist
```

### Why `build` is `bunx --bun vite build` and not plain `vite build`

Do not "simplify" this back to `vite build`. This package's Vite requires node
20.19+, and plain `vite build` resolves through node's shebang to whatever
system node the machine has — on an old Netlify deploy-preview image, node 16,
where it died with `ReferenceError: CustomEvent is not defined` before printing
anything useful. Running Vite under Bun's runtime makes the build independent
of whatever node the CI image happens to ship.

`dev` deliberately stays plain `vite` — the `--bun` runtime is for the
non-interactive build only.

## Pinned versions — do not loosen

All `@codingame/*` packages are pinned to **exactly `36.2.7`** (upstream
commit `2702503b`), with these aliases:

```json
"vscode": "npm:@codingame/monaco-vscode-extension-api@36.2.7",
"monaco-editor": "npm:@codingame/monaco-vscode-editor-api@36.2.7"
```

The monaco-vscode-api service-override packages are lockstep-versioned; a `^`
range letting any one of them drift produces two copies of the core and an
unbootable workbench.

### The views-override trap

**Never install or import `@codingame/monaco-vscode-views-service-override`
alongside `workbench-service-override`.** The combination silently corrupts
the workbench grid: the editor area collapses to 0px and the panel refuses to
open, with no error anywhere. Workbench only; webview support arrives
transitively via `view-common`.

`test/bundle-size.test.ts` guards the symptom: re-adding an override pushes the
main chunk past its 13 MB ceiling.

## The extension bridge

`src/extension-host.ts` registers the extension's **verbatim manifest**
(imported from `extension/package.json` at build time, minus
`main`/`browser` — there is no file for the worker host to load) and then
evaluates the extension's **built web bundle**
(`extension/dist/web/extension.js`, imported `?raw`) inside a
hand-made CommonJS scope whose `require("vscode")` returns the
`registerExtension(...).getApi()` object. The embed therefore runs the exact
artifact `vsce` would package — the demo cannot drift from the .vsix.

Walkthrough media and the activity-bar icon are re-registered with
`registerFileUrl` against the hashed asset URLs Vite emits.

### Known limitation: no walkthrough in the embed

monaco-vscode-api 36.2.7 stubs the walkthroughs extension point — the
`walkthroughsExtensionPoint.setHandler` body in its gettingStartedService is
a no-op and `registerExtensionWalkthroughContributions` has no callers — so
the manifest's `contributes.walkthroughs` can never surface inside the embed
(adding `walkthrough-service-override` only brings VS Code's own generic
walkthroughs, +4 MB and a console error). The walkthrough still works in real
VS Code and `vscode-test-web`; the embed opens the in-memory `README.md`
instead as its landing editor.

## Dev workflow

The `?raw` import reads the extension's *built* bundle, so build it first
(`bun run dev` at the root does both):

```
bun run --cwd extension build:web
bun run --cwd demo dev       # vite dev at http://localhost:5173/fleet-demo/
```

After `bun run build`, `bun run --cwd demo preview` serves the production build
at `http://localhost:4173/fleet-demo/`.

The end-to-end boot tests (Playwright against the post that embeds the
element) live with the consuming site, in its `tests/fleet-demo.spec.ts`.
