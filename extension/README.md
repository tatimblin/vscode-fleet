# fleet-extension

A mocked EV fleet-management VS Code extension: a virtual file system of
vehicles, a fleet explorer, live vehicle controls, and a CAN bus stream. It
ships as a real extension (F5-debuggable) **and** as a web build embedded in a
blog post through `monaco-vscode-api`, which is why every entry point exists
twice.

Nothing here talks to a real vehicle. The fleet is seeded in
`src/common/model/fleet.ts` and driven by a simulator.

## This package has a build step

The `@whois/*` workspace packages in `packages/*` have **no build step** — they
export TypeScript source directly and Astro/Vite compiles it as part of the site
build.

**This package deliberately breaks that convention** (and so does the workbench
page in `packages/vscode-fleet-demo`, which consumes it). VS Code does not compile
extensions: the extension host `require()`s a single JavaScript file named by
`main` (desktop) or `browser` (web worker), so the extension has to arrive
pre-bundled. There is no bundler in the loop to fix it up. It is also not named
`@whois/*` and is not a dependency of the site — the site loads its *built
output* (`dist/web/extension.js`, imported `?raw` by
`packages/vscode-fleet-demo`), not its source.

## Layout

```
src/common/    everything real, host-agnostic; the only code that grows
src/common/model/  pure data: types, VIN math, the seeded fleet (no vscode import)
src/node/      desktop entry — wraps activateCommon
src/web/       web worker entry — wraps activateCommon
```

`src/common/model/` imports nothing from `vscode`, so it can be exercised by
`bun scripts/selftest.ts` without an extension host and imported by the webview
bundle without dragging the host API into a browser realm.

## Develop

```sh
bun install                                    # from the repo root (workspaces)
bun run --cwd packages/fleet-extension build   # node + web bundles into dist/
bun run --cwd packages/fleet-extension build:web
bun run --cwd packages/fleet-extension watch   # rebuild on change
bun run --cwd packages/fleet-extension check-types
bun run --cwd packages/fleet-extension selftest
```

### F5 in VS Code

1. `bun run --cwd packages/fleet-extension build` (or leave `watch` running).
2. Open `packages/fleet-extension` as the workspace folder in VS Code.
3. Press <kbd>F5</kbd> to launch an Extension Development Host with this
   extension loaded from `dist/`.
4. In the new window, run **Fleet: Reset Demo** from the Command Palette, or
   open the Fleet view in the activity bar.

The extension declares `onFileSystem:fleet` in `activationEvents` explicitly
rather than relying on the implicit activation VS Code infers from
`contributes`: a virtual workspace opened at a `fleet:` URI must activate the
extension *before* anything tries to read a file from it, and inferred
activation does not fire early enough for that.

To debug the web build instead, run `vscode-test-web` (`bunx @vscode/test-web`;
not a dependency of the repo) against `dist/web`.

## Build flags

`esbuild.mjs` emits both bundles as **CommonJS** with `vscode` marked
**external** — the host injects the `vscode` module at load time and reads
`module.exports.activate`, so an ESM bundle activates nothing and a bundled
`vscode` fails to resolve. The web bundle is built with `platform: "browser"`,
which makes an accidental `fs`/`path` import a loud build failure instead of an
extension that never appears in the browser.
