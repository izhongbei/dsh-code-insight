#!/usr/bin/env node
/**
 * Browser-half smoke test for the Code Insight client bundle — no browser.
 *
 * Loads `client.js` under a fake `window.__ModuleLoader__`, provides a tiny
 * React hook runtime and fake client services (slots / locale /
 * sidebarRightTabs / sidebarRight), then drives the panel through render
 * passes with a mocked `fetch` to verify:
 * - tab type + body registration,
 * - host API calls use document-relative URLs,
 * - the call graph and outline render,
 * - clicking a result opens the definition at its 1-based line through the
 *   native right-sidebar `openResource` service.
 */
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ---- tiny React -----------------------------------------------------------
const stores = new WeakMap()
let currentStore
let pendingEffects

function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children } }
}

const React = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const store = currentStore
    const index = store.index++
    if (!(index in store.hooks)) store.hooks[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      store.hooks[index] = typeof value === 'function' ? value(store.hooks[index]) : value
    }
    return [store.hooks[index], set]
  },
  useRef(initial) {
    const store = currentStore
    const index = store.index++
    if (!(index in store.hooks)) store.hooks[index] = { current: initial }
    return store.hooks[index]
  },
  useEffect(fn, deps) {
    const store = currentStore
    const index = store.index++
    const previous = store.hooks[index]
    const changed =
      previous === undefined ||
      deps === undefined ||
      previous.deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((value, position) => value !== previous.deps[position])
    if (!changed) return
    store.hooks[index] = { deps }
    pendingEffects.push(() => {
      try {
        fn()
      } catch (error) {
        console.error('[client-test] effect threw:', error)
      }
    })
  },
  useMemo(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
}

/** Render one function component with a persistent hook store. */
function renderComponent(component, props) {
  const previous = currentStore
  const previousEffects = pendingEffects
  const store = stores.get(component) ?? { hooks: [], index: 0 }
  stores.set(component, store)
  currentStore = store
  store.index = 0
  pendingEffects = []
  const output = component(props)
  const effects = pendingEffects
  pendingEffects = previousEffects
  currentStore = previous
  for (const effect of effects) effect()
  return output
}

/** Walk a rendered tree, invoking function components, collecting text. */
function walk(element, texts = []) {
  if (element === null || element === undefined || typeof element === 'boolean') return texts
  if (typeof element === 'string' || typeof element === 'number') {
    texts.push(String(element))
    return texts
  }
  if (Array.isArray(element)) {
    for (const child of element) walk(child, texts)
    return texts
  }
  if (typeof element !== 'object') return texts
  if (typeof element.type === 'function') {
    walk(renderComponent(element.type, element.props), texts)
    return texts
  }
  walk(element.props?.children, texts)
  return texts
}

/** Collect every element whose type is a host tag. */
function collect(element, predicate, found = []) {
  if (element === null || element === undefined || typeof element !== 'object') return found
  if (Array.isArray(element)) {
    for (const child of element) collect(child, predicate, found)
    return found
  }
  if (typeof element.type === 'function') {
    collect(renderComponent(element.type, element.props), predicate, found)
    return found
  }
  if (predicate(element)) found.push(element)
  collect(element.props?.children, predicate, found)
  return found
}

// ---- fake window + bundle loading ----------------------------------------
let registration
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
}

const fetchCalls = []
const openCalls = []
let fetchMode = 'ok'
const envelopes = {
  status: {
    workspace: '/ws',
    ready: true,
    building: false,
    state: 'ready',
    files: 4,
    symbols: 120,
    roots: ['.'],
    builtAt: new Date().toISOString(),
  },
  search: {
    workspace: '/ws',
    ready: true,
    q: 'add',
    hits: [
      { name: 'add', kind: 'function', file: 'proj/src/util.c', line: 3, end_line: 6, signature: 'int add(int a, int b)', condition: undefined },
      { name: 'add_fast', kind: 'function', file: 'proj/src/util.c', line: 9, end_line: 12 },
    ],
  },
  graph: {
    workspace: '/ws',
    ready: true,
    symbol: 'add',
    depth: 2,
    direction: 'both',
    nodes: [
      { id: 0, name: 'add', kind: 'function', file: 'proj/src/util.c', line: 3, depth: 0, relation: 'root', truncated_children: false },
      { id: 1, name: 'run', kind: 'function', file: 'proj/src/main.c', line: 2, depth: 1, relation: 'caller', truncated_children: false },
      { id: 2, name: 'printf', kind: 'function', file: 'proj/src/util.c', line: 40, depth: 1, relation: 'callee', truncated_children: false },
    ],
    edges: [
      { from: 1, to: 0, relation: 'calls' },
      { from: 0, to: 2, relation: 'calls' },
    ],
    truncated: false,
    definition: { file: 'proj/src/util.c', line: 3, end_line: 6, kind: 'function', signature: 'int add(int a, int b)' },
  },
  outline: {
    workspace: '/ws',
    file: 'proj/src/util.c',
    symbols: [
      { name: 'add', kind: 'function', line: 3, end_line: 6 },
      { name: 'add_fast', kind: 'function', line: 9, end_line: 12 },
    ],
  },
}

globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' })
  if (fetchMode === 'expired') return { ok: false, status: 401, json: async () => ({}) }
  const match = /^api\/code-insight\/([a-z]+)/.exec(String(url))
  const key = match?.[1]
  const value = envelopes[key]
  return {
    ok: value !== undefined,
    status: value === undefined ? 404 : 200,
    json: async () => (value === undefined ? { ok: false, error: { message: 'not found' } } : { ok: true, value }),
  }
}

const moduleUrl = pathToFileURL(path.join(pluginRoot, 'client.js')).href
await import(`${moduleUrl}?test=${Date.now()}`)
check('bundle registers itself with __ModuleLoader__', registration !== undefined && registration.id === 'dsh-code-insight')
check('bundle exposes a factory', typeof registration?.factory === 'function')

const bundle = registration.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})
check('bundle exports apply/inject', typeof bundle?.apply === 'function' && Array.isArray(bundle.inject))

// ---- fake client context -------------------------------------------------
const zh = {}
const registeredTabs = []
const registeredSlots = []
const t = (key, params) => {
  const template = zh[key] ?? key
  return String(template).replace(/\{(\w+)\}/g, (_match, name) => (params?.[name] === undefined ? '' : String(params[name])))
}
const locale = {
  register(namespace, dictionaries) {
    Object.assign(zh, dictionaries.zh ?? dictionaries.en ?? {})
    return () => {}
  },
  bind() {
    return t
  },
}
const registeredSources = []
const services = {
  inputTriggers: {
    registerSource(source) {
      registeredSources.push(source)
      return () => {}
    },
  },
  sidebarRightTabs: {
    register(definition) {
      registeredTabs.push(definition)
      return () => {}
    },
  },
  slots: {
    inject(_name, callback) {
      return callback()
    },
    register(options, component) {
      registeredSlots.push({ options, component })
      return () => {}
    },
  },
  locale,
  get(name) {
    if (name === 'inputTriggers') return services.inputTriggers
    if (name === 'sidebarRight') {
      return {
        openResource(address, options) {
          openCalls.push({ address, options })
        },
      }
    }
    return undefined
  },
}
const fakeCtx = {
  locale,
  effect(fn) {
    return fn()
  },
  inject(_deps, callback) {
    return callback(services)
  },
  get: services.get,
}

bundle.apply(fakeCtx)
check('registers one right-sidebar tab type', registeredTabs.length === 1 && registeredTabs[0].kind === 'code-insight')
check('tab has title/guide with locale text', typeof registeredTabs[0].title === 'function' && registeredTabs[0].guide?.length === 1)
check('registers the tab body slot', registeredSlots.length === 1 && registeredSlots[0].options.name === 'sidebar.right.pane.tab' && registeredSlots[0].options.key === 'dsh-code-insight')
check('registers one @ symbol completion source', registeredSources.length === 1 && registeredSources[0].trigger === '@' && registeredSources[0].name === 'codeInsight', JSON.stringify(registeredSources.map((source) => `${source.trigger}:${source.name}`)))

// The @ source maps search hits to candidates and inserts name (file:line).
if (registeredSources.length === 1) {
  const source = registeredSources[0]
  const candidates = await source.candidates({ sessionId: 'session-1' }, { query: 'add' })
  check('@ source returns candidates from the index', Array.isArray(candidates) && candidates.length >= 1 && candidates[0].name === 'add', JSON.stringify(candidates).slice(0, 200))
  const picked = source.onPick({ candidate: candidates[0] })
  check('@ pick inserts name (file:line)', typeof picked?.text === 'string' && picked.text.includes('add (proj/src/util.c:3)'), JSON.stringify(picked))
}

// ---- render the panel ----------------------------------------------------
const props = {
  t,
  sessionId: 'session-1',
  useSessions: (selector) => selector({ byId: { 'session-1': { cwd: '/ws' } } }),
  useTabInfo: () => ({ tab: { navigation: { params: {}, revision: 1 } } }),
}
const Body = registeredSlots[0].component

