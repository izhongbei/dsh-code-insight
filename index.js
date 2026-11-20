/**
 * dsh-code-insight — host-side DeepSeek Harness plugin.
 *
 * Exposes the Code Insight C/C++ symbol index (the engine behind the
 * `tools/vscode-source-insight` VS Code extension) as model-facing tools:
 * symbol search, go-to-definition, find-references, callers/callees, call
 * graphs, file outlines and index management.
 *
 * The extension's `src/core` + `src/shared` are vendored verbatim into
 * `lib/vendor` by `scripts/build-core.mjs` (pure Node, no `vscode` import);
 * this package supplies only the host glue the extension keeps in
 * `src/vscode/service.ts`.
 */
import z from '@deepseek-ai/schemastery'
import { createIndexManager } from './lib/manager.js'
import { registerRoutes } from './lib/routes.js'
import { registerTools } from './lib/tools.js'

/** Stable plugin identity (row name, logger identity). */
export const name = 'dsh-code-insight'

/** Wait for the tool registry before activating. */
export const inject = ['tools']

/** Default excludes shared with the extension (`DEFAULT_EXCLUDE`). */
const DEFAULT_EXCLUDE = ['**/.git/**', '**/build/**', '**/tmp/**', '**/node_modules/**']

/** Short system-prompt guidance so the model reaches for the index tools. */
const PROMPT_TEXT = [
  '## C/C++ symbol index (Code Insight)',
  '',
  'This workspace has a persistent C/C++ symbol index behind the code_insight_* tools. Prefer them over text search for name-based navigation:',
  '- code_insight_search finds a symbol by name/substring; code_insight_definition lists its definition(s) ranked from a source file, with reconstructed signatures and enclosing #ifdef conditions.',
  '- code_insight_references, code_insight_callers, code_insight_callees and code_insight_call_graph cover impact analysis and call chains.',
  '- code_insight_outline lists what one file defines; code_insight_index reports status and builds/refreshes/clears the index.',
  'All reported line numbers are 1-based. The index is built in the background: if a tool says it is building, retry shortly (a first build of a very large tree can take a couple of minutes). Edited files are picked up by the next incremental build (code_insight_index action="build").',
  'A Code Insight panel is also available in the Web GUI: open the right sidebar and pick the Code Insight tab to search symbols, browse the call graph and jump to definitions; typing @ in the composer completes indexed symbol names.',
].join('\n')

/** Plugin configuration, validated and defaulted by the Cordis loader. */
export const Config = z
  .object({
    indexRoots: z
      .array(z.string())
      .default(['.'])
      .description('Workspace-relative directories to index; ["."] indexes the whole workspace. Order is include-priority.'),
    exclude: z
      .array(z.string())
      .default([...DEFAULT_EXCLUDE])
      .description('Excluded globs, matched against workspace-relative paths.'),
    maxFileSizeKB: z.number().default(4096).description('Skip source files larger than this (KB).'),
    concurrency: z.number().default(4).description('Parser worker concurrency (1-64); very large trees auto-downgrade.'),
    followSymlinks: z.boolean().default(false).description('Follow symbolic links while walking index roots.'),
    autoBuild: z
      .boolean()
      .default(true)
      .description('Start a background index build when a code_insight_* tool finds no snapshot.'),
    autoRefreshMinutes: z
      .number()
      .default(10)
      .description('Background incremental refresh when the snapshot is older than this many minutes (0 disables).'),
    searchLimit: z.number().default(50).description('Default/maximum result count of code_insight_search (1-500).'),
    maxReferenceResults: z
      .number()
      .default(200)
      .description('Default/maximum hit count of references/callers/callees tools (1-2000).'),
    cacheDir: z
      .string()
      .default('')
      .description('Index cache root. Empty = $DSH_HOME/storages/code-insight (one subdirectory per workspace).'),
  })
  .description('Code Insight index plugin')

/** Resolve a logger without depending on a specific Cordis logger shape. */
function createLogger(ctx) {
  try {
    const logger = ctx.logger
    if (logger && typeof logger.info === 'function') {
      const scoped = logger(name)
      return scoped && typeof scoped.info === 'function' ? scoped : logger
    }
    if (typeof logger === 'function') {
      const scoped = logger(name)
      if (scoped && typeof scoped.info === 'function') return scoped
    }
  } catch {
    // fall through to the console
  }
  return console
}

/** Register the short system-prompt section when the prompt service is present. */
function registerPromptSection(ctx, logger) {
  try {
    ctx.inject(['systemPrompt'], (injected) => {
      try {
        const prompt = injected.systemPrompt
        if (prompt === undefined || typeof prompt.section !== 'function') return
        const order =
          typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('TOOL_GREP') + 1 : 1501
        prompt.section({
          name: 'code-insight:usage',
          order,
          text: () => PROMPT_TEXT,
          interpolate: false,
        })
      } catch (error) {
        logger.warn(`[code-insight] cannot register prompt section: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    logger.warn(`[code-insight] cannot subscribe to the prompt service: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Mount the plugin: index manager lifecycle, tools, and prompt guidance. */
export function apply(ctx, config) {
  const logger = createLogger(ctx)
  const manager = createIndexManager({ ctx, config, logger })
  registerTools({ ctx, manager })
  // Browser panel API: optional, only mounted when this composition has a Web carrier.
  registerRoutes(ctx, manager, logger)
  ctx.effect(() => () => manager.dispose(), 'code-insight: dispose index manager')
  registerPromptSection(ctx, logger)
  logger.info(
    `[code-insight] mounted: roots=${JSON.stringify(config.indexRoots)} cache=${manager.cacheRoot}`,
  )
}
