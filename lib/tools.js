/**
 * Model-facing tools of the Code Insight plugin.
 *
 * Each tool answers from the persistent symbol index managed by
 * `lib/manager.js`; none of them greps the workspace. When the index does not
 * exist yet the plugin starts a background build and returns a short
 * "index is building" answer instead of blocking the turn.
 */
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { defineTool } from '@deepseek-ai/dsh-tools'

const require = createRequire(import.meta.url)
const { groupDefinitions } = require('./vendor/src/core/definition-groups.js')

/** Symbol kinds shared with the core contract (`src/shared/types.ts`). */
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

/** Clamp a model-supplied integer parameter. */
function clampInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/** One model-facing text block. */
function text(value) {
  return [{ type: 'text', text: String(value) }]
}

/**
 * Drop `undefined` properties recursively: canonical tool values must be
 * lossless JSON, and an explicit undefined property fails output validation.
 */
function prune(value) {
  if (Array.isArray(value)) return value.map(prune)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = prune(item)
    }
    return out
  }
  return value
}

/** Trim a symbol query down to the bare identifier. */
function cleanSymbolName(raw) {
  let name = typeof raw === 'string' ? raw.trim() : ''
  if (name === '') return ''
  name = name.replace(/\s*\([^()]*\)\s*$/, '')
  name = name.replace(/^(?:struct|union|enum|typedef|extern|static|inline|volatile|const)\s+/, '')
  name = name.replace(/^[&*]+/, '')
  return name.trim()
}

/** Workspace-relative posix path for a model/model-supplied path. */
function toWorkspaceRelative(workspace, rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return ''
  let value = rawPath.trim()
  if (path.isAbsolute(value)) value = path.relative(workspace, value)
  value = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (value.startsWith('./')) value = value.slice(2)
  return value.replace(/\/+$/, '')
}

/** 1-based `file:line` for humans and for follow-up `read` calls. */
function location(entry) {
  return `${entry.file}:${entry.line + 1}`
}

/** Short kind tag used by the renderers. */
function kindTag(entry) {
  return `[${entry.kind}]`
}

/** Condition text (raw `#ifdef` expression) reported by the scanner. */
function conditionText(entry) {
  const condition = entry.condition
  return condition === undefined || condition === '' ? '' : `  (${condition})`
}

/** Resolve the calling session's committed working directory. */
async function resolveWorkspace(ctx, exec) {
  const sessionId = exec?.agent?.session?.id
  if (sessionId !== undefined) {
    try {
      const session = ctx.sessions?.get?.(sessionId)
      if (session !== undefined) {
        const cwd = ctx.get('workingDirectory')?.get?.(session)
        if (typeof cwd === 'string' && cwd !== '') return cwd
        if (typeof session.header?.cwd === 'string' && session.header.cwd !== '') return session.header.cwd
      }
    } catch {
      // fall through to the durable header
    }
    try {
      const stored = await ctx.get('sessionPersistence')?.stat?.(sessionId)
      if (typeof stored?.header?.cwd === 'string' && stored.header.cwd !== '') return stored.header.cwd
    } catch {
      // fall through to the deployment default
    }
  }
  const fallback = ctx.get('workingDirectory')?.defaultDirectory
  if (typeof fallback === 'string' && fallback !== '') return fallback
  return process.cwd()
}

/** Human summary of an in-flight build. */
function progressText(progress) {
  if (progress === null || progress === undefined) return 'starting'
  const total = typeof progress.total === 'number' && progress.total > 0 ? ` / ${progress.total}` : ''
  return `${progress.phase} ${progress.done ?? 0}${total}`
}

/** Message returned by query tools while the index is not ready. */
function notReadyMessage(status) {
  if (status.building) {
    return (
      `The Code Insight index for ${status.workspace} is being built (${progressText(status.progress)}). ` +
      'Retry this call in a few seconds, or call code_insight_index with action="status" to check progress.'
    )
  }
  if (status.error) {
    return (
      `The Code Insight index for ${status.workspace} is unavailable: ${status.error}. ` +
      'Call code_insight_index with action="build" to retry.'
    )
  }
  return (
    `No Code Insight index exists yet for ${status.workspace}. ` +
    'Building it now in the background unless configuration disables autoBuild; ' +
    'retry this call in a few seconds, or call code_insight_index with action="build".'
  )
}

