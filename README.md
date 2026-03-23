# Plexus

CLI and a small web UI to inspect **direct dependencies** from a `package.json`: peer dependency ranges vs what is installed, optional **BundlePhobia**-style bundle size hints, and a **`--fix`** mode that queries npm for upgrade and cascade notes.

Requires **Node.js 18+** (uses the built-in `fetch` API).

The npm package is **`plexus-peers`** (the short name `plexus` is already used on the registry by another project).

## Install

From npm:

```bash
npx plexus-peers --help
```

From a clone of this repo:

```bash
npm install
node bin/plexus.js --help
```

## CLI

Run from a project that has `package.json` (and usually `node_modules` after `npm install`):

```bash
npx plexus-peers                      # Terminal report for the current directory
npx plexus-peers --dir ./my-app       # Another project root
npx plexus-peers -f ./path/to/package.json
```

| Option | Description |
|--------|-------------|
| `--html` | Write an HTML report (`dep-graph.html` in the project root, or use `--out`) |
| `--out <path>` | HTML output path (with `--html`) |
| `--conflicts-only` | Only list packages that have peer issues |
| `--fix` | Call `npm` for latest metadata and print resolution hints (chatty; avoid on CI if logs matter) |
| `--bundlesize` | With `--html`, query [BundlePhobia](https://bundlephobia.com/) per direct dependency (slow, rate limits may apply) |
| `--pkg <name>` | Focus on one direct dependency and related peer rows |

Examples:

```bash
npx plexus-peers --html
npx plexus-peers --html --fix --bundlesize --dir ./my-app
```

## Web UI (`serve`)

Starts a local server with a page to **upload** a `package.json`. The report is generated from the **npm registry** (semver resolution for each direct dependency). There is **no** local `node_modules`, so disk sizes are absent and only dependencies declared in the manifest contribute resolved versions for peers.

```bash
npx plexus-peers serve
# http://127.0.0.1:3847  (override with --port)
```

From the repo you can also run:

```bash
npm start
```

Optional checkboxes on the page match `--fix` and `--bundlesize`.

## CLI vs upload

| | CLI (filesystem) | Web upload |
|--|------------------|------------|
| **Versions** | Read from `node_modules` | Resolved from registry against ranges in `package.json` |
| **Disk size** | `du` on `node_modules` entries | Not available |
| **Peers only transitive** | Can still be read from disk if present | Only if that package is also a direct dependency |

## Development

```bash
npm install
npm run plexus -- --help
npm start   # serve UI on default port
```

## License

MIT
