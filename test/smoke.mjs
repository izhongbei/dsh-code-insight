#!/usr/bin/env node
/**
 * Fake-ctx smoke test for the Code Insight plugin — no `dsh` boot.
 *
 * Node >= 22.15 (`module.registerHooks`). It reproduces the DSH runtime's
 * bare-import interception: the plugin's `@deepseek-ai/*` imports resolve to
 * the running installation's copies (what `dsh-app-boot` does for linked
 * profile plugins). Then it boots the plugin against a temp C fixture
 * workspace and exercises every tool end to end.
 *
 * Usage:
 *   node test/smoke.mjs [--keep]
 * Env:
 *   DSH_INSTALL_ANCHOR  path to the @deepseek-ai/dsh package.json of the install
 */
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const keep = process.argv.includes('--keep')

const INSTALL_ANCHOR =
  process.env.DSH_INSTALL_ANCHOR ??
  '/home/liujie/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/package.json'
const requireFromInstall = createRequire(INSTALL_ANCHOR)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      try {
        return { url: pathToFileURL(requireFromInstall.resolve(specifier)).href, shortCircuit: true }
      } catch {
        // fall through to native resolution
      }
    }
    return nextResolve(specifier, context)
  },
})

const { Context } = await import('@deepseek-ai/cordis')
const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')

// ---- fixture workspace ----------------------------------------------------
const fixture = await mkdtemp(path.join(tmpdir(), 'ci-smoke-'))
const files = {
  'proj/inc/util.h': `#ifndef PROJ_UTIL_H
#define PROJ_UTIL_H

#define ADD_LIMIT 1024

struct point {
  int x;
  int y;
};

enum color { COLOR_RED, COLOR_GREEN };

typedef struct point point_t;

int add(int a, int b);

#ifdef CONFIG_FAST_ADD
int add_fast(int a, int b);
#endif

#endif
`,
  'proj/src/util.c': `#include "../inc/util.h"

int add(int a, int b)
{
  return a + b;
}

#ifdef CONFIG_FAST_ADD
int add_fast(int a, int b)
{
  return a + b;
}
#endif
`,
  'proj/src/main.c': `#include "../inc/util.h"

static int run(void)
{
  int total = add(1, 2);
  return total;
}

int main(void)
{
  return run();
}
`,
  'vendor/src/dup.c': `#include "../inc/util.h"

int add(int a, int b)
{
  return a + b;
}
`,
  'proj/src/util_copy.c': `#include "../inc/util.h"

int add(int a, int b)
{
  return a + b;
}

#ifdef CONFIG_FAST_ADD
int add_fast(int a, int b)
{
  return a + b;
}
#endif
`,
  'vendor/inc/util.h': `#ifndef PROJ_UTIL_H
#define PROJ_UTIL_H

int add(int a, int b);

#endif
`,
  'vendor/src/other.c': `#include "../inc/util.h"

int other_caller(void)
{
  return add(3, 4);
}
`,
}
for (const [relative, content] of Object.entries(files)) {
  const absolute = path.join(fixture, relative)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}
const cacheDir = path.join(fixture, '.ci-cache')

// ---- fake host ------------------------------------------------------------
const captured = new Map()
let failures = 0

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const fakeCtx = new Context()
fakeCtx.provide('tools', {
  register(definition) {
    captured.set(definition.name, definition)
    return () => captured.delete(definition.name)
  },
})
fakeCtx.provide('workingDirectory', {
  defaultDirectory: fixture,
  get() {
    return fixture
  },
})
const SESSION = { id: 'ses_smoke', header: { id: 'ses_smoke', cwd: fixture } }
fakeCtx.provide('sessions', { get(id) { return id === SESSION.id ? SESSION : undefined } })

const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
check('plugin exports apply/name/inject/Config', typeof plugin.apply === 'function' && plugin.name === 'dsh-code-insight' && Array.isArray(plugin.inject) && plugin.Config !== undefined)

await fakeCtx.plugin(plugin, { indexRoots: ['.'], cacheDir, concurrency: 4 })
check('registers every code_insight_* tool', captured.size === 8, [...captured.keys()].join(', '))

const baseExec = {
  callId: 'call_smoke',
  rootCallId: 'call_smoke',
  name: '',
  arguments: {},
  signal: new AbortController().signal,
  agent: { id: SESSION.id, session: SESSION, ctx: fakeCtx },
  token: Symbol('exec'),
  deferContext() {},
  concludeTurn() {},
}

async function call(toolName, args = {}) {
  const tool = captured.get(toolName)
  if (tool === undefined) throw new Error(`missing tool ${toolName}`)
  const value = await tool.execute(args, { ...baseExec, name: toolName, arguments: args })
  // The registry enforces `output.schema`; catch canonical-value violations here.
  const violations = validateJsonSchemaValue(tool.output.schema, value, toolName)
  check(`${toolName} canonical value matches output.schema`, violations.length === 0, violations.join('; '))
  const rendered = tool.output.render(args, value)
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return { value, rendered }
}

console.log(`\nfixture: ${fixture}`)

// ---- index management -----------------------------------------------------
const status0 = await call('code_insight_index', { action: 'status' })
check('status before build reports not ready', status0.value.ready === false && status0.value.state === 'empty', status0.rendered)