/**
 * Load (or start building) the workspace index for one tool call.
 * @returns {{ workspace: string, index: object, ready: boolean, autoBuild: boolean, status: object, message?: string }}
 */
async function prepare(ctx, manager, exec) {
  const workspace = await resolveWorkspace(ctx, exec)
  const index = manager.indexFor(workspace)
  await index.ensureLoaded()
  let status = await index.status()
  if (index.snapshot === undefined && manager.config.autoBuild !== false && !status.building) {
    index.startBuild({ force: false })
    status = await index.status()
  }
  if (index.snapshot === undefined) {
    return { workspace, index, ready: false, status, message: notReadyMessage(status) }
  }
  index.maybeRefresh()
  return { workspace, index, ready: true, status }
}

/** Fields every query tool reports about index readiness. */
function readinessSchema(extraProperties) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ready: { type: 'boolean', required: true, description: 'Whether the symbol index was loaded and answered from.' },
      building: { type: 'boolean', required: true, description: 'Whether a build/refresh is running in the background.' },
      progress: { type: 'json', description: 'In-flight build progress when `building` is true.' },
      message: { type: 'string', description: 'Human hint, e.g. what to do while the index is still building.' },
      ...extraProperties,
    },
  }
}

/** Standard non-ready canonical value for one query tool. */
function notReadyValue(status, message) {
  return { ready: false, building: status.building === true, progress: status.progress ?? undefined, message }
}

