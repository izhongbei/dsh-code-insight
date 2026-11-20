/**
 * Host HTTP routes behind the Code Insight browser panel.
 *
 * The Web client cannot call model tools directly, so the panel talks to this
 * small authenticated JSON API. Every route is registered on the Connection
 * service's exact-fetch channel (`/api/...`); the browser authenticates with
 * the HttpOnly cookie the Web app already holds, so a plain same-origin
 * `fetch('api/code-insight/...')` is all the client needs.
 *
 * The routes are optional: headless compositions have no `connection` service,
 * and the eight model tools keep working without them.
 */
import * as path from 'node:path'

/** Workspace roots are accepted from the browser only as absolute directories. */
function normalizeWorkspace(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return path.resolve(value.trim())
}

/** JSON response with no-store caching. */
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** Successful payload (`{ ok: true, value }`, matching the ecosystem's route envelope). */
function ok(value) {
  return json({ ok: true, value })
}

/** Failure payload (`{ ok: false, error: { code, message } }`). */
function fail(code, message, status = 400) {
  return json({ ok: false, error: { code, message } }, status)
}

/** Request URL, tolerating a relative request URL in a mock/test carrier. */
function requestUrl(request) {
  try {
    return new URL(request.url)
  } catch {
    return new URL(request.url, 'http://127.0.0.1')
  }
}

/** Read one integer query parameter within bounds. */
function intParam(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** Read a boolean query parameter (`1`, `true`, `yes`). */
function boolParam(url, name) {
  const raw = url.searchParams.get(name)
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/** Read one string query parameter, trimmed; empty becomes undefined. */
function strParam(url, name) {
  const raw = url.searchParams.get(name)
  if (raw === null) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Resolve the workspace for one request: explicit `workspace`, else the
 * calling session's committed working directory, else the host process cwd.
 * @returns the absolute workspace root.
 */
async function resolveWorkspace(ctx, ref) {
  const explicit = normalizeWorkspace(ref.workspace)
  if (explicit !== undefined) return explicit
  const sessionId = typeof ref.sessionId === 'string' ? ref.sessionId : undefined
  if (sessionId !== undefined) {
    try {
      const sessions = ctx.get('sessions')
      const session = sessions?.get?.(sessionId)
      if (session !== undefined) {
        const cwd = ctx.get('workingDirectory')?.get?.(session)
        if (typeof cwd === 'string' && cwd !== '') return cwd
        if (typeof session.header?.cwd === 'string' && session.header.cwd !== '') return session.header.cwd
      }
    } catch {
      // fall through to the deployment default
    }
  }
  return process.cwd()
}

/**
 * Load (or start building) the workspace index and produce its readiness.
 * @returns `{ index, status, ready }`
 */
async function ensureIndex(manager, workspace) {
  const index = manager.indexFor(workspace)
  await index.ensureLoaded()
  let status = await index.status()
  if (index.snapshot === undefined && manager.config.autoBuild !== false && !status.building) {
    index.startBuild({ force: false })
    status = await index.status()
  }
  if (index.snapshot !== undefined) index.maybeRefresh()
  return { index, status, ready: index.snapshot !== undefined }
}

/** A stable, JSON-safe readiness block shared by every query response. */
function readiness(status, ready) {
  const value = {
    workspace: status.workspace,
    ready,
    building: status.building === true,
    state: status.state,
    progress: status.progress ?? null,
    files: status.files,
    symbols: status.symbols,
    roots: status.roots,
    builtAt: status.builtAt,
    ageSeconds: status.ageSeconds,
    error: status.error,
    message: ready
      ? undefined
      : status.building
        ? 'index is building; retry in a moment'
        : 'no index yet; a build was started in the background',
  }
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]
  return value
}

/** The eight-symbol-kind filter used by the search route. */
const SYMBOL_KINDS = [
  'function',
  'declaration',
  'macro',
  'struct',
  'union',
  'enum',
  'typedef',
  'member',
  'enumConstant',
  'variable',
]

/**
 * Build all route definitions.
 * @param manager - plugin index manager.
 * @returns route registrations for `connection.fetch.register`.
 */
function buildRoutes(ctx, manager) {
  /** GET /api/code-insight/status */
  const statusRoute = {
    path: '/api/code-insight/status',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = requestUrl(request)
        const workspace = await resolveWorkspace(ctx, {
          workspace: strParam(url, 'workspace'),
          sessionId: strParam(url, 'sessionId'),
        })
        const index = manager.indexFor(workspace)
        await index.ensureLoaded()
        const status = await index.status()
        return ok({ ...readiness(status, index.snapshot !== undefined), lastBuild: status.lastBuild })
      } catch (error) {
        return fail('internal', error instanceof Error ? error.message : String(error), 500)
      }
    },
  }

  /** GET /api/code-insight/search?q=… */
  const searchRoute = {
    path: '/api/code-insight/search',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = requestUrl(request)
        const query = strParam(url, 'q')
        if (query === undefined) return fail('bad-request', 'missing q')
        const workspace = await resolveWorkspace(ctx, {
          workspace: strParam(url, 'workspace'),
          sessionId: strParam(url, 'sessionId'),
        })
        const { index, status, ready } = await ensureIndex(manager, workspace)
        const base = readiness(status, ready)
        if (!ready) return ok({ ...base, q: query, hits: [] })
        const limit = intParam(url, 'limit', 30, 1, 200)
        const kinds = (strParam(url, 'kinds') ?? '')
          .split(',')
          .map((kind) => kind.trim())
          .filter((kind) => SYMBOL_KINDS.includes(kind))
        const entries = index.search(query, limit, kinds.length > 0 ? kinds : undefined)
        const signatures = await index.signatures(entries.slice(0, 20))
        const hits = entries.map((entry, position) => {
          const hit = {
            name: entry.name,
            kind: entry.kind,
            file: entry.file,
            line: entry.line + 1,
            end_line: Math.max(entry.line, entry.endLine) + 1,
          }
          if (entry.condition !== undefined && entry.condition !== '') hit.condition = entry.condition
          if (signatures[position] !== undefined) hit.signature = signatures[position]
          return hit
        })
        return ok({ ...base, q: query, hits })
      } catch (error) {
        return fail('internal', error instanceof Error ? error.message : String(error), 500)
      }
    },
  }

  /** GET /api/code-insight/graph?symbol=… */
  const graphRoute = {
    path: '/api/code-insight/graph',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = requestUrl(request)
        const symbol = strParam(url, 'symbol')
        if (symbol === undefined) return fail('bad-request', 'missing symbol')
        const workspace = await resolveWorkspace(ctx, {
          workspace: strParam(url, 'workspace'),
          sessionId: strParam(url, 'sessionId'),
        })
        const { index, status, ready } = await ensureIndex(manager, workspace)
        const base = readiness(status, ready)
        if (!ready) return ok({ ...base, symbol, depth: 2, direction: 'both', nodes: [], edges: [], truncated: false })
        const depth = intParam(url, 'depth', 2, 1, 4)
        const direction = ['both', 'callers', 'callees'].includes(strParam(url, 'direction'))
          ? strParam(url, 'direction')
          : 'both'
        const maxNodes = intParam(url, 'max_nodes', 30, 1, 100)
        const maxChildren = intParam(url, 'max_children', 8, 1, 50)
        const graph = await index.graph(symbol, { depth, direction, maxNodes, maxChildren })
        const definition = index.definitions(symbol).find((entry) => entry.kind === 'function')
        const signature = definition === undefined ? undefined : await index.signatures([definition])
        return ok({
          ...base,
          symbol,
          depth,
          direction,
          ...graph,
          definition:
            definition === undefined
              ? undefined
              : {
                  file: definition.file,
                  line: definition.line + 1,
                  end_line: Math.max(definition.line, definition.endLine) + 1,
                  kind: definition.kind,
                  signature: signature?.[0],
                },
        })
      } catch (error) {
        return fail('internal', error instanceof Error ? error.message : String(error), 500)
      }
    },
  }

  /** GET /api/code-insight/outline?file=… */
  const outlineRoute = {
    path: '/api/code-insight/outline',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = requestUrl(request)
        const file = strParam(url, 'file')
        if (file === undefined) return fail('bad-request', 'missing file')
        const workspace = await resolveWorkspace(ctx, {
          workspace: strParam(url, 'workspace'),
          sessionId: strParam(url, 'sessionId'),
        })
        const { index, status, ready } = await ensureIndex(manager, workspace)
        const base = readiness(status, ready)
        const relative = toRelativePath(workspace, file)
        if (!ready) return ok({ ...base, file: relative, symbols: [] })
        const entries = index.fileSymbols(relative).slice(0, intParam(url, 'limit', 400, 1, 2000))
        const signatures = boolParam(url, 'signatures') ? await index.signatures(entries) : []
        const symbols = entries.map((entry, position) => {
          const symbol = {
            name: entry.name,
            kind: entry.kind,
            line: entry.line + 1,
            end_line: Math.max(entry.line, entry.endLine) + 1,
          }
          if (entry.condition !== undefined && entry.condition !== '') symbol.condition = entry.condition
          if (signatures[position] !== undefined) symbol.signature = signatures[position]
          return symbol
        })
        return ok({ ...base, file: relative, symbols })
      } catch (error) {
        return fail('internal', error instanceof Error ? error.message : String(error), 500)
      }
    },
  }

  /** GET /api/code-insight/definition?name=… */
  const definitionRoute = {
    path: '/api/code-insight/definition',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = requestUrl(request)
        const name = strParam(url, 'name')
        if (name === undefined) return fail('bad-request', 'missing name')
        const workspace = await resolveWorkspace(ctx, {
          workspace: strParam(url, 'workspace'),
          sessionId: strParam(url, 'sessionId'),
        })
        const { index, status, ready } = await ensureIndex(manager, workspace)
        const base = readiness(status, ready)
        const sourceFileParam = strParam(url, 'source_file')
        const sourceFile = sourceFileParam === undefined ? undefined : toRelativePath(workspace, sourceFileParam)
        if (!ready) return ok({ ...base, name, definitions: [] })
        const all = index.definitions(name)
        const bodies = all.filter((entry) => entry.kind !== 'declaration')
        const candidates = boolParam(url, 'include_declarations') || bodies.length === 0 ? all : bodies
        const groups = index.groupedDefinitionsFrom(candidates, sourceFile)
        const rows = []
        for (const group of groups.slice(0, intParam(url, 'limit', 10, 1, 50))) {
          const signature = await index.signatures([group.representative])
          rows.push({
            name: group.representative.name,
            kind: group.representative.kind,
            file: group.representative.file,
            line: group.representative.line + 1,
            end_line: Math.max(group.representative.line, group.representative.endLine) + 1,
            included: group.included,
            conditional: group.conditional,
            copies: group.copies,
            signature: signature?.[0],
            condition:
              group.representative.condition === undefined || group.representative.condition === ''
                ? undefined
                : group.representative.condition,
          })
        }
        return ok({ ...base, name, definitions: rows })
      } catch (error) {
        return fail('internal', error instanceof Error ? error.message : String(error), 500)
      }
    },
  }

  /** GET /api/code-insight/references?name=… */
  const referencesRoute = {
    path: '/api/code-insight/references',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = requestUrl(request)
        const name = strParam(url, 'name')
        if (name === undefined) return fail('bad-request', 'missing name')
        const workspace = await resolveWorkspace(ctx, {
          workspace: strParam(url, 'workspace'),
          sessionId: strParam(url, 'sessionId'),
        })
        const { index, status, ready } = await ensureIndex(manager, workspace)
        const base = readiness(status, ready)
        if (!ready) return ok({ ...base, name, references: [] })
        const includeDeclaration = boolParam(url, 'include_declaration')
        const hits = await index.references(name, {
          limit: intParam(url, 'limit', 200, 1, 2000),
          includeDeclaration,
        })
        return ok({
          ...base,
          name,
          references: hits.map((hit) => ({
            file: hit.file,
            line: hit.line + 1,
            column: hit.column + 1,
            preview: hit.preview,
          })),
        })
      } catch (error) {
        return fail('internal', error instanceof Error ? error.message : String(error), 500)
      }
    },
  }

  /** POST /api/code-insight/build  { action, workspace?, sessionId?, wait_seconds? } */
  const buildRoute = {
    path: '/api/code-insight/build',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        let body = {}
        try {
          body = await request.json()
        } catch {
          body = {}
        }
        const action = ['build', 'rebuild', 'clear', 'status'].includes(body.action) ? body.action : 'status'
        const workspace = await resolveWorkspace(ctx, {
          workspace: typeof body.workspace === 'string' ? body.workspace : undefined,
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        })
        const index = manager.indexFor(workspace)
        await index.ensureLoaded()
        if (action === 'build' || action === 'rebuild') {
          const waitSeconds = Number.isFinite(body.wait_seconds)
            ? Math.min(600, Math.max(0, Math.floor(body.wait_seconds)))
            : 0
          const building = index.startBuild({ force: action === 'rebuild' })
          if (waitSeconds > 0) await waitFor(building, waitSeconds)
        } else if (action === 'clear') {
          await index.clear()
        }
        const status = await index.status()
        return ok({ ...readiness(status, index.snapshot !== undefined), action, lastBuild: status.lastBuild })
      } catch (error) {
        return fail('internal', error instanceof Error ? error.message : String(error), 500)
      }
    },
  }

  return [
    statusRoute,
    searchRoute,
    graphRoute,
    outlineRoute,
    definitionRoute,
    referencesRoute,
    buildRoute,
  ]
}