const build = await call('code_insight_index', { action: 'build', wait_seconds: 120 })
check('build reaches state=ready', build.value.state === 'ready' && build.value.ready === true, build.rendered)
check('build indexes 7 files', build.value.files === 7, `files=${build.value.files}`)
check('build indexes symbols', build.value.symbols > 0, `symbols=${build.value.symbols}`)
check('snapshot persisted', build.value.snapshotBytes > 0, `bytes=${build.value.snapshotBytes}`)

// ---- search ---------------------------------------------------------------
const search = await call('code_insight_search', { query: 'add' })
check('search finds add', search.value.ready && search.value.hits.some((hit) => hit.name === 'add' && hit.kind === 'function'), search.rendered)
check('search reports 1-based lines', search.value.hits.every((hit) => hit.line >= 1))
const kindFiltered = await call('code_insight_search', { query: 'point', kinds: ['struct'] })
check('search kind filter', kindFiltered.value.hits.every((hit) => hit.kind === 'struct'), kindFiltered.rendered)

// ---- definition -----------------------------------------------------------
const definition = await call('code_insight_definition', { name: 'add', source_file: 'proj/src/main.c' })
check('definition finds add', definition.value.definitions.length > 0, definition.rendered)
check(
  'definition ranks the same-tree implementation first',
  definition.value.definitions[0]?.file === 'proj/src/util.c',
  JSON.stringify(definition.value.definitions[0]),
)
check(
  'definition hides header prototypes by default',
  definition.value.definitions.every((entry) => entry.kind !== 'declaration'),
  JSON.stringify(definition.value.definitions.map((entry) => entry.kind)),
)
check('definition folds identical copies', definition.value.definitions.some((entry) => entry.copies >= 2), definition.rendered)
check('definition reconstructs the signature', /int add\(int a, int b\)/.test(definition.value.definitions[0]?.signature ?? ''), definition.value.definitions[0]?.signature)
const showCopies = await call('code_insight_definition', { name: 'add', source_file: 'proj/src/main.c', show_copies: true })
check('show_copies expands duplicate files', showCopies.value.definitions.length > definition.value.definitions.length)
const conditional = await call('code_insight_definition', { name: 'add_fast' })
check('conditional definition carries #ifdef condition', (conditional.value.definitions[0]?.condition ?? '').includes('CONFIG_FAST_ADD'), conditional.rendered)

// ---- references / callers / callees --------------------------------------
const references = await call('code_insight_references', { name: 'add' })
check('references find call sites', references.value.references.length >= 2, references.rendered)
check('references are 1-based and previewed', references.value.references.every((hit) => hit.line >= 1 && hit.preview.length > 0))
check(
  'references include main.c and other.c',
  ['proj/src/main.c', 'vendor/src/other.c'].every((file) => references.value.references.some((hit) => hit.file === file)),
  references.rendered,
)
const callers = await call('code_insight_callers', { name: 'add' })
check('callers attribute the enclosing function', callers.value.callers.some((hit) => hit.from_name === 'run'), callers.rendered)
check('callers include other_caller', callers.value.callers.some((hit) => hit.from_name === 'other_caller'), callers.rendered)
const callees = await call('code_insight_callees', { name: 'run' })
check('callees list add', callees.value.callees.some((entry) => entry.name === 'add'), callees.rendered)

// ---- outline / call graph -------------------------------------------------
const outline = await call('code_insight_outline', { file: path.join(fixture, 'proj/src/main.c') })
check('outline lists run and main', ['run', 'main'].every((symbol) => outline.value.symbols.some((entry) => entry.name === symbol)), outline.rendered)
check('outline reconstructs signatures', outline.value.symbols.every((entry) => typeof entry.signature === 'string'), outline.rendered)

const graph = await call('code_insight_call_graph', { name: 'add', depth: 2, direction: 'both' })
const graphNames = graph.value.nodes.map((node) => node.name)
check('call graph has root add', graph.value.nodes.find((node) => node.relation === 'root')?.name === 'add', graph.rendered)
check('call graph shows caller run', graphNames.includes('run'), graph.rendered)
check('call graph has calls edges', graph.value.edges.length > 0, JSON.stringify(graph.value.edges))

// ---- incremental rebuild + clear -----------------------------------------
await writeFile(
  path.join(fixture, 'proj/src/newfile.c'),
  '#include "../inc/util.h"\n\nint brand_new_symbol(void)\n{\n  return add(1, 1);\n}\n',
)
const rebuild = await call('code_insight_index', { action: 'build', wait_seconds: 120 })
check('incremental build parses only the new file', rebuild.value.lastBuild?.added === 1 && rebuild.value.lastBuild?.unchanged === 7, JSON.stringify(rebuild.value.lastBuild))
const newSymbol = await call('code_insight_search', { query: 'brand_new_symbol' })
check('new file is queryable after refresh', newSymbol.value.hits.some((hit) => hit.name === 'brand_new_symbol'), newSymbol.rendered)

const cleared = await call('code_insight_index', { action: 'clear' })
check('clear empties the index', cleared.value.ready === false && cleared.value.state === 'empty', cleared.rendered)

await fakeCtx.dispose?.()

if (keep) {
  console.log(`\nkept fixture: ${fixture}`)
} else {
  await rm(fixture, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
