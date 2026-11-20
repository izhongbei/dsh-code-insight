/**
 * Code Insight index manager for the DeepSeek Harness.
 *
 * Owns one persistent C/C++ symbol index per workspace root:
 * - build/refresh through the vendored Code Insight core (`buildIndex`);
 * - load the binary snapshot (`symbols.sidx`) and the identifier name index;
 * - serve search / definitions / references / callers / callees / outline
 *   queries from memory.
 *
 * The heavy lifting stays in the vendored core (unmodified Code Insight
 * `src/core`); this module only supplies the host glue the VS Code extension
 * keeps in `src/vscode/service.ts`: where the cache lives, latin1 file reads,
 * background build state, and cache invalidation.
 */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const require = createRequire(import.meta.url)
const CORE = './vendor/src/core/'

const { buildIndex, indexRootsChanged } = require(`${CORE}indexer.js`)
const { loadSnapshot } = require(`${CORE}store.js`)
const { loadNameIndexWithDelta, nameIndexDeltaPath } = require(`${CORE}nameindex.js`)
const { searchSymbols, findByName, entriesInFile } = require(`${CORE}query.js`)
const { groupDefinitions } = require(`${CORE}definition-groups.js`)
const { findReferences, clearReferenceCache } = require(`${CORE}references.js`)
const { callersOf, calleesOf, clearCallGraphCache } = require(`${CORE}callgraph.js`)
const { readSignature } = require(`${CORE}signature.js`)
const { snapshotDeltaPath } = require(`${CORE}snapshot-delta.js`)
const { DEFAULT_EXCLUDE } = require('./vendor/src/shared/types.js')

/** Snapshot file name inside one workspace cache directory (matches the extension). */
const SNAPSHOT_FILE = 'symbols.sidx'
/** Identifier-index file name inside one workspace cache directory. */
const NAME_INDEX_FILE = 'symbols.names'
/** Cached workspace indexes kept in memory at once. */
const MAX_CACHED_WORKSPACES = 3
/** Auto concurrency downgrade for very large trees (same default as the extension). */
const CONCURRENCY_DOWNGRADE = { files: 80_000, concurrency: 2 }
/** Signature text cache budget (bytes of JS string data, not UTF-8 bytes). */
const SIGNATURE_CACHE_CHARS = 8 * 1024 * 1024
const SIGNATURE_CACHE_FILES = 256

/** Whether an error came from a cooperative abort. */
export function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError'
}

/** Build the error text shown to the model. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Normalize one configured index root to a workspace-relative posix prefix. */
export function normalizeIndexRoot(workspaceRoot, root) {
  let rel = typeof root === 'string' ? root.trim() : ''
  if (rel === '') return ''
  if (path.isAbsolute(rel)) rel = path.relative(workspaceRoot, rel)
  rel = rel.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  if (rel === '.') rel = ''
  return rel.replace(/\/+$/, '')
}

/** Normalize configured roots: dedupe, preserve order (order is include priority). */
export function normalizeIndexRoots(workspaceRoot, roots) {
  const list = Array.isArray(roots) ? roots : []
  const normalized = []
  for (const raw of list) {
    const value = normalizeIndexRoot(workspaceRoot, raw)
    if (!normalized.includes(value)) normalized.push(value)
  }
  // An empty root list means "nothing explicitly selected"; treat it as the
  // whole workspace so the default configuration indexes something useful.
  return normalized.length > 0 ? normalized : ['']
}

/** Make a filesystem-safe cache directory name for one workspace root. */
function workspaceSlug(workspaceRoot) {
  const resolved = canonicalWorkspace(workspaceRoot)
  const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 48) || 'workspace'
  const hash = createHash('sha1').update(resolved).digest('hex').slice(0, 16)
  return `${base}-${hash}`
}

/** realpath when possible so symlinked spellings of one workspace share an index. */
function canonicalWorkspace(workspaceRoot) {
  try {
    return realpathSync.native(workspaceRoot)
  } catch {
    return path.resolve(workspaceRoot)
  }
}

/** Resolve the harness home without adding a runtime dependency. */
function resolveDshHome(ctx) {
  try {
    const configured = ctx?.get?.('dshHomePath')
    if (typeof configured === 'string' && configured.trim() !== '') return configured
  } catch {
    // ignore: fall back to the environment
  }
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.dsh')
}

