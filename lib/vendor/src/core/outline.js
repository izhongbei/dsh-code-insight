"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildOutlineTree = buildOutlineTree;
/** 行区间归属只看具名类型体。 */
const CONTAINER_KINDS = new Set(['struct', 'union', 'enum']);
/** 名字兜底额外接受 typedef（匿名类型体成员 parent = 别名）。 */
const NAME_PARENT_KINDS = new Set(['struct', 'union', 'enum', 'typedef']);
/** 只有这两类符号会被嵌套，其余符号始终是顶层节点。 */
const CHILD_KINDS = new Set(['member', 'enumConstant']);
function spanOf(entry) {
    return Math.max(0, entry.endLine - entry.line);
}
/**
 * 包含 child 的最内层容器。
 *
 * 先比区间跨度（最小者最内层）。跨度相同时（典型：同一行定义多个类型，
 * `struct foo { int a; }; struct bar { int b; };`）不能只按文件顺序：
 * 优先取名字等于 `child.parent` 的容器，其次取起点离 child 最近的前置容器，
 * 最后才按文件顺序（保持稳定）。
 */
function innermostContainer(child, containers) {
    let best;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (const container of containers) {
        if (container.line > child.line || child.endLine > container.endLine) {
            continue;
        }
        const span = spanOf(container);
        if (best === undefined || span < bestSpan) {
            best = container;
            bestSpan = span;
            continue;
        }
        if (span > bestSpan) {
            continue;
        }
        // 同跨度：名字与 parent 一致者优先（v5 同文件同名类型也能各归各的）。
        const named = child.parent !== undefined && container.name === child.parent;
        const bestNamed = child.parent !== undefined && best.name === child.parent;
        if (named !== bestNamed) {
            if (named) {
                best = container;
            }
            continue;
        }
        // 再按「最近的前置起点」；起点也相同则保持文件顺序。
        if (container.line > best.line) {
            best = container;
        }
    }
    return best;
}
/** 行区间匹配不到时按 parent 名字兜底：优先取 child 之前最近的一个同名类型。 */
function parentByName(child, candidates) {
    if (!child.parent) {
        return undefined;
    }
    const named = candidates.filter((candidate) => candidate.name === child.parent);
    if (named.length === 0) {
        return undefined;
    }
    let best;
    for (const candidate of named) {
        if (candidate.line <= child.line && (!best || candidate.line > best.line)) {
            best = candidate;
        }
    }
    return best ?? named[0];
}
function buildOutlineTree(entries) {
    const containers = entries.filter((entry) => CONTAINER_KINDS.has(entry.kind));
    const nameParents = entries.filter((entry) => NAME_PARENT_KINDS.has(entry.kind));
    const nodes = new Map();
    for (const entry of entries) {
        nodes.set(entry, { entry, children: [] });
    }
    // 先算归属再挂接：不依赖父类型在 entries 中出现的先后顺序。
    const parentOf = new Map();
    for (const entry of entries) {
        if (!CHILD_KINDS.has(entry.kind)) {
            continue;
        }
        const parent = innermostContainer(entry, containers) ?? parentByName(entry, nameParents);
        if (parent) {
            parentOf.set(entry, parent);
        }
    }
    const roots = [];
    for (const entry of entries) {
        const node = nodes.get(entry);
        if (!node) {
            continue;
        }
        const parent = parentOf.get(entry);
        const parentNode = parent ? nodes.get(parent) : undefined;
        if (parentNode) {
            parentNode.children.push(node);
            continue;
        }
        roots.push(node);
    }
    return roots;
}
