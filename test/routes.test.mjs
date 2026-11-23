#!/usr/bin/env node
/**
 * Host-route smoke test for the Code Insight panel API — no `dsh` boot.
 *
 * Boots the plugin in a fake Cordis context that provides a fake `connection`
 * service, captures the `/api/code-insight/*` routes it registers, then calls
 * the real handlers with Fetch `Request` objects against a temp C fixture.
 */
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
/**
 * Harness package resolution.
 *
 * By default the test file imports `@deepseek-ai/*` natively from this
 * repository's devDependencies (`npm install`). Set `DSH_INSTALL_ANCHOR` to a
 * DSH installation's `package.json` to test against that installation instead
 * (useful when the devDependencies are not installed).
 */
const installAnchor = process.env.DSH_INSTALL_ANCHOR
if (typeof installAnchor === 'string' && installAnchor !== '') {
  const requireFromInstall = createRequire(installAnchor)
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
}

const { Context } = await import('@deepseek-ai/cordis')

// ---- fixture --------------------------------------------------------------
const fixture = await mkdtemp(path.join(tmpdir(), 'ci-routes-'))
const files = {
  'proj/inc/util.h': `#ifndef PROJ_UTIL_H
#define PROJ_UTIL_H
#define ADD_LIMIT 1024
struct point { int x; int y; };
typedef struct point point_t;
int add(int a, int b);
#endif
`,
  'proj/src/util.c': `#include "../inc/util.h"
int add(int a, int b)
{
  return a + b;
}
`,
  'proj/src/main.c': `#include "../inc/util.h"
static int run(void)
{
  return add(1, 2);
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
}
for (const [relative, content] of Object.entries(files)) {
  const absolute = path.join(fixture, relative)
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}
const cacheDir = path.join(fixture, '.ci-cache')

// ---- fake host ------------------------------------------------------------
const routes = new Map()
let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const fakeCtx = new Context()
const registeredTools = new Map()
fakeCtx.provide('tools', {
  register(definition) {
    registeredTools.set(definition.name, definition)
    return () => registeredTools.delete(definition.name)
  },
})
fakeCtx.provide('connection', {
  fetch: {
    register(route) {
      routes.set(route.path, route)
      return async () => {
        routes.delete(route.path)
      }
    },
  },
})
fakeCtx.provide('workingDirectory', {
  defaultDirectory: fixture,
  get() {
    return fixture
  },
})
const SESSION = { id: 'ses_routes', header: { id: 'ses_routes', cwd: fixture } }
fakeCtx.provide('sessions', { get(id) { return id === SESSION.id ? SESSION : undefined } })

const plugin = await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)
await fakeCtx.plugin(plugin, { indexRoots: ['.'], cacheDir, concurrency: 4, autoRefreshMinutes: 0 })
await new Promise((resolve) => setImmediate(resolve))

console.log(`\nfixture: ${fixture}`)
check(
  'registers the seven panel routes',
  [...routes.keys()].sort().join(',') ===
    [
      '/api/code-insight/build',
      '/api/code-insight/definition',
      '/api/code-insight/graph',
      '/api/code-insight/outline',
      '/api/code-insight/references',
      '/api/code-insight/search',
      '/api/code-insight/status',
    ].join(','),
  [...routes.keys()].join(', '),
)
check('keeps the eight model tools', registeredTools.size === 8, [...registeredTools.keys()].join(', '))

async function callRoute(routePath, { query, body } = {}) {
  const route = routes.get(routePath)
  if (route === undefined) throw new Error(`route not registered: ${routePath}`)
  const url = new URL(`http://127.0.0.1${routePath}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  const request =
    body === undefined
      ? new Request(url, { method: route.methods[0] })
      : new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
  const response = await route.fetch(request)
  const payload = await response.json()
  return { status: response.status, payload }
}

// ---- build + queries ------------------------------------------------------
const build = await callRoute('/api/code-insight/build', { body: { action: 'build', wait_seconds: 120, workspace: fixture } })
check('build route returns ready index', build.payload.ok === true && build.payload.value.ready === true && build.payload.value.state === 'ready', JSON.stringify(build.payload).slice(0, 200))
check('build route reports file/symbol counts', build.payload.value.files === 4 && build.payload.value.symbols > 0, `${build.payload.value.files}/${build.payload.value.symbols}`)

const status = await callRoute('/api/code-insight/status', { query: { workspace: fixture } })
check('status route reports the workspace', status.payload.ok === true && status.payload.value.workspace === fixture, JSON.stringify(status.payload.value))
check('status route exposes roots and counts', Array.isArray(status.payload.value.roots) && status.payload.value.ready === true)

const search = await callRoute('/api/code-insight/search', { query: { q: 'add', workspace: fixture } })
check('search route finds add', search.payload.ok === true && search.payload.value.hits.some((hit) => hit.name === 'add' && hit.kind === 'function'), JSON.stringify(search.payload).slice(0, 300))
check('search route reconstructs signatures', search.payload.value.hits.some((hit) => typeof hit.signature === 'string' && hit.signature.includes('add')))

const graph = await callRoute('/api/code-insight/graph', { query: { symbol: 'add', workspace: fixture, depth: 2 } })
check('graph route returns root + caller', graph.payload.ok === true && graph.payload.value.nodes.some((node) => node.relation === 'root') && graph.payload.value.nodes.some((node) => node.name === 'run'), JSON.stringify(graph.payload.value.nodes?.map((node) => `${node.name}:${node.relation}`)))
check('graph route returns call edges', Array.isArray(graph.payload.value.edges) && graph.payload.value.edges.length > 0)
check('graph route returns the root definition location', graph.payload.value.definition?.file === 'proj/src/util.c', JSON.stringify(graph.payload.value.definition))

const outline = await callRoute('/api/code-insight/outline', { query: { file: 'proj/src/main.c', workspace: fixture } })
check('outline route lists run and main', outline.payload.ok === true && ['run', 'main'].every((name) => outline.payload.value.symbols.some((symbol) => symbol.name === name)), JSON.stringify(outline.payload.value.symbols?.map((symbol) => symbol.name)))

const definition = await callRoute('/api/code-insight/definition', { query: { name: 'add', source_file: 'proj/src/main.c', workspace: fixture } })
check('definition route ranks the same-tree implementation', definition.payload.ok === true && definition.payload.value.definitions[0]?.file === 'proj/src/util.c', JSON.stringify(definition.payload.value.definitions?.[0]))

const references = await callRoute('/api/code-insight/references', { query: { name: 'add', workspace: fixture } })
check('references route finds call sites', references.payload.ok === true && references.payload.value.references.length >= 1, JSON.stringify(references.payload.value.references?.length))
check('references route reports 1-based lines', references.payload.value.references.every((hit) => hit.line >= 1))

const viaSession = await callRoute('/api/code-insight/status', { query: { sessionId: SESSION.id } })
check('status route resolves the workspace from the session', viaSession.payload.ok === true && viaSession.payload.value.workspace === fixture, JSON.stringify(viaSession.payload.value?.workspace))

await fakeCtx.dispose?.()
await rm(fixture, { recursive: true, force: true })
console.log(failures === 0 ? '\nROUTES PASS' : `\nROUTES FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
