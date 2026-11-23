# Publishing `dsh-code-insight`

This package is already shaped as a publishable DeepSeek Harness plugin. What is left is account-bound work: create the
public repository, publish to npm, and (optionally) submit it to the community plugin catalog.

## What is already in place

- `package.json` declares the installable bundle manifest (`dsh.bundle.patch`) **and** the browser half
  (`dsh.client`), so both `dsh plugin add` and the Web panel work.
- `cordis.patch.yml` inserts the plugin row (`id: code-insight`).
- `lib/vendor/**` is committed, so consumers never need the upstream extension checkout or a build step.
  `lib/vendor/UPSTREAM.json` records the upstream version + commit, and `NOTICE` / `THIRD_PARTY_LICENSES.md` carry the
  MIT attribution for the compiled upstream core.
- `@deepseek-ai/*` packages are `peerDependencies` with explicit prerelease branches (required by the catalog review;
  a bare range would silently exclude prerelease harness builds).
- `npm test` runs all three suites; `prepublishOnly` runs it before every publish; CI
  (`.github/workflows/ci.yml`) runs the same suites on Node 22 and 24 from the repository's
  `@deepseek-ai` devDependencies (`npm ci`).
- `.github/workflows/publish.yml` publishes on `v*` tags (skipping an already-published version) and creates
  the GitHub Release; it needs an `NPM_TOKEN` repository secret — a Granular Access Token with **Bypass 2FA**
  enabled (npm requires 2FA or such a token to publish).
- `awesome-dsh-plugin-entry.yml` at the repository root is the catalog submission content (copy it into the
  catalog's `data/plugins/` when opening the PR).
- `npm pack --dry-run` ships 31 files (~100 kB packed / ~380 kB unpacked): host entry, client bundle, routes, vendored
  core, patch, docs and licenses.

## 1. Create the public repository

The plugin was developed inside the RCIOS workspace; publish it as its own repository:

```bash
cd tools/dsh-code-insight
# already initialized + committed by the setup (see git log)
git remote add origin git@github.com:izhongbei/dsh-code-insight.git
git push -u origin main
```

On GitHub:

1. Create the empty public repo `izhongbei/dsh-code-insight` (no README/gitignore — the push supplies them).
2. Add the topic **`dsh-plugin`** (required for catalog submission).
3. Keep the repository public: the catalog review reads the code before merging.

## 2. Publish to npm

```bash
npm login                     # one-time, needs an npm account
cd tools/dsh-code-insight
npm publish --access public   # runs `prepublishOnly` = npm test
```

Verify:

```bash
npm view dsh-code-insight version
npm view dsh-code-insight dsh
```

Then install it like any marketplace plugin:

```bash
dsh plugin --profile web add dsh-code-insight
```

Restart the Host once after installing (client-module metadata is read at boot), then open the right sidebar and pick
**Code Insight**.

A first publish of a brand-new package goes through npm's **staged publishing** flow: the registry briefly shows a
`0.0.0-stage` placeholder while the release is reviewed, then the real version appears (a few minutes in practice).

### Version bumps (CI release)

```bash
# edit CHANGELOG.md, then:
npm version patch             # 0.1.0 -> 0.1.1 (creates the v0.1.1 tag)
git push && git push --tags   # publish workflow: tests -> npm publish -> GitHub Release
```

Or publish by hand (needs 2FA / a bypass-2FA token as above):

```bash
npm publish --access public --otp=123456
```

## 3. Submit to the community plugin market

The built-in *Plugins → Discover* index is the community catalog
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
(served as `dsh-plugin-catalog`). Submission is one YAML file in a PR — do **not** edit the generated READMEs.

The ready-made content lives at the repository root as `awesome-dsh-plugin-entry.yml`. Fork the catalog
repository, then add it as `data/plugins/izhongbei__dsh-code-insight.yml`:

```yaml
url: https://github.com/izhongbei/dsh-code-insight
name: izhongbei/dsh-code-insight
category: tools
description:
  en: 'Persistent C/C++ symbol index for DeepSeek Harness: symbol search, go-to-definition, find-references, callers/callees, call graph and a right-sidebar panel, plus @ symbol completion in the composer.'
  zh: '为 DeepSeek Harness 提供持久化 C/C++ 符号索引：符号搜索、跳转定义、引用、调用者/被调用者、调用关系图与右侧栏面板，以及输入框 @ 符号补全。'
```

Then open the PR. Review criteria that matter here:

- the repo declares a `dsh.bundle` manifest (it does; `dsh.client` alone is not installable);
- real, working code (it is);
- repo at least one day old and actively maintained;
- `dsh-plugin` topic set;
- the description must be accurate — it is checked against the code.

Full rules: <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>

### Alternative: GitHub-only release (no npm)

If you prefer not to publish to npm, attach a prebuilt tarball (`npm pack` output) to a GitHub Release and point the
catalog entry at it with `tarball:` (must be an `https` `.tgz` on GitHub's own release hosting). Prefer a
version-free asset name under `releases/latest/download/`, or pin the release tag when the filename carries a version.

## Rebuilding the vendored core

Only needed when the upstream extension changes:

```bash
# inside the extension repository (sibling checkout):
cd tools/dsh-code-insight
npm run build      # needs ../vscode-source-insight or DSH_CODE_INSIGHT_EXT_SRC=<checkout>
npm test
git add lib/vendor && git commit -m "chore: re-vendor code-insight core"
npm version patch && npm publish --access public
```

`lib/vendor/UPSTREAM.json` is refreshed by the build script, so a published package always records what it was built
from.
