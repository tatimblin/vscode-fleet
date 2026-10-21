# vscode-fleet

Real VS Code in a browser tab, running a mocked EV fleet-management extension.
It's the embed in the post
[No honey, we have a dashboard at home](https://tristantimblin.dev/txt/no-honey-we-have-a-dashboard-at-home/).

| Folder | What it is |
|---|---|
| [`extension/`](extension/README.md) | The VS Code extension: a virtual file system of vehicles, a tree view, a controls webview and a CAN-bus terminal. Its node and web bundles are built with esbuild. It's demo-only and isn't on the Marketplace. |
| [`demo/`](demo/README.md) | `@tristimb/fleet-demo`: a standalone workbench page built on [monaco-vscode-api](https://github.com/CodinGame/monaco-vscode-api) that runs the extension's built web bundle, plus the `<fleet-demo>` element (a poster with a launch button that opens the page in an iframe). |

## Build, test and dev

```sh
bun install
bun run build         # extension build:web, then the demo's vite build into demo/dist
bun run test          # the extension's model selftest and the demo's bundle-size guard (run build first)
bun run check-types
bun run dev           # extension build:web, then vite dev at http://localhost:5173/fleet-demo/
```

The workbench page is built for `base: "/fleet-demo/"`, so a host must serve
`demo/dist` at `/fleet-demo/`. The `<fleet-demo>` element loads
`/fleet-demo/index.html` from the same origin and listens for its
`fleet-demo:*` boot messages.

Two pitfalls fail silently (details in [`demo/README.md`](demo/README.md)):

- Every `@codingame/*` dependency is pinned to exactly `36.2.7`. A `^` on any one of them loads two copies of the core, and the workbench never boots.
- Never add `views-service-override` next to `workbench-service-override`. The grid corrupts and the editor collapses to 0px, with no error.

## Using it from a site

There's no npm publish. Each version is a GitHub Release with the packed
tarball attached:

```json
"@tristimb/fleet-demo": "https://github.com/tatimblin/vscode-fleet/releases/download/v0.1.0/tristimb-fleet-demo-0.1.0.tgz"
```

The tarball holds:

- `dist/`, the built workbench page. Copy it to your site's `public/fleet-demo/`.
- `src/element.ts` and `src/element.css`, exported as `@tristimb/fleet-demo` and `@tristimb/fleet-demo/element.css`. They're TypeScript source, so the site's bundler compiles them.

The monaco packages are `devDependencies`, so installing the tarball pulls in no
dependencies.

## Release

```sh
bun run release 0.2.0 --dry-run   # bump, install, build, test, pack; no git changes
bun run release 0.2.0             # then commit, tag v0.2.0, push and gh release create
```

[`scripts/release.ts`](scripts/release.ts) runs locally. It needs bun, npm, git
and an authenticated `gh`. It does these steps in order:

1. Sets `demo/package.json`'s version.
2. Runs `bun install --frozen-lockfile`, `build` and `test`.
3. Runs `npm pack` in `demo/`.
4. Commits, tags and pushes.
5. Attaches `tristimb-fleet-demo-<version>.tgz` to a new release.

After that, bump the tarball URL in the consuming site.

CI (`.github/workflows/ci.yml`) runs install, type-check, build, test and pack
on pushes and PRs. It also uploads the tarball as an artifact. It doesn't
release anything.

## License

MIT
