# dsh-code-insight

[![ci](https://github.com/izhongbei/dsh-code-insight/actions/workflows/ci.yml/badge.svg)](https://github.com/izhongbei/dsh-code-insight/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-code-insight.svg)](https://www.npmjs.com/package/dsh-code-insight)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A DeepSeek Harness plugin that gives the model a **persistent C/C++ symbol index** — the engine behind the
`code-insight` VS Code extension ([cinsight](https://github.com/izhongbei/cinsight)) — as first-class tools:
symbol search, go-to-definition, find-references, callers/callees, call graphs and file outlines. It also adds a
browser **Code Insight panel** to the Web GUI and `@` symbol completion to the composer. No `compile_commands.json`,
no clangd, no external tools: the plugin parses C/C++ itself and answers from a local binary snapshot, so navigation
on a 100k-file tree stays in the millisecond range.

## Tools

| Tool | What it answers |
|---|---|
| `code_insight_search` | Where is a symbol? Case-insensitive name search (exact > prefix > subword > substring) over functions, types, macros, declarations, members, enum constants and globals. |
| `code_insight_definition` | What is the definition of `name`? Candidates ranked like editor `F12`: reachable from `source_file` through `#include` first, then same index root, then closest path prefix; identical-content copies folded into one row; signature and `#ifdef` condition reconstructed; header prototypes hidden when a real body exists. |
| `code_insight_references` | Who uses this symbol? Whole-workspace reference scan (comments/strings ignored) narrowed by an identifier index. |
| `code_insight_callers` | Which functions call it, and at which call site? |
| `code_insight_callees` | Which indexed functions does it call, with signatures? |
| `code_insight_call_graph` | Multi-hop callers/callees around a function (depth- and node-capped). |
| `code_insight_outline` | What does one file define, in definition order, with signatures? |
| `code_insight_index` | Index status / build / rebuild / clear. |

All line numbers returned to the model are **1-based**; the core's 0-based positions stay internal. Every tool reports
`ready`/`building` and starts a background build on first use when `autoBuild` is on, so an unbuilt tree never blocks a
turn.

## Web panel (browser half)

The plugin also ships a browser half: a **Code Insight tab in the Web GUI's right sidebar**. Open the right sidebar,
click the guide capsule (or `+` → Code Insight) and you get, next to the conversation:

- **symbol search** over the index (kind badge, file:line, signature) — results are clickable and open the definition
  at its exact line in the sidebar's file viewer;
- **call graph** rendered as an SVG: callers on the left, callees on the right, re-center on any node with a
  double-click, switch direction/depth from the toolbar;
- **definition detail** with the reconstructed signature and `#ifdef` condition;
- **file outline** of the selected symbol's file, click-to-jump;
- **index status** (state, files, symbols, roots) plus a one-click incremental build.

The panel talks to the host over seven authenticated JSON routes under `/api/code-insight/*`
(`status`, `search`, `graph`, `outline`, `definition`, `references`, `build`) registered on the Connection service.
Click-to-open uses the native `ctx.sidebarRight.openResource` with a session-scoped `dsh-resource://file/session/...`
address and a 1-based `line` param — no extra plugin dependency.

Typing **`@`** in the composer offers a *Code Insight* group: pick an indexed symbol and `name (file:line)` is
inserted as text for your next question.

The panel requires an on-screen Session (it reads that session's working directory). Opening a file from the panel
replaces it unless the right sidebar is split; that is the stock document viewer's behavior, not a plugin choice.

## Install into a DSH profile

The plugin is a normal bundle package (it declares `dsh.bundle.patch`). Install it from npm into the profile that
should expose the tools — here the `web` profile:

```bash
dsh plugin --profile web add dsh-code-insight
```

### From a local checkout (development)

```bash
INSTALL=/home/liujie/.npm/_npx/1e7f6d9597241db0   # the installation that runs `dsh`
"$INSTALL/node_modules/.bin/dsh" plugin --profile web add \
  link:/path/to/dsh-code-insight
```

`dsh plugin add` forwards to pnpm in `$DSH_HOME/profiles/web`, then appends `dsh-code-insight` to
`dsh.profile.bundles` because the package declares a bundle patch. Its patch (`cordis.patch.yml`) inserts one row:

```yaml
- insert:
    - id: code-insight
      name: dsh-code-insight
```

Restart the Web GUI afterwards. A **newly installed bundle and any change to the plugin's `package.json`**
(including enabling the client half for the first time) are composed at boot — client-module metadata is cached per
loader row until restart. After that, editing only `client.js` is picked up as a new bundle revision by the client HMR
transport (page reload is still the reliable check):

```bash
kill <pid-of-dsh-web>
node /home/liujie/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh web --host 127.0.0.1
```

With `dsh-hmr` enabled (the shipped `dsh-base` bundle includes it) a profile patch/config edit — and a `dsh plugin add`
that changes the profile manifest — is recomposed into the running process without a restart; editing the plugin's own
module files still requires one. The first tool call in a session auto-starts the index build when `autoBuild` is on.

Manual mount (no `dsh plugin add`): add a `link:` dependency to the profile `package.json`, add the package under
`dsh.profile.bundles`, and keep the patch above. `dsh.bundle.patch` is required for any package listed in `bundles`.

Because this is a `link:` package, the framework packages it imports must be listed in `peerDependencies` (pnpm does
not install a linked package's dependencies; the DSH runtime routes those peers to the installation copies).

## Configure

The bundle row uses the defaults below. Override them by targeting the row id in the profile's
`$DSH_HOME/profiles/web/cordis.patch.yml` (patch layers apply after bundle layers):

```yaml
- id: code-insight
  config:
    indexRoots: ['rcios']          # narrow the index to the C/C++ tree you care about
    exclude: ['**/.git/**', '**/build/**', '**/tmp/**', '**/node_modules/**']
    autoRefreshMinutes: 10
```

| Setting | Default | Meaning |
|---|---|---|
| `indexRoots` | `['.']` | Workspace-relative directories to index; `"."` = whole workspace. Order is `#include` resolution priority. |
| `exclude` | `.git`, `build`, `tmp`, `node_modules` | Excluded globs, matched against workspace-relative paths. |
| `maxFileSizeKB` | `4096` | Skip source files larger than this. |
| `concurrency` | `4` | Parser worker threads (1–64). Trees with >80k files auto-downgrade to 2. |
| `followSymlinks` | `false` | Follow symbolic links while walking roots. |
| `autoBuild` | `true` | Start a background build when a tool finds no snapshot. |
| `autoRefreshMinutes` | `10` | Trigger a background incremental refresh when the snapshot is older; `0` disables. Queries keep answering from the old snapshot meanwhile. |
| `searchLimit` | `50` | Default/maximum hits of `code_insight_search`. |
| `maxReferenceResults` | `200` | Default/maximum hits of references/callers/callees. |
| `cacheDir` | `$DSH_HOME/storages/code-insight` | Cache root; one subdirectory per workspace root (path + short content hash). |

Indexed extensions are the same whitelist as the extension: `.c .h .cc .cpp .hpp .hh .inl` (case-sensitive).
The snapshot is memory-mapped back on start (millisecond-scale load) and refreshed incrementally (only `mtime`/`size`
changed files are re-parsed).

### Sizing a large tree before you index it

Indexing is CPU- and memory-bounded by the number of files. Measured on this machine (12 cores):

| Scope | Files | Symbols | First build | Snapshot | Host RSS after load |
|---|---|---|---|---|---|
| `rcios/plat` + `rcios/plugin` | 6,838 | 206,430 | 8.6 s | 9.6 MB | ~1.1 GB total process |
| whole workspace (`.`) | 112,295 | — | ~10 min at the auto-downgraded concurrency 2 | ~100 MB | several GB peak |

A ~100k-file first build can peak at multiple GB of RSS. On a host that is already busy, narrow `indexRoots` (or run
the first full build when the machine is idle) — the plugin keeps answering from whatever subset is indexed, and
widening the roots is a config edit plus a rebuild. `code_insight_index action="build"` after widening reuses the
existing snapshot for unchanged files, so only newly covered files are parsed.

## Architecture

```
tools/dsh-code-insight/
  index.js                 # host entry: name / inject / Config / apply, prompt guidance
  client.js                # browser half: right-sidebar tab (search, call graph SVG, outline, @ source)
  lib/manager.js           # per-workspace index manager: cache paths, load, build, status, query wrappers
  lib/tools.js             # the eight code_insight_* model tools (schema + render + execute)
  lib/routes.js            # the seven /api/code-insight/* routes behind the panel
  lib/vendor/              # generated: the extension's unmodified src/core + src/shared, compiled to CJS
  scripts/build-core.mjs   # tsc build of ../vscode-source-insight/src/{core,shared} -> lib/vendor
  test/smoke.mjs           # model tools: fake-ctx end-to-end test on a temp C fixture
  test/routes.test.mjs     # panel API: invokes the registered route handlers with Fetch Requests
  test/client.test.mjs     # browser half: fake ModuleLoader + mini React, drives the panel and clicks
  tsconfig.core.json       # compiler config for the vendored core
```

The extension keeps `src/core` + `src/shared` free of `vscode` imports, so the plugin reuses the exact parser, symbol
table, snapshot format, reference/call-graph scanning and definition ranking instead of re-implementing them. The only
re-implemented piece is the host glue the extension keeps in `src/vscode/service.ts` (cache directory, `latin1` reads,
background build state, cache invalidation).

### Rebuild the vendored core

After pulling changes from the extension:

```bash
cd tools/dsh-code-insight
npm install            # devDependencies: the harness packages the tests resolve against
npm run build          # = node scripts/build-core.mjs
npm test               # smoke + routes + client suites, no dsh boot
```

`scripts/build-core.mjs` uses the extension's own TypeScript compiler (`../vscode-source-insight/node_modules/.bin/tsc`)
and writes `lib/vendor/package.json` (`{"type":"commonjs"}`) so the CJS core loads from the ESM plugin. `worker-scan.js`
must stay a sibling of `indexer.js` — the core spawns it for parallel parsing and silently falls back to serial parsing
when it is missing.

The three test suites need no DSH boot:

- `test/smoke.mjs` boots the host plugin against a fake Cordis context, builds an index over a temp C fixture and
  exercises all eight model tools, including `output.schema` validation of every canonical value, incremental rebuild
  and `clear`;
- `test/routes.test.mjs` registers the panel routes on a fake `connection` service and calls every handler with Fetch
  `Request`s (workspace-, session- and body-resolved), asserting hits, graph edges, outline, ranking and readiness;
- `test/client.test.mjs` loads `client.js` under a fake `window.__ModuleLoader__` with a mini React runtime, renders the
  panel with a mocked `fetch`, and verifies tab/body/`@`-source registration, the SVG call graph, and that clicking a
  result calls `openResource` with a session-scoped address and the 1-based line.

The suites resolve `@deepseek-ai/*` from the repository's devDependencies; set `DSH_INSTALL_ANCHOR` to a DSH
installation's `package.json` to run them against that installation instead. CI runs both suites on Node 22 and 24 via
`.github/workflows/ci.yml`; `.github/workflows/publish.yml` publishes on `v*` tags and creates the GitHub Release.

## License and attribution

MIT — see [LICENSE](LICENSE). `lib/vendor/src/**` is a compiled copy of the Code Insight VS Code extension's
`src/core` + `src/shared` modules (MIT, © source-insight-c contributors); the exact upstream version and commit are
recorded in `lib/vendor/UPSTREAM.json`, and the license text in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
(see also [NOTICE](NOTICE)).

Publishing notes — npm, GitHub, CI/release workflows and the community plugin catalog (one YAML file in a PR):
[PUBLISHING.md](PUBLISHING.md). Release history: [CHANGELOG.md](CHANGELOG.md).

## Limitations

- C/C++ only (the core's extension whitelist); other languages are ignored.
- Preprocessor conditions are reported as raw `#if/#ifdef` text, not evaluated.
- Member/enum-constant `parent` names are present in the parse result but not stored in the snapshot (core contract).
- The index is per workspace root; changing the session working directory switches to that directory's index.
- Queries reflect the last build. Use `code_insight_index action="build"` to pick up edits immediately, or lower
  `autoRefreshMinutes`.
- The Web panel is session-scoped (right sidebar): it needs an on-screen conversation, and the right column's width
  limits the graph canvas (split or float the column for more room).
- The `@` source inserts plain text, not an inline reference chip; it appears only where the composer exists.
- Opening a file from the panel navigates the same right column (stock document-viewer behavior); split the column to
  keep the graph visible.