/** Clamp a configured number into [min, max]; non-finite values fall back. */
function clampNumber(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** Everything the tools need to render "not ready yet" responses. */
function emptyStatus(workspace, config) {
  return {
    workspace,
    state: 'empty',
    ready: false,
    building: false,
    progress: null,
    files: 0,
    symbols: 0,
    roots: normalizeIndexRoots(workspace, config.indexRoots),
    builtAt: undefined,
    ageSeconds: undefined,
    snapshotBytes: 0,
    nameIndexReady: false,
    lastBuild: null,
    error: undefined,
    autoBuild: config.autoBuild !== false,
    autoRefreshMinutes: config.autoRefreshMinutes ?? 10,
  }
}

/** One workspace's index: disk-backed snapshot plus in-memory query state. */
class WorkspaceIndex {
  constructor(manager, workspaceRoot) {
    this.manager = manager
    this.config = manager.config
    this.logger = manager.logger
    this.workspaceRoot = workspaceRoot
    this.dir = path.join(manager.cacheRoot, workspaceSlug(workspaceRoot))
    this.snapshotPath = path.join(this.dir, SNAPSHOT_FILE)
    this.nameIndexPath = path.join(this.dir, NAME_INDEX_FILE)
    this.snapshot = undefined
    this.nameIndex = undefined
    this.builtAt = undefined
    this.lastSummary = undefined
    this.progress = undefined
    this.error = undefined
    this.loadPromise = undefined
    this.building = undefined
    this.abort = undefined
    this.lastRefreshAt = 0
    this.textCache = new Map()
    this.textCacheChars = 0
    this.disposed = false
    this.readFileBound = (relativePath) => this.readFile(relativePath)
    this.readFileCachedBound = (relativePath) => this.readFileCached(relativePath)
  }

  /** Configured index roots in build form (workspace-relative posix, '' = workspace). */
  roots() {
    return normalizeIndexRoots(this.workspaceRoot, this.config.indexRoots)
  }

  /** Whether the on-disk snapshot was built with different roots. */
  rootsChanged(table = this.snapshot) {
    if (table === undefined) return false
    try {
      return indexRootsChanged(this.workspaceRoot, table.roots, this.roots())
    } catch {
      return true
    }
  }

  /** Read a workspace-relative file as latin1 (1 byte = 1 char, matching core). */
  async readFile(relativePath) {
    return fsp.readFile(path.join(this.workspaceRoot, relativePath), 'latin1')
  }

  /** Small LRU-ish text cache for signature reconstruction. */
  async readFileCached(relativePath) {
    const cached = this.textCache.get(relativePath)
    if (cached !== undefined) {
      this.textCache.delete(relativePath)
      this.textCache.set(relativePath, cached)
      return cached
    }
    const text = await this.readFile(relativePath)
    this.textCache.set(relativePath, text)
    this.textCacheChars += text.length
    while (
      (this.textCacheChars > SIGNATURE_CACHE_CHARS || this.textCache.size > SIGNATURE_CACHE_FILES) &&
      this.textCache.size > 1
    ) {
      const oldestKey = this.textCache.keys().next().value
      if (oldestKey === undefined) break
      const oldest = this.textCache.get(oldestKey) ?? ''
      this.textCache.delete(oldestKey)
      this.textCacheChars -= oldest.length
    }
    return text
  }

  /** Load the persisted snapshot (once) and make it queryable. */
  async ensureLoaded() {
    if (this.snapshot !== undefined) return this.snapshot
    if (this.loadPromise === undefined) {
      this.loadPromise = (async () => {
        await fsp.mkdir(this.dir, { recursive: true })
        let table
        try {
          table = await loadSnapshot(this.snapshotPath)
        } catch (error) {
          this.logger.warn(`[code-insight] cannot load snapshot: ${errorText(error)}`)
        }
        if (table !== undefined) {
          this.snapshot = table
          this.builtAt = table.builtAt
          this.logger.info(`[code-insight] loaded ${table.entryCount} symbols from ${table.fileCount} files`)
        }
        clearReferenceCache()
        clearCallGraphCache()
        return this.snapshot
      })().finally(() => {
        this.loadPromise = undefined
      })
    }
    return this.loadPromise
  }

  /** Lazily load the identifier name index used by references/callers. */
  async ensureNameIndex() {
    if (this.nameIndex !== undefined) return this.nameIndex
    await this.ensureLoaded()
    if (this.snapshot === undefined) return undefined
    const pending = (async () => {
      let data
      try {
        data = await loadNameIndexWithDelta(this.nameIndexPath)
      } catch (error) {
        this.logger.warn(`[code-insight] cannot load name index: ${errorText(error)}`)
      }
      if (data !== undefined) this.nameIndex = data
      return data
    })()
    const loaded = await pending
    return loaded
  }

  /** Start a build unless one is already running. Never throws synchronously. */
  startBuild({ force = false } = {}) {
    if (this.building !== undefined) return this.building
    this.error = undefined
    const controller = new AbortController()
    this.abort = controller
    const promise = this.runBuild({ force, signal: controller.signal }).finally(() => {
      if (this.building === promise) this.building = undefined
      if (this.abort === controller) this.abort = undefined
    })
    // Background builds must never surface as unhandled rejections.
    promise.catch(() => undefined)
    this.building = promise
    return promise
  }

  /** Run one incremental (or forced full) build and install the new snapshot. */
  async runBuild({ force = false, signal }) {
    const roots = this.roots()
    const config = this.config
    const previous =
      force || this.snapshot === undefined || this.rootsChanged()
        ? undefined
        : this.snapshot
    this.progress = { phase: 'walk', done: 0, total: 0 }
    this.logger.info(`[code-insight] build start roots=${JSON.stringify(roots)} force=${String(force)}`)
    try {
      await fsp.mkdir(this.dir, { recursive: true })
      const { snapshot, summary } = await buildIndex({
        workspaceRoot: this.workspaceRoot,
        roots,
        exclude: Array.isArray(config.exclude) && config.exclude.length > 0 ? config.exclude : [...DEFAULT_EXCLUDE],
        maxFileSizeKB: clampNumber(config.maxFileSizeKB, 4096, 1, 1_048_576),
        concurrency: clampNumber(config.concurrency, 4, 1, 64),
        concurrencyDowngrade: CONCURRENCY_DOWNGRADE,
        followSymlinks: config.followSymlinks === true,
        previous,
        snapshotPath: this.snapshotPath,
        nameIndexPath: this.nameIndexPath,
        readFile: this.readFileBound,
        signal,
        onProgress: (progress) => {
          this.progress = progress
        },
      })
      if (this.disposed) return summary
      this.snapshot = snapshot
      this.builtAt = snapshot.builtAt || Date.now()
      this.lastSummary = summary
      this.nameIndex = undefined
      this.textCache.clear()
      this.textCacheChars = 0
      clearReferenceCache()
      clearCallGraphCache()
      this.logger.info(
        `[code-insight] build done files=${summary.files} symbols=${summary.entries} ` +
          `added=${summary.added} updated=${summary.updated} removed=${summary.removed} ` +
          `unchanged=${summary.unchanged} in ${summary.durationMs}ms`,
      )
      return summary
    } catch (error) {
      if (!isAbortError(error)) {
        this.error = errorText(error)
        this.logger.error(`[code-insight] build failed: ${this.error}`)
      }
      throw error
    } finally {
      this.progress = undefined
      this.lastRefreshAt = Date.now()
    }
  }

  /**
   * Start a background refresh when the index is old (or built for other
   * roots). Queries keep answering from the current snapshot meanwhile.
   */
  maybeRefresh() {
    if (this.disposed || this.snapshot === undefined || this.building !== undefined) return
    const minutes = clampNumber(this.config.autoRefreshMinutes, 10, 0, 24 * 60)
    const rootsMoved = this.rootsChanged()
    if (!rootsMoved) {
      if (minutes <= 0) return
      const ageMs = Date.now() - (this.builtAt ?? 0)
      if (ageMs < minutes * 60_000) return
    }
    this.startBuild({ force: false })
  }

  /** Remove persisted snapshot/name-index files and drop in-memory state. */
  async clear() {
    if (this.building !== undefined) {
      this.abort?.abort()
      try {
        await this.building
      } catch {
        // cleared regardless
      }
    }
    const files = [
      this.snapshotPath,
      this.nameIndexPath,
      snapshotDeltaPath(this.snapshotPath),
      nameIndexDeltaPath(this.nameIndexPath),
    ]
    for (const file of files) {
      try {
        await fsp.rm(file, { force: true })
      } catch (error) {
        this.logger.warn(`[code-insight] cannot remove ${file}: ${errorText(error)}`)
      }
    }
    this.snapshot = undefined
    this.nameIndex = undefined
    this.builtAt = undefined
    this.lastSummary = undefined
    this.progress = undefined
    this.error = undefined
    this.textCache.clear()
    this.textCacheChars = 0
    clearReferenceCache()
    clearCallGraphCache()
    return this.status()
  }

  /** Snapshot of everything `code_insight_index` reports. */
  async status() {
    const stack = emptyStatus(this.workspaceRoot, this.config)
    const snapshot = this.snapshot
    const builtAt = this.builtAt
    const building = this.building !== undefined
    return {
      ...stack,
      state: building ? 'building' : snapshot !== undefined ? 'ready' : this.error !== undefined ? 'error' : 'empty',
      ready: snapshot !== undefined,
      building,
      progress: this.progress ?? null,
      files: snapshot?.fileCount ?? 0,
      symbols: snapshot?.entryCount ?? 0,
      builtAt: builtAt ? new Date(builtAt).toISOString() : undefined,
      ageSeconds: builtAt ? Math.max(0, Math.round((Date.now() - builtAt) / 1000)) : undefined,
      nameIndexReady: this.nameIndex !== undefined,
      lastBuild: this.lastSummary ?? null,
      error: this.error ?? undefined,
      snapshotHint:
        snapshot !== undefined && this.rootsChanged()
          ? 'roots changed since this snapshot; rebuild recommended'
          : undefined,
      snapshotBytes: await this.sizeOnDisk(),
      cacheDir: this.dir,
    }
  }

  /** Current snapshot size on disk in bytes (0 when absent). */
  async sizeOnDisk() {
    try {
      const stat = await fsp.stat(this.snapshotPath)
      return stat.size
    } catch {
      return 0
    }
  }

  dispose() {
    this.disposed = true
    this.abort?.abort()
    this.snapshot = undefined
    this.nameIndex = undefined
    this.textCache.clear()
    this.textCacheChars = 0
  }

  // ---- queries ---------------------------------------------------------

  search(query, limit, kinds) {
    return searchSymbols(this.snapshot, query, {
      limit,
      kinds: Array.isArray(kinds) && kinds.length > 0 ? kinds : undefined,
    })
  }

  definitions(name) {
    return findByName(this.snapshot, name)
  }

  groupedDefinitions(name, sourceFile) {
    return this.groupedDefinitionsFrom(this.definitions(name), sourceFile)
  }

  /** Rank and fold an already-filtered candidate list. */
  groupedDefinitionsFrom(entries, sourceFile) {
    return groupDefinitions(entries, {
      sourceFile,
      roots: this.roots(),
      table: this.snapshot,
    })
  }

  signatures(entries) {
    return Promise.all(
      entries.map(async (entry) => {
        try {
          return await readSignature(this.readFileCachedBound, entry)
        } catch {
          return undefined
        }
      }),
    )
  }

  async references(name, { limit, includeDeclaration, signal }) {
    await this.ensureNameIndex()
    const hits = await findReferences(this.snapshot, name, this.readFileBound, {
      nameIndex: this.nameIndex,
      includeDeclaration,
      signal,
    })
    return hits.slice(0, limit)
  }

  async callers(name, { limit, signal }) {
    await this.ensureNameIndex()
    const hits = await callersOf(this.snapshot, name, this.readFileBound, {
      nameIndex: this.nameIndex,
      signal,
    })
    return hits.slice(0, limit)
  }

  async callees(name, { limit, signal }) {
    const entries = await calleesOf(this.snapshot, name, this.readFileBound, { signal })
    return entries.slice(0, limit)
  }

  /**
   * Expand the call graph around one function: callers on one side, callees on
   * the other, breadth-first up to `depth`, capped by nodes/children.
   * Shared by the model tool and the browser panel.
   * @returns {{nodes: object[], edges: object[], truncated: boolean}}
   */
  async graph(name, { depth = 2, direction = 'both', maxNodes = 30, maxChildren = 8, signal } = {}) {
    const definitions = this.definitions(name).filter((entry) => entry.kind === 'function')
    const rootEntry = definitions[0]
    const nodes = [
      {
        id: 0,
        name,
        kind: rootEntry?.kind ?? 'function',
        file: rootEntry?.file ?? '',
        line: rootEntry === undefined ? 0 : rootEntry.line + 1,
        depth: 0,
        relation: 'root',
        truncated_children: false,
      },
    ]
    const edges = []
    const byKey = new Map([[`${name}|${rootEntry?.file ?? ''}|${rootEntry?.line ?? -1}`, 0]])
    const nodeById = new Map([[0, nodes[0]]])
    const queue = [{ id: 0, name, depth: 0 }]
    let truncated = false
    const addNode = (entry, relation, level) => {
      const key = `${entry.name}|${entry.file}|${entry.line}`
      const existing = byKey.get(key)
      if (existing !== undefined) return existing
      if (nodes.length > maxNodes) {
        truncated = true
        return undefined
      }
      const id = nodes.length
      nodes.push({
        id,
        name: entry.name,
        kind: entry.kind,
        file: entry.file,
        line: entry.line + 1,
        depth: level,
        relation,
        truncated_children: false,
      })
      nodeById.set(id, nodes[nodes.length - 1])
      byKey.set(key, id)
      return id
    }
    while (queue.length > 0) {
      if (nodes.length > maxNodes) {
        truncated = true
        break
      }
      const current = queue.shift()
      if (current === undefined || current.depth >= depth) continue
      signal?.throwIfAborted?.()
      const currentEntry = nodeById.get(current.id)
      if (direction !== 'callees') {
        const callers = await this.callers(current.name, { limit: maxChildren + 1, signal })
        const seen = new Set()
        let count = 0
        for (const hit of callers) {
          if (count >= maxChildren) {
            currentEntry.truncated_children = true
            truncated = true
            break
          }
          const callerEntry =
            hit.from === undefined
              ? { name: `<file scope: ${hit.file}>`, kind: 'function', file: hit.file, line: hit.line, endLine: hit.line }
              : hit.from
          const key = `${callerEntry.name}|${callerEntry.file}|${callerEntry.line}`
          const previous = byKey.get(key)
          if (previous !== undefined) {
            if (!edges.some((edge) => edge.from === previous && edge.to === current.id)) {
              edges.push({ from: previous, to: current.id, relation: 'calls' })
            }
            continue
          }
          if (seen.has(key)) continue
          seen.add(key)
          const id = addNode(callerEntry, 'caller', current.depth + 1)
          if (id === undefined) break
          count += 1
          edges.push({ from: id, to: current.id, relation: 'calls' })
          queue.push({ id, name: callerEntry.name, depth: current.depth + 1 })
        }
      }
      if (direction !== 'callers') {
        const callees = await this.callees(current.name, { limit: maxChildren + 1, signal })
        let count = 0
        for (const entry of callees) {
          if (count >= maxChildren) {
            currentEntry.truncated_children = true
            truncated = true
            break
          }
          const id = addNode(entry, 'callee', current.depth + 1)
          if (id === undefined) break
          count += 1
          if (!edges.some((edge) => edge.from === current.id && edge.to === id)) {
            edges.push({ from: current.id, to: id, relation: 'calls' })
          }
          queue.push({ id, name: entry.name, depth: current.depth + 1 })
        }
      }
    }
    return { nodes, edges, truncated }
  }

  fileSymbols(relativePath) {
    return entriesInFile(this.snapshot, relativePath)
  }
}

/** Manager of per-workspace indexes for one plugin instance. */
export class IndexManager {
  constructor({ ctx, config, logger }) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
    this.cacheRoot =
      typeof config.cacheDir === 'string' && config.cacheDir.trim() !== ''
        ? config.cacheDir.trim()
        : path.join(resolveDshHome(ctx), 'storages', 'code-insight')
    /** @type {Map<string, WorkspaceIndex>} */
    this.indexes = new Map()
  }

  /** Get (or create) the index for one workspace root. */
  indexFor(workspaceRoot) {
    const key = canonicalWorkspace(workspaceRoot)
    const existing = this.indexes.get(key)
    if (existing !== undefined) {
      // Refresh LRU order.
      this.indexes.delete(key)
      this.indexes.set(key, existing)
      return existing
    }
    const created = new WorkspaceIndex(this, key)
    this.indexes.set(key, created)
    while (this.indexes.size > MAX_CACHED_WORKSPACES) {
      const oldestKey = this.indexes.keys().next().value
      if (oldestKey === undefined) break
      const oldest = this.indexes.get(oldestKey)
      this.indexes.delete(oldestKey)
      oldest?.dispose()
    }
    return created
  }

  /** Stop all background work and drop snapshots. */
  dispose() {
    for (const index of this.indexes.values()) index.dispose()
    this.indexes.clear()
  }
}

/** Create the manager used by `apply`. */
export function createIndexManager(options) {
  return new IndexManager(options)
}