// 401 handling: an expired cookie surfaces the reload hint.
fetchMode = 'expired'
const expiredBody = Body({ ...props, sessionId: 'session-expired' })
walk(expiredBody)
await new Promise((resolve) => setTimeout(resolve, 20))
const expiredTexts = walk(Body({ ...props, sessionId: 'session-expired' })).join(' ')
check('a 401 surfaces the expired-session hint', expiredTexts.includes('登录态已过期') || expiredTexts.includes('Session expired'), expiredTexts.slice(0, 200))
fetchMode = 'ok'

// Pass 1: mount + status effects.
walk(Body(props))
await new Promise((resolve) => setTimeout(resolve, 10))

// Pass 2: state (status) is available; graph fetch starts.
let tree = Body(props)
walk(tree)
await new Promise((resolve) => setTimeout(resolve, 10))

// Pass 3: graph + outline data resolved.
tree = Body(props)
const texts = walk(tree)
console.log(`\nrendered text sample: ${texts.filter((entry) => typeof entry === 'string').slice(0, 12).join(' | ')}`)

check(
  'requests use document-relative API URLs',
  fetchCalls.length > 0 && fetchCalls.every((call) => call.url.startsWith('api/code-insight/')),
  fetchCalls.map((call) => call.url).slice(0, 4).join(', '),
)
check('status endpoint was queried with the session id', fetchCalls.some((call) => call.url.includes('status') && call.url.includes('sessionId=session-1')))
check('search is not fired for an empty query', !fetchCalls.some((call) => /[/]search\?[^#]*[?&]q=(&|$)/.test(call.url)))

// Force a graph request by simulating a search result click path: re-render
// with a query is hard without input events, so drive the graph effect by
// opening the tab with a target symbol via navigation params.
const propsWithSymbol = {
  ...props,
  useTabInfo: () => ({ tab: { navigation: { params: { symbol: 'add' }, revision: 2 } } }),
}
let treeWithSymbol = Body(propsWithSymbol)
walk(treeWithSymbol)
await new Promise((resolve) => setTimeout(resolve, 20))
treeWithSymbol = Body(propsWithSymbol)
walk(treeWithSymbol)
await new Promise((resolve) => setTimeout(resolve, 20))
treeWithSymbol = Body(propsWithSymbol)
const textsWithSymbol = walk(treeWithSymbol)
const svg = collect(treeWithSymbol, (element) => element.type === 'svg' && element.props?.['aria-label'] === 'add')
const graphText = textsWithSymbol.join(' ')
check('graph effect fires when the tab opens with a symbol', fetchCalls.some((call) => call.url.includes('/graph') && call.url.includes('symbol=add')), fetchCalls.map((call) => call.url).slice(-4).join(', '))
check('call graph renders an SVG', svg.length >= 1, `svg count=${svg.length}`)
check('graph nodes render root/caller/callee names', ['add', 'run', 'printf'].every((name) => graphText.includes(name)), graphText.slice(0, 300))
check('outline endpoint is queried for the selected file', fetchCalls.some((call) => call.url.includes('/outline') && call.url.includes('proj%2Fsrc%2Futil.c')), fetchCalls.map((call) => call.url).slice(-5).join(', '))

// Simulate typing a query, wait out the debounce, then click the first hit.
const inputs = collect(treeWithSymbol, (element) => element.type === 'input' && element.props?.type === 'search')
check('search input rendered', inputs.length === 1)
if (inputs.length === 1) {
  inputs[0].props.onChange({ target: { value: 'add' } })
  await new Promise((resolve) => setTimeout(resolve, 450))
  treeWithSymbol = Body(propsWithSymbol)
  walk(treeWithSymbol)
  await new Promise((resolve) => setTimeout(resolve, 20))
  treeWithSymbol = Body(propsWithSymbol)
}
check('search endpoint is queried with the typed query', fetchCalls.some((call) => call.url.includes('/search') && call.url.includes('q=add')), fetchCalls.map((call) => call.url).slice(-4).join(', '))

// Clicking a result row must open the definition at its line via openResource.
const rows = collect(treeWithSymbol, (element) => element.type === 'button' && element.props?.className === 'dsh-ci-row-open')
check('search result rows rendered', rows.length >= 1, `rows=${rows.length}`)
if (rows.length > 0) {
  try {
    rows[0].props.onClick()
  } catch (error) {
    console.log('  click threw:', error)
  }
}
check('clicking a result opens the file at its 1-based line', openCalls.length >= 1, JSON.stringify(openCalls).slice(0, 200))
if (openCalls.length > 0) {
  const call = openCalls[0]
  check('openResource uses a session-scoped address', typeof call.address === 'string' && call.address.startsWith('dsh-resource://file/session/session-1/'), call.address)
  check('openResource carries the line param', call.options?.params?.line === 3, JSON.stringify(call.options))
}

console.log(failures === 0 ? '\nCLIENT PASS' : `\nCLIENT FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