/** Workspace-relative posix path for a browser-supplied path. */
function toRelativePath(workspace, file) {
  const slash = file.replace(/\\/g, '/')
  const root = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
  if (slash === root) return ''
  if (slash.startsWith(`${root}/`)) return slash.slice(root.length + 1)
  return slash.replace(/^\.\/+/, '')
}

/** Await a build for at most `seconds`, then report the current status. */
async function waitFor(promise, seconds) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, seconds * 1000)
    timer.unref?.()
  })
  try {
    await Promise.race([promise.catch(() => undefined), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Register the panel API on the Connection service when this composition has a
 * Web carrier. Headless compositions simply skip it.
 * @param ctx - plugin host context.
 * @param manager - plugin index manager.
 * @param logger - plugin logger.
 */
export function registerRoutes(ctx, manager, logger) {
  try {
    ctx.inject(['connection'], (injected) => {
      try {
        const connection = injected.get('connection')
        const register = connection?.fetch?.register
        if (typeof register !== 'function') {
          logger.warn('[code-insight] connection service has no fetch.register; panel API disabled')
          return
        }
        const routes = buildRoutes(injected, manager)
        for (const route of routes) {
          injected.effect(
            () => register.call(connection.fetch, route),
            `code-insight: route ${route.path}`,
          )
        }
        logger.info(`[code-insight] panel API registered (${routes.length} routes)`)
      } catch (error) {
        logger.warn(`[code-insight] cannot register panel API: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    logger.warn(`[code-insight] cannot subscribe to the connection service: ${error instanceof Error ? error.message : String(error)}`)
  }
}