/** Register every `code_insight_*` tool on `ctx.tools`. */
export function registerTools({ ctx, manager }) {
  const config = manager.config
  const searchDefault = clampInt(config.searchLimit, 50, 1, 500)
  const referenceDefault = clampInt(config.maxReferenceResults, 200, 1, 2000)
  const disposers = []

  const register = (definition) => {
    const execute = definition.execute
    disposers.push(
      ctx.tools.register(
        defineTool({
          ...definition,
          execute: async (args, exec) => prune(await execute(args, exec)),
        }),
      ),
    )
  }

  // ------------------------------------------------------------------ search
  register({
    name: 'code_insight_search',
    description:
      'Search the workspace C/C++ symbol index by identifier or substring (case-insensitive: exact > prefix > ' +
      'camel/subword > substring). Returns functions, structs/unions/enums/typedefs, macros, declarations, members, ' +
      'enum constants and file-scope variables with their definition locations. Use this instead of grepping when ' +
      'you need to find where a symbol is declared/defined in a large C/C++ tree. The index is local and answers ' +
      'in milliseconds; build it once with code_insight_index if the response says it is still building.',
    parameters: {
      query: { type: 'string', required: true, description: 'Identifier or name substring to search for.' },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: SYMBOL_KINDS },
        description: 'Optional symbol-kind filter.',
      },
      limit: { type: 'integer', description: `Maximum results (default ${searchDefault}, max 500).` },
    },
    output: {
      schema: readinessSchema({
        query: { type: 'string', required: true },
        hits: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              file: { type: 'string', required: true },
              line: { type: 'integer', required: true, description: '1-based line of the definition name.' },
              end_line: { type: 'integer', required: true, description: '1-based last line of the definition body.' },
              condition: { type: 'string', description: 'Enclosing preprocessor condition, e.g. #ifdef X.' },
            },
          },
        },
        total: { type: 'integer', required: true },
      }),
      render: (_args, value) => {
        if (!value.ready) return text(`${value.message ?? 'index not ready'}\n\n${progressText(value.progress)}`)
        if (value.hits.length === 0) {
          return text(
            `No indexed symbol matches "${value.query}". ` +
              'Try a shorter substring, clear the kind filter, or verify that code_insight_index reports state=ready.',
          )
        }
        const lines = [
          `${value.total} symbol(s) matching "${value.query}" (1-based line numbers):`,
          ...value.hits.map(
            (hit, position) =>
              `${position + 1}. ${hit.name} ${kindTag(hit)}${conditionText(hit)}  ${hit.file}:${hit.line}`,
          ),
        ]
        return text(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const query = String(args.query ?? '').trim()
      const prepared = await prepare(ctx, manager, exec)
      if (!prepared.ready) return { ...notReadyValue(prepared.status, prepared.message), query, hits: [], total: 0 }
      const limit = clampInt(args.limit, searchDefault, 1, 500)
      const kinds = Array.isArray(args.kinds) && args.kinds.length > 0 ? args.kinds : undefined
      const hits = prepared.index
        .search(cleanSymbolName(query) || query, limit, kinds)
        .map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          file: entry.file,
          line: entry.line + 1,
          end_line: Math.max(entry.line, entry.endLine) + 1,
          condition: entry.condition === undefined || entry.condition === '' ? undefined : entry.condition,
        }))
      return { ready: true, building: prepared.status.building === true, query, hits, total: hits.length }
    },
  })

  // -------------------------------------------------------------- definition
  register({
    name: 'code_insight_definition',
    description:
      'Find the definition(s) of a C/C++ symbol by name, ranked the way a human navigates: definitions reachable ' +
      'through the include graph from `source_file` first, then the same index root, then the closest path prefix. ' +
      'Identical copies (same content hash) are folded into one row with a copy count. Returns reconstructed ' +
      'signatures and preprocessor conditions. Pass `source_file` (the file you are looking at) to get the same ' +
      'ordering the editor F12 uses.',
    parameters: {
      name: { type: 'string', required: true, description: 'Symbol name (a trailing "(args)" and type keywords are ignored).' },
      source_file: {
        type: 'string',
        description: 'Calling-context file (absolute or workspace-relative) used to rank definition candidates.',
      },
      limit: { type: 'integer', description: 'Maximum definition rows (default 8, max 50).' },
      show_copies: {
        type: 'boolean',
        description: 'Expand identical-content duplicate files instead of folding them into one row.',
      },
      include_declarations: {
        type: 'boolean',
        description: 'Also return header prototypes/forward declarations when a real definition exists (default false).',
      },
    },
    output: {
      schema: readinessSchema({
        name: { type: 'string', required: true },
        source_file: { type: 'string' },
        definitions: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              file: { type: 'string', required: true },
              line: { type: 'integer', required: true, description: '1-based first line of the definition.' },
              end_line: { type: 'integer', required: true, description: '1-based last line of the definition body.' },
              signature: { type: 'string' },
              condition: { type: 'string' },
              included: { type: 'boolean', required: true, description: 'Reachable from source_file through #include.' },
              copies: { type: 'integer', required: true, description: 'Content-identical files folded into this row.' },
            },
          },
        },
        total: { type: 'integer', required: true },
      }),
      render: (_args, value) => {
        if (!value.ready) return text(`${value.message ?? 'index not ready'}\n\n${progressText(value.progress)}`)
        if (value.definitions.length === 0) {
          return text(
            `No definition of "${value.name}" is in the index. ` +
              'Use code_insight_search with a substring to find the exact symbol name.',
          )
        }
        const lines = [
          `Definitions of "${value.name}"${value.source_file ? ` (ranked from ${value.source_file})` : ''}:`,
          ...value.definitions.flatMap((entry, position) => {
            const flags = [
              entry.included ? 'included' : 'not included',
              entry.copies > 1 ? `${entry.copies} identical copies` : undefined,
            ]
              .filter(Boolean)
              .join(', ')
            return [
              `${position + 1}. ${entry.name} ${kindTag(entry)}  ${entry.file}:${entry.line}  (${flags})${conditionText(entry)}`,
              entry.signature ? `   ${entry.signature}` : undefined,
            ].filter(Boolean)
          }),
        ]
        return text(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const workspace = await resolveWorkspace(ctx, exec)
      const name = cleanSymbolName(String(args.name ?? ''))
      const prepared = await prepare(ctx, manager, exec)
      const sourceFile = toWorkspaceRelative(workspace, args.source_file)
      if (!prepared.ready) {
        return {
          ...notReadyValue(prepared.status, prepared.message),
          name,
          source_file: sourceFile === '' ? undefined : sourceFile,
          definitions: [],
          total: 0,
        }
      }
      const index = prepared.index
      const limit = clampInt(args.limit, 8, 1, 50)
      const allEntries = index.definitions(name)
      const bodies = allEntries.filter((entry) => entry.kind !== 'declaration')
      const candidates =
        args.include_declarations === true || bodies.length === 0 ? allEntries : bodies
      const groups = groupDefinitions(candidates, {
        sourceFile: sourceFile === '' ? undefined : sourceFile,
        roots: index.roots(),
        table: index.snapshot,
      })
      const rows = []
      for (const group of groups) {
        if (rows.length >= limit) break
        const entries = args.show_copies === true ? group.entries : [group.representative]
        for (const entry of entries) {
          if (rows.length >= limit) break
          rows.push({ entry, group })
        }
      }
      const signatures = await index.signatures(rows.map((row) => row.entry))
      const definitions = rows.map(({ entry, group }, position) => ({
        name: entry.name,
        kind: entry.kind,
        file: entry.file,
        line: entry.line + 1,
        end_line: Math.max(entry.line, entry.endLine) + 1,
        signature: signatures[position] ?? undefined,
        condition: entry.condition === undefined || entry.condition === '' ? undefined : entry.condition,
        included: group.included,
        copies: group.copies,
      }))
      return {
        ready: true,
        building: prepared.status.building === true,
        name,
        source_file: sourceFile === '' ? undefined : sourceFile,
        definitions,
        total: groups.length,
      }
    },
  })

  // -------------------------------------------------------------- references
  register({
    name: 'code_insight_references',
    description:
      'Find every reference to an indexed C/C++ symbol (function, type, macro or variable) across the workspace. ' +
      'Comments and string literals are ignored, declarations/definitions are excluded by default, and the ' +
      'identifier index narrows the scan to candidate files. Use it to measure impact before editing an API.',
    parameters: {
      name: { type: 'string', required: true, description: 'Exact symbol name.' },
      limit: { type: 'integer', description: `Maximum hits (default ${referenceDefault}, max 2000).` },
      include_declaration: { type: 'boolean', description: 'Also include declarations/definitions of the symbol.' },
    },
    output: {
      schema: readinessSchema({
        name: { type: 'string', required: true },
        references: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file: { type: 'string', required: true },
              line: { type: 'integer', required: true, description: '1-based line.' },
              column: { type: 'integer', required: true, description: '1-based column.' },
              preview: { type: 'string', required: true, description: 'Trimmed source line (may be truncated).' },
            },
          },
        },
        total: { type: 'integer', required: true },
        files: { type: 'integer', required: true, description: 'Distinct files among the returned hits.' },
      }),
      render: (_args, value) => {
        if (!value.ready) return text(`${value.message ?? 'index not ready'}\n\n${progressText(value.progress)}`)
        if (value.references.length === 0) {
          return text(
            `No references to "${value.name}" were found in the index. ` +
              'The symbol may be unused, or the index may need a refresh (code_insight_index action="build").',
          )
        }
        const lines = [
          `${value.total} reference(s) to "${value.name}" in ${value.files} file(s) (1-based lines):`,
          ...value.references.map((hit) => `${hit.file}:${hit.line}:${hit.column}  ${hit.preview}`),
        ]
        return text(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const name = cleanSymbolName(String(args.name ?? ''))
      const prepared = await prepare(ctx, manager, exec)
      if (!prepared.ready) {
        return { ...notReadyValue(prepared.status, prepared.message), name, references: [], total: 0, files: 0 }
      }
      const hits = await prepared.index.references(name, {
        limit: clampInt(args.limit, referenceDefault, 1, 2000),
        includeDeclaration: args.include_declaration === true,
        signal: exec.signal,
      })
      const references = hits.map((hit) => ({
        file: hit.file,
        line: hit.line + 1,
        column: hit.column + 1,
        preview: hit.preview,
      }))
      return {
        ready: true,
        building: prepared.status.building === true,
        name,
        references,
        total: references.length,
        files: new Set(references.map((hit) => hit.file)).size,
      }
    },
  })

  // ----------------------------------------------------------------- callers
  register({
    name: 'code_insight_callers',
    description:
      'List the functions that call an indexed C/C++ function. Each hit reports the containing caller function ' +
      'plus the call site, which is the fastest way to trace how an API is used before changing it.',
    parameters: {
      name: { type: 'string', required: true, description: 'Exact function name (or macro-like call target).' },
      limit: { type: 'integer', description: `Maximum call sites (default ${referenceDefault}, max 2000).` },
    },
    output: {
      schema: readinessSchema({
        name: { type: 'string', required: true },
        callers: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file: { type: 'string', required: true, description: 'File containing the call site.' },
              line: { type: 'integer', required: true, description: '1-based call-site line.' },
              column: { type: 'integer', required: true, description: '1-based call-site column.' },
              preview: { type: 'string', required: true },
              from_name: { type: 'string', description: 'Name of the enclosing caller function, when known.' },
              from_file: { type: 'string' },
              from_line: { type: 'integer', description: '1-based line of the caller definition.' },
              from_kind: { type: 'string' },
            },
          },
        },
        total: { type: 'integer', required: true },
        caller_functions: { type: 'integer', required: true, description: 'Distinct enclosing caller functions.' },
      }),
      render: (_args, value) => {
        if (!value.ready) return text(`${value.message ?? 'index not ready'}\n\n${progressText(value.progress)}`)
        if (value.callers.length === 0) {
          return text(`No indexed caller of "${value.name}" was found (it may be unused or only referenced from code outside the index).`)
        }
        const lines = [
          `${value.total} call site(s) of "${value.name}" from ${value.caller_functions} function(s) (1-based lines):`,
          ...value.callers.map((hit) => {
            const caller =
              hit.from_name === undefined || hit.from_file === undefined
                ? '<file scope>'
                : `${hit.from_name} (${hit.from_file}:${hit.from_line})`
            return `${caller} -> ${value.name} at ${hit.file}:${hit.line}  ${hit.preview}`
          }),
        ]
        return text(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const name = cleanSymbolName(String(args.name ?? ''))
      const prepared = await prepare(ctx, manager, exec)
      if (!prepared.ready) {
        return { ...notReadyValue(prepared.status, prepared.message), name, callers: [], total: 0, caller_functions: 0 }
      }
      const hits = await prepared.index.callers(name, {
        limit: clampInt(args.limit, referenceDefault, 1, 2000),
        signal: exec.signal,
      })
      const callers = hits.map((hit) => ({
        file: hit.file,
        line: hit.line + 1,
        column: hit.column + 1,
        preview: hit.preview,
        from_name: hit.from?.name,
        from_file: hit.from?.file,
        from_line: hit.from === undefined ? undefined : hit.from.line + 1,
        from_kind: hit.from?.kind,
      }))
      const callerFunctions = new Set(
        callers.map((hit) =>
          hit.from_name === undefined ? `<file>${hit.file}` : `${hit.from_name}|${hit.from_file}|${hit.from_line}`,
        ),
      ).size
      return {
        ready: true,
        building: prepared.status.building === true,
        name,
        callers,
        total: callers.length,
        caller_functions: callerFunctions,
      }
    },
  })

  // ----------------------------------------------------------------- callees
  register({
    name: 'code_insight_callees',
    description:
      'List the indexed functions an indexed C/C++ function calls (its callees), with definition locations and ' +
      'signatures. Useful to map what a function depends on before refactoring it.',
    parameters: {
      name: { type: 'string', required: true, description: 'Exact function name.' },
      limit: { type: 'integer', description: `Maximum callees (default ${referenceDefault}, max 2000).` },
    },
    output: {
      schema: readinessSchema({
        name: { type: 'string', required: true },
        callees: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              file: { type: 'string', required: true },
              line: { type: 'integer', required: true, description: '1-based first line of the callee definition.' },
              signature: { type: 'string' },
            },
          },
        },
        total: { type: 'integer', required: true },
      }),
      render: (_args, value) => {
        if (!value.ready) return text(`${value.message ?? 'index not ready'}\n\n${progressText(value.progress)}`)
        if (value.callees.length === 0) {
          return text(
            `No indexed callee of "${value.name}" was found: the body is empty, unavailable, or calls nothing that is in the index.`,
          )
        }
        const lines = [
          `${value.total} indexed callee(s) of "${value.name}" (1-based lines):`,
          ...value.callees.flatMap((entry) => [
            `- ${entry.name} ${kindTag(entry)}  ${entry.file}:${entry.line}`,
            entry.signature ? `    ${entry.signature}` : undefined,
          ].filter(Boolean)),
        ]
        return text(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const name = cleanSymbolName(String(args.name ?? ''))
      const prepared = await prepare(ctx, manager, exec)
      if (!prepared.ready) {
        return { ...notReadyValue(prepared.status, prepared.message), name, callees: [], total: 0 }
      }
      const entries = await prepared.index.callees(name, {
        limit: clampInt(args.limit, referenceDefault, 1, 2000),
        signal: exec.signal,
      })
      const signatures = await prepared.index.signatures(entries)
      const callees = entries.map((entry, position) => ({
        name: entry.name,
        kind: entry.kind,
        file: entry.file,
        line: entry.line + 1,
        signature: signatures[position] ?? undefined,
      }))
      return {
        ready: true,
        building: prepared.status.building === true,
        name,
        callees,
        total: callees.length,
      }
    },
  })

  // ----------------------------------------------------------------- outline
  register({
    name: 'code_insight_outline',
    description:
      'List the indexed symbols (functions, types, macros, members, globals) defined in one C/C++ file, in ' +
      'definition order, with signatures. This is the document outline of a file and answers "what lives in this ' +
      'file?" without reading it.',
    parameters: {
      file: { type: 'string', required: true, description: 'Absolute or workspace-relative C/C++ file path.' },
      include_signatures: { type: 'boolean', description: 'Reconstruct signatures (default true).' },
      limit: { type: 'integer', description: 'Maximum symbols (default 300, max 1000).' },
    },
    output: {
      schema: readinessSchema({
        file: { type: 'string', required: true },
        symbols: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              line: { type: 'integer', required: true, description: '1-based first line of the symbol.' },
              end_line: { type: 'integer', required: true, description: '1-based last line of the symbol body.' },
              signature: { type: 'string' },
              condition: { type: 'string' },
            },
          },
        },
        total: { type: 'integer', required: true },
      }),
      render: (_args, value) => {
        if (!value.ready) return text(`${value.message ?? 'index not ready'}\n\n${progressText(value.progress)}`)
        if (value.symbols.length === 0) {
          return text(
            `No indexed symbol in "${value.file}". Check the path (workspace-relative), or refresh the index ` +
              'with code_insight_index action="build" if the file is new.',
          )
        }
        const lines = [
          `${value.total} symbol(s) in ${value.file} (1-based lines):`,
          ...value.symbols.flatMap((entry) => [
            `${String(entry.line).padStart(6)}: ${entry.name} ${kindTag(entry)}${conditionText(entry)}`,
            entry.signature ? `        ${entry.signature}` : undefined,
          ].filter(Boolean)),
        ]
        return text(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const workspace = await resolveWorkspace(ctx, exec)
      const file = toWorkspaceRelative(workspace, args.file)
      const prepared = await prepare(ctx, manager, exec)
      if (!prepared.ready) return { ...notReadyValue(prepared.status, prepared.message), file, symbols: [], total: 0 }
      const entries = prepared.index.fileSymbols(file).slice(0, clampInt(args.limit, 300, 1, 1000))
      const signatures =
        args.include_signatures === false ? [] : await prepared.index.signatures(entries)
      const symbols = entries.map((entry, position) => ({
        name: entry.name,
        kind: entry.kind,
        line: entry.line + 1,
        end_line: Math.max(entry.line, entry.endLine) + 1,
        signature: signatures[position] ?? undefined,
        condition: entry.condition === undefined || entry.condition === '' ? undefined : entry.condition,
      }))
      return {
        ready: true,
        building: prepared.status.building === true,
        file,
        symbols,
        total: symbols.length,
      }
    },
  })

  // ---------------------------------------------------------------- call graph
  register({
    name: 'code_insight_call_graph',
    description:
      'Expand the call graph around one indexed C/C++ function: callers on one side, callees on the other, ' +
      'node by node up to the requested depth. Complements code_insight_callers/callees when you need the ' +
      'multi-hop shape of a call chain. Node count and children per node are capped; truncated nodes are marked.',
    parameters: {
      name: { type: 'string', required: true, description: 'Exact function name at the center of the graph.' },
      depth: { type: 'integer', description: 'Expansion depth below the root (default 2, max 4).' },
      direction: {
        type: 'string',
        enum: ['both', 'callers', 'callees'],
        description: 'Which side(s) to expand (default both).',
      },
      max_nodes: { type: 'integer', description: 'Maximum nodes besides the root (default 30, max 100).' },
      max_children: { type: 'integer', description: 'Maximum callers and callees expanded per node (default 8, max 50).' },
    },
    output: {
      schema: readinessSchema({
        name: { type: 'string', required: true },
        direction: { type: 'string', required: true },
        depth: { type: 'integer', required: true },
        nodes: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'integer', required: true },
              name: { type: 'string', required: true },
              kind: { type: 'string', required: true },
              file: { type: 'string', required: true },
              line: { type: 'integer', required: true, description: '1-based definition line (0 when unknown).' },
              depth: { type: 'integer', required: true },
              relation: { type: 'string', required: true, description: 'root | caller | callee.' },
              truncated_children: { type: 'boolean', required: true },
            },
          },
        },
        edges: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              from: { type: 'integer', required: true },
              to: { type: 'integer', required: true },
              relation: { type: 'string', required: true, description: 'Always "calls": from calls to.' },
            },
          },
        },
        truncated: { type: 'boolean', required: true },
      }),
      render: (args, value) => {
        if (!value.ready) return text(`${value.message ?? 'index not ready'}\n\n${progressText(value.progress)}`)
        const root = value.nodes.find((node) => node.relation === 'root')
        if (root === undefined) return text(`No call graph for "${value.name}".`)
        const lines = [
          `Call graph for ${root.name} (${root.kind} ${root.file}:${root.line}), direction=${value.direction}, depth=${value.depth}:`,
          ...value.nodes
            .filter((node) => node.id !== root.id)
            .map((node) => {
              const marker = node.relation === 'caller' ? '<- ' : '-> '
              const locationText = node.line > 0 ? `  ${node.file}:${node.line}` : ''
              const truncated = node.truncated_children ? '  (more not shown)' : ''
              return `${'  '.repeat(node.depth)}${marker}${node.name} [${node.kind}]${locationText}${truncated}`
            }),
        ]
        if (value.truncated) lines.push('(graph truncated by node/children caps)')
        return text(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const name = cleanSymbolName(String(args.name ?? ''))
      const prepared = await prepare(ctx, manager, exec)
      const depth = clampInt(args.depth, 2, 1, 4)
      const direction = ['both', 'callers', 'callees'].includes(args.direction) ? args.direction : 'both'
      if (!prepared.ready) {
        return {
          ...notReadyValue(prepared.status, prepared.message),
          name,
          direction,
          depth,
          nodes: [],
          edges: [],
          truncated: false,
        }
      }
      const maxNodes = clampInt(args.max_nodes, 30, 1, 100)
      const maxChildren = clampInt(args.max_children, 8, 1, 50)
      const graph = await prepared.index.graph(name, {
        depth,
        direction,
        maxNodes,
        maxChildren,
        signal: exec.signal,
      })
      return {
        ready: true,
        building: prepared.status.building === true,
        name,
        direction,
        depth,
        nodes: graph.nodes,
        edges: graph.edges,
        truncated: graph.truncated,
      }
    },
  })

  // ------------------------------------------------------------------- index
  register({
    name: 'code_insight_index',
    description:
      'Inspect or manage the workspace C/C++ symbol index used by the other code_insight_* tools. ' +
      'action="status" reports readiness, progress, file/symbol counts and the last build; ' +
      'action="build" runs an incremental refresh (only changed files are re-parsed); ' +
      'action="rebuild" forces a full rescan; action="clear" deletes the persisted snapshot. ' +
      'A first build of a ~100k-file tree takes a couple of minutes in the background; other tools keep ' +
      'answering from the previous snapshot meanwhile.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'build', 'rebuild', 'clear'],
        description: 'Operation to perform.',
      },
      wait_seconds: {
        type: 'integer',
        description: 'For build/rebuild: wait up to this long for completion (default 0 = return immediately).',
      },
    },
    output: {
      schema: readinessSchema({
        workspace: { type: 'string', required: true },
        state: { type: 'string', required: true, description: 'empty | building | ready | error.' },
        files: { type: 'integer', required: true },
        symbols: { type: 'integer', required: true },
        roots: { type: 'array', required: true, items: { type: 'string' } },
        builtAt: { type: 'string' },
        ageSeconds: { type: 'integer' },
        snapshotBytes: { type: 'integer', required: true },
        nameIndexReady: { type: 'boolean', required: true },
        cacheDir: { type: 'string' },
        autoBuild: { type: 'boolean', required: true },
        autoRefreshMinutes: { type: 'integer', required: true },
        lastBuild: { type: 'json' },
        error: { type: 'string' },
        snapshotHint: { type: 'string' },
        action: { type: 'string', required: true },
      }),
      render: (args, value) => {
        const lines = [`Code Insight index (${value.workspace}) — state: ${value.state}${value.building ? ' (building)' : ''}`]
        lines.push(`roots: ${value.roots.map((root) => (root === '' ? '.' : root)).join(', ') || '.'}`)
        lines.push(`files: ${value.files}   symbols: ${value.symbols}   snapshot: ${value.snapshotBytes} bytes`)
        if (value.builtAt) {
          lines.push(`built: ${value.builtAt}${value.ageSeconds !== undefined ? ` (${value.ageSeconds}s ago)` : ''}`)
        }
        if (value.building) lines.push(`progress: ${progressText(value.progress)}`)
        if (value.error) lines.push(`error: ${value.error}`)
        if (value.snapshotHint) lines.push(`note: ${value.snapshotHint}`)
        if (value.lastBuild) {
          const build = value.lastBuild
          lines.push(
            `last build: ${build.files} files, ${build.entries} symbols; added ${build.added}, updated ${build.updated}, ` +
              `removed ${build.removed}, unchanged ${build.unchanged}; ${build.durationMs} ms`,
          )
        }
        if (value.cacheDir) lines.push(`cache: ${value.cacheDir}`)
        if (args.action === 'clear') lines.push('persisted index files were removed; the next query rebuilds.')
        return text(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const action = ['status', 'build', 'rebuild', 'clear'].includes(args.action) ? args.action : 'status'
      const workspace = await resolveWorkspace(ctx, exec)
      const index = manager.indexFor(workspace)
      await index.ensureLoaded()
      if (action === 'build' || action === 'rebuild') {
        const waitSeconds = clampInt(args.wait_seconds, 0, 0, 600)
        const building = index.startBuild({ force: action === 'rebuild' })
        if (waitSeconds > 0) {
          await waitFor(building, waitSeconds, exec.signal)
        }
      } else if (action === 'clear') {
        await index.clear()
      }
      return { ...(await index.status()), action }
    },
  })

  return disposers
}

/** Await a build for at most `seconds`, or until the caller aborts. */
async function waitFor(promise, seconds, signal) {
  let timer
  let onAbort
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, seconds * 1000)
    timer.unref?.()
  })
  const aborted = new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([promise.catch(() => undefined), timeout, aborted])
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}
