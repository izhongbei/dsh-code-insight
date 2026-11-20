"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rankDefinitions = rankDefinitions;
const types_1 = require("../shared/types");
const HEADER_RE = /\.(?:h|hh|hpp|hxx|inl)$/i;
const TYPE_KINDS = new Set(['struct', 'union', 'enum', 'typedef']);
function pathSegments(file) {
    return file.split('/').filter((part) => part.length > 0);
}
function commonPrefixSegments(a, b) {
    const limit = Math.min(a.length, b.length);
    // 最后一段是文件名，不参与「同目录」判断
    const max = Math.max(0, limit - 1);
    let count = 0;
    while (count < max && a[count] === b[count])
        count++;
    return count;
}
/** 包含该文件的最长索引根（没有则 undefined）。 */
function rootOf(file, roots) {
    let best;
    for (const rawRoot of roots) {
        const root = rawRoot.replace(/^\.\/+/, '').replace(/\/+$/, '');
        if (root === '' || root === '.') {
            // 整工作区作为根：任何文件都属于它
            if (best === undefined)
                best = '';
            continue;
        }
        if (file === root || file.startsWith(root + '/')) {
            if (best === undefined || root.length > best.length)
                best = root;
        }
    }
    return best;
}
function extensionPreference(entry) {
    const header = HEADER_RE.test(entry.file);
    if (TYPE_KINDS.has(entry.kind))
        return header ? 0 : 1;
    if (entry.kind === 'function')
        return header ? 1 : 0;
    return 0;
}
/** 判断条目是否被光标文件包含；源文件自身也算 included（不加表内自环边）。 */
function isIncluded(entry, context) {
    const sourceFile = context.sourceFile;
    if (sourceFile === undefined)
        return false;
    if (entry.file === sourceFile)
        return true;
    return context.table !== undefined && context.table.isReachable(sourceFile, entry.file);
}
function rankDefinitions(entries, context = {}) {
    if (entries.length <= 1)
        return [...entries];
    const sourceSegments = context.sourceFile ? pathSegments(context.sourceFile) : [];
    const sourceRoot = context.sourceFile ? rootOf(context.sourceFile, context.roots ?? []) : undefined;
    const hasRootContext = sourceRoot !== undefined;
    // include 键只在同时有源文件与表时参与；无表/无光标时只是该键不参与，
    // 其余键（包括不需要表的条件 tie-break）保持不变。
    const hasIncludeContext = context.sourceFile !== undefined && context.table !== undefined;
    const scored = entries.map((entry, index) => {
        const entrySegments = pathSegments(entry.file);
        const entryRoot = hasRootContext ? rootOf(entry.file, context.roots ?? []) : undefined;
        const sameRoot = hasRootContext ? (entryRoot === sourceRoot ? 0 : 1) : 0;
        return {
            entry,
            index,
            notIncluded: hasIncludeContext && !isIncluded(entry, context) ? 1 : 0,
            sameRoot,
            sharedSegments: sourceSegments.length > 0 ? -commonPrefixSegments(entrySegments, sourceSegments) : 0,
            kindOrder: types_1.SYMBOL_KIND_ORDER[entry.kind] ?? 99,
            extensionPreference: extensionPreference(entry),
            depth: entrySegments.length,
            length: entry.file.length,
            conditional: entry.condition !== undefined && entry.condition !== '' ? 1 : 0,
        };
    });
    scored.sort((a, b) => {
        if (a.notIncluded !== b.notIncluded)
            return a.notIncluded - b.notIncluded;
        if (a.sameRoot !== b.sameRoot)
            return a.sameRoot - b.sameRoot;
        if (a.sharedSegments !== b.sharedSegments)
            return a.sharedSegments - b.sharedSegments;
        if (a.kindOrder !== b.kindOrder)
            return a.kindOrder - b.kindOrder;
        if (a.extensionPreference !== b.extensionPreference) {
            return a.extensionPreference - b.extensionPreference;
        }
        if (a.depth !== b.depth)
            return a.depth - b.depth;
        if (a.length !== b.length)
            return a.length - b.length;
        // 同层（路径远近完全一致）时无条件定义优先；位于 file/line 稳定性键之前，
        // 因此跨文件同层候选也按「无条件 > 条件」排，而不是先被文件名决定。
        if (a.conditional !== b.conditional)
            return a.conditional - b.conditional;
        if (a.entry.file !== b.entry.file)
            return a.entry.file < b.entry.file ? -1 : 1;
        if (a.entry.line !== b.entry.line)
            return a.entry.line - b.entry.line;
        return a.index - b.index;
    });
    return scored.map((item) => item.entry);
}
