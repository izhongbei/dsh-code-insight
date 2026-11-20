/**
 * Code Insight — browser half.
 *
 * A session-scoped right-sidebar tab ("Code Insight") that browses the C/C++
 * symbol index served by the host half:
 * - symbol search (C/C++ index, not a text grep);
 * - callers/callees call graph rendered as an SVG, re-centerable node by node;
 * - file outline of the selected symbol's file;
 * - click-to-open a definition at its 1-based line in the right sidebar's file
 *   viewer (`ctx.sidebarRight.openResource` with a session-scoped file address);
 * - index status and one-click incremental build.
 *
 * Host API: `/api/code-insight/{status,search,graph,outline,definition,references,build}`
 * registered by `lib/routes.js`. Auth rides the page's HttpOnly cookie, so
 * requests are document-relative `fetch('api/code-insight/...')`.
 *
 * Hand-written ModuleLoader bundle (no build step), same shape as the working
 * `@local/sidebar-notes` plugin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-code-insight',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace and right-sidebar tab identity. */
    const NS = 'code-insight'
    const TAB_ID = 'dsh-code-insight'
    const KIND = 'code-insight'
    const API_BASE = 'api/code-insight'

    // ---- locale dictionaries -------------------------------------------
    const zh = {
      tab: '代码洞察',
      desc: 'C/C++ 符号索引：搜索、定义、调用关系图',
      searchPlaceholder: '搜索函数 / 结构体 / 宏…',
      searchEmpty: '输入名字搜索符号（索引毫秒级返回）',
      searching: '搜索中…',
      noResults: '没有匹配的符号',
      graphEmpty: '选择一个符号查看调用关系',
      graphLoading: '构建调用图…',
      callers: '调用者',
      callees: '被调用',
      direction: '方向',
      both: '双向',
      callersOnly: '只看调用者',
      calleesOnly: '只看被调用',
      depth: '深度',
      open: '打开',
      center: '以此为中心',
      outline: '文件大纲',
      outlineEmpty: '所选文件没有索引符号',
      definition: '定义',
      refresh: '刷新',
      build: '重建索引',
      building: '索引构建中…',
      ready: '就绪',
      empty: '无索引',
      error: '错误',
      files: '{n} 文件',
      symbols: '{n} 符号',
      searchError: '搜索失败',
      graphError: '调用图加载失败',
      openFailed: '无法在右栏打开文件，已复制 路径:行号',
      openUnavailable: '该符号没有可打开的文件位置',
      sessionMissing: '当前面板没有会话上下文，无法定位文件',
      hintOpen: '提示：点击结果/大纲行或「打开」按钮，在右侧栏文件查看器定位到该行；右栏太窄可拆分右栏。',
      noSession: '请先打开一个会话，再打开代码洞察面板',
      statusError: '索引状态不可用',
      expired: '登录态已过期，请刷新页面',
      roots: '索引范围',
      loadMore: '加载更多',
    }
    const en = {
      tab: 'Code Insight',
      desc: 'C/C++ symbol index: search, definitions, call graph',
      searchPlaceholder: 'Search functions / structs / macros…',
      searchEmpty: 'Type a name to search the symbol index',
      searching: 'Searching…',
      noResults: 'No matching symbol',
      graphEmpty: 'Pick a symbol to see its call graph',
      graphLoading: 'Building call graph…',
      callers: 'callers',
      callees: 'callees',
      direction: 'direction',
      both: 'both',
      callersOnly: 'callers only',
      calleesOnly: 'callees only',
      depth: 'depth',
      open: 'Open',
      center: 'Center here',
      outline: 'File outline',
      outlineEmpty: 'No indexed symbol in this file',
      definition: 'Definition',
      refresh: 'Refresh',
      build: 'Build index',
      building: 'Building index…',
      ready: 'ready',
      empty: 'no index',
      error: 'error',
      files: '{n} files',
      symbols: '{n} symbols',
      searchError: 'Search failed',
      graphError: 'Cannot load call graph',
      openFailed: 'Cannot open in the right sidebar; copied path:line',
      openUnavailable: 'This symbol has no file location to open',
      sessionMissing: 'This panel has no session context, so it cannot locate files',
      hintOpen: 'Tip: click a result/outline row or the Open button to reveal that line in the right-sidebar file viewer; split the column for more room.',
      noSession: 'Open a conversation first, then open the Code Insight panel',
      statusError: 'Index status unavailable',
      expired: 'Session expired — reload the page',
      roots: 'Index roots',
      loadMore: 'Load more',
    }

    // ---- CSS ------------------------------------------------------------
    const CSS = `
.dsh-ci{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.6}
.dsh-ci-scroll{flex:1;min-height:0;overflow:auto;padding:10px 12px 18px}
.dsh-ci-head{display:flex;align-items:center;gap:8px;flex:none;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-ci-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ci-pill{margin-left:auto;display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.dsh-ci-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.dsh-ci-pill[data-state="ready"]::before{background:var(--dsw-alias-state-success-primary)}
.dsh-ci-pill[data-state="building"]::before{background:var(--dsw-alias-state-warn-primary)}
.dsh-ci-pill[data-state="error"]::before{background:var(--dsw-alias-state-error-primary)}
.dsh-ci-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.dsh-ci-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ci-btn:disabled{opacity:.45;cursor:default}
.dsh-ci-btn[data-primary="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-ci-searchbox{display:flex;gap:6px;margin-bottom:8px}
.dsh-ci-input{flex:1;min-width:0;height:28px;box-sizing:border-box;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.dsh-ci-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-ci-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:4px 0}
.dsh-ci-error{color:var(--dsw-alias-state-error-primary);font-size:11px;padding:4px 0;white-space:pre-wrap}
.dsh-ci-results{max-height:190px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin-bottom:10px}
.dsh-ci-row{display:flex;align-items:stretch;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;box-sizing:border-box;width:100%}
.dsh-ci-row:last-child{border-bottom:0}
.dsh-ci-row[data-active="true"]{background:var(--dsw-alias-interactive-bg-active)}
.dsh-ci-row-main{display:flex;align-items:baseline;gap:6px;flex:1;min-width:0;padding:5px 8px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsh-ci-row-main:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ci-row-open{flex:none;align-items:center;padding:0 9px;border:0;border-left:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:10px;cursor:pointer;white-space:nowrap}
.dsh-ci-row-open:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ci-kind{flex:none;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:10px}
.dsh-ci-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ci-loc{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap}
.dsh-ci-sub{padding:0 8px 5px;color:var(--dsw-alias-label-secondary);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ci-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0 6px}
.dsh-ci-select{height:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:0 4px;outline:none}
.dsh-ci-graph{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:auto;background:var(--dsw-alias-bg-layer-1);margin-bottom:10px}
.dsh-ci-graph svg{display:block}
.dsh-ci-gnode{cursor:pointer}
.dsh-ci-gnode rect{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-border-l2);stroke-width:1}
.dsh-ci-gnode text{fill:var(--dsw-alias-label-primary);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dsh-ci-gnode[data-relation="root"] rect{stroke:var(--dsw-alias-brand-primary);stroke-width:1.5}
.dsh-ci-gnode[data-relation="caller"] rect{stroke:var(--dsw-alias-state-warn-primary)}
.dsh-ci-gnode[data-relation="callee"] rect{stroke:var(--dsw-alias-state-business-primary)}
.dsh-ci-gnode[data-selected="true"] rect{fill:var(--dsw-alias-interactive-bg-hover-accent,var(--dsw-alias-bg-layer-3))}
.dsh-ci-gkind{fill:var(--dsw-alias-label-tertiary);font-size:9px}
.dsh-ci-detail{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1)}
.dsh-ci-detail-name{font-weight:600;font-size:12px;word-break:break-all}
.dsh-ci-detail-loc{color:var(--dsw-alias-label-secondary);font-size:10px;word-break:break-all;margin:1px 0 5px}
.dsh-ci-sig{color:var(--dsw-alias-label-secondary);font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;margin:2px 0 6px}
.dsh-ci-actions{display:flex;gap:6px;flex-wrap:wrap}
.dsh-ci-section{margin-top:6px}
.dsh-ci-section-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:4px;display:flex;align-items:center;gap:6px}
.dsh-ci-icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
`

    // ---- file addresses (open-at-line) ---------------------------------
    // Mirrors the stock session-scoped file address grammar; the stock file
    // viewer vetoes `absolute`-scoped addresses, so always use session scope.
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'
    const encodeSegment = (value) => encodeURIComponent(value).replace(/%3A/gi, ':')
    const encodePath = (value) =>
      value
        .split('/')
        .map(encodeSegment)
        .join('/')
    const sessionFileAddress = (sessionId, file) =>
      `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(
        file.replace(/\\/g, '/').replace(/^(?:\.\/)+/, ''),
      )}`

    /** Build a session-scoped address for a workspace-relative or absolute path. */
    function fileAddressFor(sessionId, cwd, file) {
      const slash = String(file).replace(/\\/g, '/')
      const absolute = slash.startsWith('/') || /^[A-Za-z]:\//.test(slash) || slash.startsWith('//')
      if (!absolute) return sessionFileAddress(sessionId, slash)
      const root = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
      if (root !== '' && slash === root) return sessionFileAddress(sessionId, '')
      if (root !== '' && slash.startsWith(`${root}/`)) return sessionFileAddress(sessionId, slash.slice(root.length + 1))
      return sessionFileAddress(sessionId, slash)
    }

    /** Open a file at a 1-based line in the right sidebar's file viewer. */
    function openAtLine(ctx, tabInfo, sessionId, cwd, file, line) {
      if (typeof file !== 'string' || file === '' || typeof sessionId !== 'string') return false
      let address
      try {
        address = fileAddressFor(sessionId, cwd, file)
      } catch {
        return false
      }
      const actions = tabInfo?.tab?.actions
      if (actions !== undefined && typeof actions.openResource === 'function') {
        try {
          actions.openResource(address, { params: { line }, preferNewPane: true })
          return true
        } catch {
          // fall through to the direct service call
        }
      }
      try {
        const sidebarRight = ctx.get('sidebarRight')
        if (sidebarRight !== undefined && typeof sidebarRight.openResource === 'function') {
          sidebarRight.openResource(address, { params: { line }, preferNewPane: true })
          return true
        }
      } catch {
        // report failure to the caller
      }
      return false
    }

    // ---- HTTP helpers ---------------------------------------------------
    /** Document-relative URL (no leading slash: the GUI may be reverse-proxied). */
    function apiUrl(path, params) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const query = search.toString()
      return `${API_BASE}/${path}${query === '' ? '' : `?${query}`}`
    }

    /** One GET request returning `value`; throws a readable error on failure. */
    async function apiGet(path, params, signal) {
      const response = await fetch(apiUrl(path, params), { signal })
      return readEnvelope(path, response)
    }

    /** One POST request returning `value`. */
    async function apiPost(path, body, signal) {
      const response = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal,
      })
      return readEnvelope(path, response)
    }

    /** Decode the `{ ok, value }` envelope, mapping HTTP failures to errors. */
    async function readEnvelope(path, response) {
      if (response.status === 401) throw new Error('expired')
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`${path}: invalid JSON`)
      }
      if (payload === null || typeof payload !== 'object') throw new Error(`${path}: empty response`)
      if (payload.ok !== true) throw new Error(payload.error?.message ?? `${path}: request failed`)
      return payload.value
    }

    /** Human error text; a 401 maps to the reload hint. */
    function errorText(t, error) {
      if (error instanceof Error && error.message === 'expired') return t('expired')
      return error instanceof Error ? error.message : String(error)
    }

    /** Copy the readiness fields a query response carries into the status block. */
    function readinessOf(value) {
      if (value === null || typeof value !== 'object') return undefined
      return {
        workspace: value.workspace,
        ready: value.ready === true,
        building: value.building === true,
        state: value.state,
        progress: value.progress ?? null,
        files: value.files ?? 0,
        symbols: value.symbols ?? 0,
        roots: value.roots ?? [],
        builtAt: value.builtAt,
        error: value.error,
      }
    }

    // ---- call-graph layout ---------------------------------------------
    const COL_W = 186
    const ROW_H = 44
    const NODE_W = 156
    const NODE_H = 30
    const MARGIN = 12

    /**
     * Lay out a call graph: root in the middle column, caller depths to the
     * left, callee depths to the right, vertically stacked per column.
     */
    function layoutGraph(nodes, edges) {
      const root = nodes.find((node) => node.relation === 'root') ?? nodes[0]
      if (root === undefined) return { width: 320, height: 120, positions: new Map(), edges: [] }
      const columns = new Map()
      for (const node of nodes) {
        if (node === root) continue
        const side = node.relation === 'caller' ? -1 : 1
        const depth = Math.max(1, Math.min(4, Number(node.depth) || 1))
        const key = `${side}:${depth}`
        if (!columns.has(key)) columns.set(key, { side, depth, nodes: [] })
        columns.get(key).nodes.push(node)
      }
      const leftMax = Math.max(1, ...[...columns.values()].filter((column) => column.side < 0).map((column) => column.depth))
      const rightMax = Math.max(1, ...[...columns.values()].filter((column) => column.side > 0).map((column) => column.depth))
      let maxRows = 1
      for (const column of columns.values()) maxRows = Math.max(maxRows, column.nodes.length)
      const height = maxRows * ROW_H + MARGIN * 2
      const centerX = MARGIN + leftMax * COL_W
      const width = MARGIN * 2 + (leftMax + rightMax) * COL_W + NODE_W
      const positions = new Map()
      positions.set(root.id, { x: centerX, y: height / 2 - NODE_H / 2, w: NODE_W, h: NODE_H })
      for (const column of columns.values()) {
        const x = column.side < 0 ? centerX - column.depth * COL_W : centerX + column.depth * COL_W
        const count = column.nodes.length
        const offsetY = height / 2 - ((count - 1) * ROW_H) / 2
        column.nodes.forEach((node, index) => {
          positions.set(node.id, { x, y: offsetY + index * ROW_H - NODE_H / 2, w: NODE_W, h: NODE_H })
        })
      }
      const links = []
      for (const edge of edges) {
        const from = positions.get(edge.from)
        const to = positions.get(edge.to)
        if (from === undefined || to === undefined) continue
        const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 }
        const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 }
        const forward = toCenter.x >= fromCenter.x
        const x1 = forward ? from.x + from.w : from.x
        const x2 = forward ? to.x : to.x + to.w
        const y1 = fromCenter.y
        const y2 = toCenter.y
        const bend = Math.max(24, Math.abs(x2 - x1) / 2)
        const c1 = x1 + (forward ? bend : -bend)
        const c2 = x2 - (forward ? bend : -bend)
        links.push({ key: `${edge.from}-${edge.to}`, d: `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}` })
      }
      return { width, height, positions, edges: links }
    }

    /** Truncate a symbol name for a fixed-width node. */
    function shortName(name) {
      const text = String(name)
      return text.length > 22 ? `${text.slice(0, 21)}…` : text
    }

    /** Minimal line icon used in the tab guide and headers. */
    function CodeIcon({ size }) {
      const dimension = typeof size === 'number' ? size : 16
      return h(
        'svg',
        {
          width: dimension,
          height: dimension,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'm5.5 4.5-3 3.5 3 3.5M10.5 4.5l3 3.5-3 3.5' }),
      )
    }

    /** SVG call graph. Pure render; clicking selects, double-click re-centers. */
    function GraphView({ graph, t, selectedId, onSelect, onCenter }) {
      const layout = React.useMemo(() => layoutGraph(graph.nodes, graph.edges), [graph])
      const byId = React.useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph])
      const children = []
      children.push(
        h(
          'defs',
          { key: 'defs' },
          h(
            'marker',
            {
              id: 'dsh-ci-arrow',
              viewBox: '0 0 8 8',
              refX: 7,
              refY: 4,
              markerWidth: 7,
              markerHeight: 7,
              orient: 'auto-start-reverse',
            },
            h('path', { d: 'M0 0 L8 4 L0 8 z', fill: 'var(--dsw-alias-border-l4)' }),
          ),
        ),
      )
      for (const link of layout.edges) {
        children.push(
          h('path', {
            key: `edge-${link.key}`,
            d: link.d,
            fill: 'none',
            stroke: 'var(--dsw-alias-border-l3)',
            strokeWidth: 1,
            markerEnd: 'url(#dsh-ci-arrow)',
          }),
        )
      }
      for (const node of graph.nodes) {
        const position = layout.positions.get(node.id)
        if (position === undefined) continue
        children.push(
          h(
            'g',
            {
              key: `node-${node.id}`,
              className: 'dsh-ci-gnode',
              'data-relation': node.relation,
              'data-selected': node.id === selectedId ? 'true' : 'false',
              transform: `translate(${position.x},${position.y})`,
              onClick: () => onSelect(node.id),
              onDoubleClick: () => onCenter(node.name),
            },
            h('title', null, `${node.name}${node.file ? ` — ${node.file}:${node.line}` : ''}`),
            h('rect', { width: position.w, height: position.h, rx: 7, ry: 7 }),
            h('text', { x: 9, y: 13 }, shortName(node.name)),
            h('text', { x: 9, y: 24, className: 'dsh-ci-gkind' }, String(node.kind)),
          ),
        )
      }
      return h(
        'svg',
        {
          width: Math.max(layout.width, 280),
          height: Math.max(layout.height, 140),
          viewBox: `0 0 ${Math.max(layout.width, 280)} ${Math.max(layout.height, 140)}`,
          role: 'img',
          'aria-label': graph.symbol,
        },
        ...children,
      )
    }

    // ---- panel ----------------------------------------------------------
    /** Guard: the panel needs a session-scoped slot (and its standard props). */
    function PanelGuard(props) {
      if (typeof props.useSessions !== 'function' || typeof props.useTabInfo !== 'function') {
        return h('div', { className: 'dsh-ci' }, h('div', { className: 'dsh-ci-hint', style: { padding: 12 } }, 'Code Insight needs an active session'))
      }
      return h(Panel, props)
    }

    /** The Code Insight tab body. */
    function Panel(props) {
      const { t, sessionId, useSessions, useTabInfo, ctx } = props
      const cwd = useSessions((state) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd))
      const tabInfo = useTabInfo()

      const [text, setText] = React.useState('')
      const [results, setResults] = React.useState(null)
      const [searching, setSearching] = React.useState(false)
      const [searchError, setSearchError] = React.useState(undefined)
      const [status, setStatus] = React.useState(null)
      const [statusError, setStatusError] = React.useState(undefined)
      const [statusTick, setStatusTick] = React.useState(0)
      const [symbol, setSymbol] = React.useState('')
      const [direction, setDirection] = React.useState('both')
      const [depth, setDepth] = React.useState(2)
      const [graph, setGraph] = React.useState(null)
      const [graphError, setGraphError] = React.useState(undefined)
      const [graphLoading, setGraphLoading] = React.useState(false)
      const [graphTick, setGraphTick] = React.useState(0)
      const [selectedId, setSelectedId] = React.useState(0)
      const [outline, setOutline] = React.useState(null)
      const [notice, setNotice] = React.useState(undefined)

      // Status (polled while a build runs).
      React.useEffect(() => {
        if (sessionId === undefined) return undefined
        const controller = new AbortController()
        let timer
        const load = () => {
          apiGet('status', { sessionId }, controller.signal)
            .then((value) => {
              setStatus(value)
              setStatusError(undefined)
              if (value !== null && value.building === true && !controller.signal.aborted) {
                timer = globalThis.setTimeout(load, 1500)
              }
            })
            .catch((error) => {
              if (!controller.signal.aborted) setStatusError(errorText(t, error))
            })
        }
        load()
        return () => {
          controller.abort()
          if (timer !== undefined) globalThis.clearTimeout(timer)
        }
      }, [sessionId, statusTick, t])

      // Debounced symbol search.
      React.useEffect(() => {
        if (sessionId === undefined) return undefined
        const query = text.trim()
        if (query === '') {
          setResults(null)
          setSearching(false)
          setSearchError(undefined)
          return undefined
        }
        const controller = new AbortController()
        setSearching(true)
        setSearchError(undefined)
        const timer = globalThis.setTimeout(() => {
          apiGet('search', { q: query, sessionId, limit: 30 }, controller.signal)
            .then((value) => {
              setResults(value)
              setSearching(false)
              const readiness = readinessOf(value)
              if (readiness !== undefined) setStatus((previous) => ({ ...previous, ...readiness }))
            })
            .catch((error) => {
              if (controller.signal.aborted) return
              setSearching(false)
              setSearchError(errorText(t, error))
            })
        }, 320)
        return () => {
          globalThis.clearTimeout(timer)
          controller.abort()
        }
      }, [text, sessionId, t])

      // Call graph for the current symbol.
      React.useEffect(() => {
        if (sessionId === undefined || symbol === '') return undefined
        const controller = new AbortController()
        setGraphLoading(true)
        setGraphError(undefined)
        apiGet(
          'graph',
          { symbol, sessionId, depth, direction, max_nodes: 40, max_children: 8 },
          controller.signal,
        )
          .then((value) => {
            if (controller.signal.aborted) return
            setGraph(value)
            setSelectedId(0)
            setGraphLoading(false)
            const readiness = readinessOf(value)
            if (readiness !== undefined) setStatus((previous) => ({ ...previous, ...readiness }))
          })
          .catch((error) => {
            if (controller.signal.aborted) return
            setGraphLoading(false)
            setGraphError(errorText(t, error))
          })
        return () => controller.abort()
      }, [symbol, sessionId, depth, direction, graphTick, t])

      // Once the index becomes queryable, retry a graph request that failed on readiness.
      React.useEffect(() => {
        if (symbol === '') return
        if (status !== null && status.ready === true && graph !== null && graph.ready === false) {
          setGraphTick((value) => value + 1)
        }
      }, [status, graph, symbol])

      const selectedNode = React.useMemo(() => {
        if (graph === null) return undefined
        return graph.nodes.find((node) => node.id === selectedId) ?? graph.nodes[0]
      }, [graph, selectedId])

      const outlineFile = selectedNode?.file ?? graph?.definition?.file

      // Outline of the selected node's file.
      React.useEffect(() => {
        if (sessionId === undefined || outlineFile === undefined || outlineFile === '') {
          setOutline(null)
          return undefined
        }
        const controller = new AbortController()
        apiGet('outline', { file: outlineFile, sessionId, limit: 400 }, controller.signal)
          .then((value) => {
            if (!controller.signal.aborted) setOutline(value)
          })
          .catch(() => {
            if (!controller.signal.aborted) setOutline(null)
          })
        return () => controller.abort()
      }, [outlineFile, sessionId, graph?.builtAt])

      // Open the tab's requested symbol (when opened with params).
      React.useEffect(() => {
        const params = tabInfo?.tab?.navigation?.params
        if (params === undefined || typeof params.symbol !== 'string' || params.symbol === '') return
        setSymbol((current) => (current === params.symbol ? current : params.symbol))
        setText((current) => (current === params.symbol ? current : params.symbol))
      }, [tabInfo?.tab?.navigation?.revision])

      const onBuild = () => {
        setStatusError(undefined)
        apiPost('build', { action: 'build', sessionId })
          .then((value) => {
            setStatus(value)
            setStatusTick((tick) => tick + 1)
          })
          .catch((error) => setStatusError(errorText(t, error)))
      }

      const onCenter = (name) => {
        setSymbol(name)
        setText((current) => (current === name ? current : name))
      }

      const onOpen = (file, line) => {
        if (typeof file !== 'string' || file === '') {
          setNotice(t('openUnavailable'))
          return
        }
        if (typeof sessionId !== 'string') {
          setNotice(t('sessionMissing'))
          return
        }
        const opened = openAtLine(ctx, tabInfo, sessionId, cwd, file, line)
        if (opened) {
          setNotice(undefined)
          return
        }
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
            navigator.clipboard.writeText(`${file}:${line}`)
          }
        } catch {
          // clipboard is a best-effort fallback
        }
        setNotice(`${t('openFailed')} ${file}:${line}`)
      }

      const state = status?.state ?? 'empty'
      const definition = graph?.definition
      const rows = results?.hits ?? []

      return h(
        'div',
        { className: 'dsh-ci', 'data-plugin': 'code-insight' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dsh-ci-head' },
          h('span', { className: 'dsh-ci-icon' }, h(CodeIcon, { size: 14 })),
          h('span', { className: 'dsh-ci-title' }, t('tab')),
          h(
            'span',
            { className: 'dsh-ci-pill', 'data-state': state, title: status?.workspace ?? '' },
            state === 'ready'
              ? `${t('ready')} · ${status?.symbols ?? 0}`
              : state === 'building'
                ? t('building')
                : state === 'error'
                  ? t('error')
                  : t('empty'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-ci-btn',
              title: t('build'),
              onClick: onBuild,
              disabled: status?.building === true,
            },
            t('build'),
          ),
        ),
        h(
          'div',
          { className: 'dsh-ci-scroll' },
          h(
            'div',
            { className: 'dsh-ci-searchbox' },
            h('input', {
              className: 'dsh-ci-input',
              type: 'search',
              placeholder: t('searchPlaceholder'),
              value: text,
              spellCheck: false,
              'aria-label': t('searchPlaceholder'),
              onChange: (event) => setText(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                const first = rows[0]
                if (first !== undefined) onCenter(first.name)
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ci-btn',
                onClick: () => setStatusTick((tick) => tick + 1),
              },
              t('refresh'),
            ),
          ),
          statusError !== undefined ? h('div', { className: 'dsh-ci-error' }, `${t('statusError')}: ${statusError}`) : null,
          notice !== undefined ? h('div', { className: 'dsh-ci-hint' }, notice) : null,
          status !== null && Array.isArray(status.roots) && status.roots.length > 0
            ? h('div', { className: 'dsh-ci-hint' }, `${t('roots')}: ${status.roots.map((root) => root || '.').join(', ')}`)
            : null,
          searching ? h('div', { className: 'dsh-ci-hint' }, t('searching')) : null,
          searchError !== undefined ? h('div', { className: 'dsh-ci-error' }, `${t('searchError')}: ${searchError}`) : null,
          results !== null && rows.length === 0
            ? h('div', { className: 'dsh-ci-hint' }, t('noResults'))
            : null,
          rows.length > 0
            ? h(
                'div',
                { className: 'dsh-ci-results' },
                ...rows.map((hit) =>
                  h(
                    'div',
                    {
                      key: `${hit.name}|${hit.file}|${hit.line}`,
                      className: 'dsh-ci-row',
                      'data-active': hit.name === symbol ? 'true' : 'false',
                    },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-ci-row-main',
                        title: `${hit.file}:${hit.line}`,
                        onClick: () => {
                          onCenter(hit.name)
                          onOpen(hit.file, hit.line)
                        },
                      },
                      h('span', { className: 'dsh-ci-kind' }, hit.kind),
                      h('span', { className: 'dsh-ci-name' }, hit.name),
                      h('span', { className: 'dsh-ci-loc' }, `${hit.file.split('/').pop()}:${hit.line}`),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-ci-row-open',
                        title: `${t('open')} ${hit.file}:${hit.line}`,
                        onClick: () => {
                          onCenter(hit.name)
                          onOpen(hit.file, hit.line)
                        },
                      },
                      t('open'),
                    ),
                  ),
                ),
              )
            : null,
          text.trim() === ''
            ? h('div', { className: 'dsh-ci-hint' }, t('searchEmpty'))
            : null,
          h(
            'div',
            { className: 'dsh-ci-toolbar' },
            h('span', { className: 'dsh-ci-hint' }, symbol === '' ? t('graphEmpty') : symbol),
            h(
              'select',
              {
                className: 'dsh-ci-select',
                value: direction,
                onChange: (event) => setDirection(event.target.value),
                'aria-label': t('direction'),
              },
              h('option', { value: 'both' }, t('both')),
              h('option', { value: 'callers' }, t('callersOnly')),
              h('option', { value: 'callees' }, t('calleesOnly')),
            ),
            h(
              'select',
              {
                className: 'dsh-ci-select',
                value: depth,
                onChange: (event) => setDepth(Number(event.target.value) || 2),
                'aria-label': t('depth'),
              },
              h('option', { value: 1 }, '1'),
              h('option', { value: 2 }, '2'),
              h('option', { value: 3 }, '3'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ci-btn',
                disabled: symbol === '' || graphLoading,
                onClick: () => setGraphTick((tick) => tick + 1),
              },
              t('refresh'),
            ),
          ),
          graphLoading ? h('div', { className: 'dsh-ci-hint' }, t('graphLoading')) : null,
          graphError !== undefined ? h('div', { className: 'dsh-ci-error' }, `${t('graphError')}: ${graphError}`) : null,
          graph !== null && Array.isArray(graph.nodes) && graph.nodes.length > 0
            ? h('div', { className: 'dsh-ci-graph' }, h(GraphView, { graph, t, selectedId, onSelect: setSelectedId, onCenter }))
            : null,
          graph !== null && graph.ready === false && graph.building === true
            ? h('div', { className: 'dsh-ci-hint' }, t('building'))
            : null,
          selectedNode !== undefined
            ? h(
                'div',
                { className: 'dsh-ci-detail' },
                h('div', { className: 'dsh-ci-detail-name' }, selectedNode.name),
                h(
                  'div',
                  { className: 'dsh-ci-detail-loc' },
                  selectedNode.file === ''
                    ? String(selectedNode.relation)
                    : `${selectedNode.file}:${selectedNode.line} · ${selectedNode.relation}`,
                ),
                definition !== undefined && definition.signature !== undefined && selectedNode.relation === 'root'
                  ? h('div', { className: 'dsh-ci-sig' }, definition.signature)
                  : null,
                h(
                  'div',
                  { className: 'dsh-ci-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ci-btn',
                      'data-primary': 'true',
                      disabled: selectedNode.file === '',
                      onClick: () => onOpen(selectedNode.file, selectedNode.line),
                    },
                    t('open'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ci-btn',
                      disabled: selectedNode.name === symbol,
                      onClick: () => onCenter(selectedNode.name),
                    },
                    t('center'),
                  ),
                ),
              )
            : null,
          outline !== null && Array.isArray(outline.symbols) && outline.symbols.length > 0
            ? h(
                'div',
                { className: 'dsh-ci-section' },
                h('div', { className: 'dsh-ci-section-title' }, `${t('outline')} · ${outline.file ?? ''}`),
                h(
                  'div',
                  { className: 'dsh-ci-results', style: { maxHeight: 220 } },
                  ...outline.symbols.map((entry) =>
                    h(
                      'button',
                      {
                        key: `${entry.name}|${entry.line}`,
                        type: 'button',
                        className: 'dsh-ci-row',
                        onClick: () => onOpen(outline.file, entry.line),
                        title: entry.signature ?? '',
                      },
                      h('span', { className: 'dsh-ci-kind' }, entry.kind),
                      h('span', { className: 'dsh-ci-name' }, entry.name),
                      h('span', { className: 'dsh-ci-loc' }, String(entry.line)),
                    ),
                  ),
                ),
              )
            : null,
          h('div', { className: 'dsh-ci-hint', style: { paddingTop: 6 } }, t('hintOpen')),
        ),
      )
    }

    /** Mount the right-sidebar tab type and its body. */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'code-insight: locale dictionaries')
      ctx.inject(['sidebarRightTabs'], (c) => {
        const tabs = c.sidebarRightTabs
        if (tabs === undefined || typeof tabs.register !== 'function') return undefined
        const disposers = []
        try {
          disposers.push(
            tabs.register({
              id: TAB_ID,
              kind: KIND,
              title: () => t('tab'),
              guide: [
                {
                  id: TAB_ID,
                  order: 20,
                  title: () => t('tab'),
                  description: () => t('desc'),
                  icon: CodeIcon,
                },
              ],
            }),
          )
        } catch (error) {
          console.error('[code-insight] cannot register the right-sidebar tab type', error)
          return undefined
        }
        disposers.push(
          c.slots.inject('sidebar.right.pane.tab', () =>
            c.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, (props) =>
              h(PanelGuard, { ...props, ctx }),
            ),
          ),
        )
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // ignore a double dispose
            }
          }
        }
      })

      // `@` completion in the composer: type `@ipc` to pick an indexed symbol;
      // the pick inserts `name (file:line)` as plain text for the next turn.
      ctx.inject(['inputTriggers'], (triggersCtx) => {
        try {
          const registry = triggersCtx.get('inputTriggers')
          if (registry === undefined || typeof registry.registerSource !== 'function') return undefined
          const source = {
            trigger: '@',
            name: 'codeInsight',
            order: 40,
            showGroupTitle: true,
            async candidates(session, context) {
              const query = typeof context?.query === 'string' ? context.query.trim() : ''
              if (query === '') return []
              const sessionId = session?.sessionId ?? session?.id
              try {
                const value = await apiGet(
                  'search',
                  { q: query, sessionId, limit: 8 },
                  context?.signal,
                )
                const hits = Array.isArray(value?.hits) ? value.hits : []
                return hits.map((hit) => ({
                  name: hit.name,
                  label: hit.name,
                  description: `${hit.kind} · ${hit.file}:${hit.line}`,
                  icon: 'file',
                  value: JSON.stringify({ name: hit.name, file: hit.file, line: hit.line }),
                }))
              } catch {
                return []
              }
            },
            onPick({ candidate }) {
              try {
                const picked = JSON.parse(candidate.value ?? '{}')
                if (typeof picked.name !== 'string') return undefined
                const location = typeof picked.file === 'string' ? ` (${picked.file}:${picked.line})` : ''
                return { text: `${picked.name}${location} ` }
              } catch {
                return undefined
              }
            },
          }
          return ctx.effect(() => registry.registerSource(source), 'code-insight: @ symbol source')
        } catch (error) {
          console.error('[code-insight] cannot register the @ symbol source', error)
          return undefined
        }
      })
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
