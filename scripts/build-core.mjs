#!/usr/bin/env node
/**
 * Build the vendored core of the plugin.
 *
 * The Code Insight VS Code extension in `../vscode-source-insight` keeps all
 * index/query logic in `src/core` + `src/shared`, and those modules are pure
 * Node (no `vscode` import). This script compiles that stable core into
 * `lib/vendor` as CommonJS, which the plugin's ESM entry loads through
 * `createRequire`. `lib/vendor/package.json` pins the vendored subtree to
 * CommonJS even though the plugin package itself is `"type": "module"`.
 *
 * Usage: node scripts/build-core.mjs [--check]
 *   --check  compile into a temp dir and report, without touching lib/vendor
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
/**
 * Upstream sources: `DSH_CODE_INSIGHT_EXT_SRC` wins (a standalone checkout of
 * the extension), then the sibling `../vscode-source-insight` used inside the
 * extension's own repository. Consumers never need this script: the compiled
 * `lib/vendor` tree is committed to the package.
 */
const extensionDir = process.env.DSH_CODE_INSIGHT_EXT_SRC
  ? path.resolve(process.env.DSH_CODE_INSIGHT_EXT_SRC)
  : path.resolve(root, '..', 'vscode-source-insight')
const check = process.argv.includes('--check')

function fail(message) {
  console.error(`[build-core] ${message}`)
  process.exit(1)
}

if (!existsSync(extensionDir)) {
  fail(
    `Code Insight extension sources not found at ${extensionDir}; ` +
      'set DSH_CODE_INSIGHT_EXT_SRC to a checkout of the extension',
  )
}

/** Git metadata of the upstream checkout, for provenance in lib/vendor/UPSTREAM.json. */
function gitValue(args) {
  const result = spawnSync('git', ['-C', extensionDir, ...args], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

/** Locate a TypeScript compiler: extension devDependency, then npm-installed global. */
function resolveTsc() {
  const candidates = [
    process.env.DSH_CODE_INSIGHT_TSC,
    path.join(extensionDir, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(extensionDir, 'node_modules', '.bin', 'tsc'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

const tsc = resolveTsc()
if (!tsc) {
  fail('no TypeScript compiler found; install the extension devDependencies (npm i in tools/vscode-source-insight) or set DSH_CODE_INSIGHT_TSC')
}

const tsconfig = JSON.parse(readFileSync(path.join(root, 'tsconfig.core.json'), 'utf8'))
const outDir = check ? path.join(root, 'node_modules', '.cache', 'vendor-check') : path.join(root, 'lib', 'vendor')
const configPath = path.join(root, check ? 'tsconfig.core.check.json' : 'tsconfig.core.json')
if (check) {
  tsconfig.compilerOptions = { ...tsconfig.compilerOptions, outDir: path.relative(root, outDir) }
  writeFileSync(configPath, JSON.stringify(tsconfig, null, 2))
}

try {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const result = spawnSync(process.execPath, [tsc, '-p', configPath], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) fail(`tsc failed with exit code ${result.status ?? 'signal'}`)
} finally {
  if (check) rmSync(configPath, { force: true })
}

if (!check) {
  // The nearest package.json decides the module format of `lib/vendor/**`.
  writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`)
  // Provenance of the compiled copy (the extension itself is MIT licensed).
  let upstreamVersion
  try {
    upstreamVersion = JSON.parse(readFileSync(path.join(extensionDir, 'package.json'), 'utf8')).version
  } catch {
    upstreamVersion = undefined
  }
  const upstream = {
    project: 'code-insight (VS Code extension)',
    repository: 'https://github.com/izhongbei/cinsight',
    version: upstreamVersion,
    commit: gitValue(['rev-parse', 'HEAD']),
    commitDate: gitValue(['log', '-1', '--format=%cI']),
    builtAt: new Date().toISOString(),
    note: 'lib/vendor/src/{core,shared} is a compiled copy of the upstream src/{core,shared} (MIT).',
  }
  writeFileSync(path.join(outDir, 'UPSTREAM.json'), `${JSON.stringify(upstream, null, 2)}\n`)
}

const entry = path.join(outDir, 'src', 'core', 'indexer.js')
const worker = path.join(outDir, 'src', 'core', 'worker-scan.js')
if (!existsSync(entry) || !existsSync(worker)) {
  fail(`compiled output incomplete: expected ${entry} and ${worker}`)
}
console.log(`[build-core] ok -> ${path.relative(root, outDir)}`)
