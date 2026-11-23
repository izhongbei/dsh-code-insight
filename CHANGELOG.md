# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-23

First public release.

### Added

- **Eight model tools** over a persistent, incrementally updated C/C++ symbol index:
  `code_insight_search`, `code_insight_definition`, `code_insight_references`,
  `code_insight_callers`, `code_insight_callees`, `code_insight_call_graph`,
  `code_insight_outline`, `code_insight_index`.
- **Definition ranking** like an editor's F12: include-graph reachability from a
  `source_file`, same index root, closest path prefix, identical-content copy folding,
  reconstructed signatures and enclosing `#ifdef` conditions.
- **Browser half**: a session-scoped *Code Insight* tab in the Web GUI's right sidebar with
  symbol search, an SVG call graph (callers left, callees right, re-center on a node),
  definition detail, file outline, click-to-open at the 1-based line, and index
  status / build controls.
- **`@` symbol completion** in the composer: pick an indexed symbol and insert
  `name (file:line)` as text.
- **Host JSON API** for the panel under `/api/code-insight/*`
  (`status`, `search`, `graph`, `outline`, `definition`, `references`, `build`) on the
  Connection service's authenticated exact-fetch channel.
- **Per-workspace index manager**: binary snapshot + identifier index cached under
  `$DSH_HOME/storages/code-insight/<workspace>-<hash>/`, background first build,
  incremental refresh, config for roots/exclude/concurrency/size limits.
- **Test suites** (no DSH boot required): model tools (`test/smoke.mjs`), panel API
  (`test/routes.test.mjs`) and the browser bundle under a mini React runtime
  (`test/client.test.mjs`), plus the existing `npm test` aggregate.

### Notes

- The index/query engine is the MIT-licensed `code-insight` VS Code extension core,
  compiled unmodified into `lib/vendor` (upstream 0.9.1, commit `06c903c`) — see
  `NOTICE`, `THIRD_PARTY_LICENSES.md` and `lib/vendor/UPSTREAM.json`.
- The first npm publish went through npm's staged publishing flow (a temporary
  `0.0.0-stage` placeholder appears while the release is reviewed); `0.1.0` is live.
- `@deepseek-ai/*` packages are `peerDependencies` with explicit prerelease branches so
  prerelease harness builds resolve.

[0.1.0]: https://github.com/izhongbei/dsh-code-insight/releases/tag/v0.1.0
