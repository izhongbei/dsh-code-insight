"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMutableIndex = createMutableIndex;
exports.createMutableIndexFromDeltas = createMutableIndexFromDeltas;
const symbol_order_1 = require("./symbol-order");
const symbol_table_1 = require("./symbol-table");
/**
 * overlay 索引：在只读的 base 符号表之上叠加「单文件变更层」。
 *
 * 设计目标：applyFile/removeFile/applyIncludes 只处理被改文件（O(Δ)），查询时过滤掉被覆盖/
 * 删除文件的 base 条目再合并 overlay 条目；需要完整表时用 flatten() 一次性重建。
 *
 * 计数不变量：entryCount = base.entryCount - 被隐藏的 base 条目数 + overlay 条目数。
 * v4 元数据（内容哈希 / include 边）同样遵循「overlay 优先，未改文件走 base」。
 */
/** isReachable 的 BFS 深度上限（与 symbol-table 保持一致）。 */
const MAX_INCLUDE_DEPTH = 64;
/** 空 include 结果共享同一只读数组。 */
const NO_INCLUDES = Object.freeze([]);
class MutableIndex {
    base;
    changed = new Map();
    basePaths;
    /** 文件 → 已解析 include 目标（overlay 优先于 base 边）。 */
    includesByFile = new Map();
    /** isReachable 闭包缓存；任何变更都清空（overlay 是原地修改，不能跨变更复用）。 */
    reachableCache = new Map();
    /**
     * base 中被 overlay 隐藏的条目按名字计数：用于 forEachName 过滤「条目已被全部隐藏」的名字，
     * 避免 full rebuild 才一致的语义在这里退化（只处理被改文件，保持 O(Δ)）。
     */
    hiddenBaseNameCounts = new Map();
    overlayEntryCount = 0;
    removedBaseEntryCount = 0;
    filesCache;
    pathSetCache;
    materializedCache;
    constructor(base) {
        this.base = base;
        this.basePaths = new Set(base.files.map((file) => file.path));
    }
    get version() {
        return this.base.version;
    }
    get roots() {
        return this.base.roots;
    }
    get builtAt() {
        return this.base.builtAt;
    }
    get entryCount() {
        return this.base.entryCount - this.removedBaseEntryCount + this.overlayEntryCount;
    }
    get fileCount() {
        return this.files.length;
    }
    get pendingChanges() {
        return this.changed.size;
    }
    get files() {
        if (!this.filesCache) {
            const merged = [];
            for (const file of this.base.files) {
                const slot = this.changed.get(file.path);
                if (slot === 'removed')
                    continue;
                merged.push(slot ? slot.file : file);
            }
            for (const [filePath, slot] of this.changed) {
                if (slot === 'removed' || this.basePaths.has(filePath))
                    continue;
                merged.push(slot.file);
            }
            merged.sort((a, b) => (0, symbol_order_1.compareStrings)(a.path, b.path));
            this.filesCache = merged;
        }
        return this.filesCache;
    }
    /** 当前 overlay 视图里的文件路径集合（include 目标解析过滤用）。 */
    get pathSet() {
        if (!this.pathSetCache) {
            this.pathSetCache = new Set(this.files.map((file) => file.path));
        }
        return this.pathSetCache;
    }
    /** 记录某个 base 文件被隐藏的条目名；返回被隐藏的条目数。 */
    hideBaseEntries(filePath) {
        const entries = this.base.entriesInFile(filePath);
        for (const entry of entries) {
            this.hiddenBaseNameCounts.set(entry.name, (this.hiddenBaseNameCounts.get(entry.name) ?? 0) + 1);
        }
        return entries.length;
    }
    invalidate() {
        this.filesCache = undefined;
        this.pathSetCache = undefined;
        this.materializedCache = undefined;
        this.reachableCache.clear();
    }
    applyFile(file, entries) {
        const previous = this.changed.get(file.path);
        if (previous === 'removed') {
            // base 条目在首次 remove 时已计入 removedBaseEntryCount，这里不再重复减
        }
        else if (previous) {
            this.overlayEntryCount -= previous.entries.length;
        }
        else {
            this.removedBaseEntryCount += this.hideBaseEntries(file.path);
        }
        this.changed.set(file.path, { file, entries: [...entries] });
        this.overlayEntryCount += entries.length;
        this.invalidate();
    }
    applyIncludes(file, includes) {
        const previous = this.includesByFile.get(file);
        const next = [...includes];
        if (previous && previous.length === next.length && previous.every((target, i) => target === next[i])) {
            return; // 无变化：不清缓存
        }
        this.includesByFile.set(file, next);
        this.invalidate();
    }
    removeFile(file) {
        const previous = this.changed.get(file);
        if (previous === 'removed')
            return false;
        if (previous) {
            this.overlayEntryCount -= previous.entries.length;
        }
        else {
            if (!this.basePaths.has(file))
                return false;
            this.removedBaseEntryCount += this.hideBaseEntries(file);
        }
        this.changed.set(file, 'removed');
        this.invalidate();
        return true;
    }
    entriesInFile(file) {
        const slot = this.changed.get(file);
        if (slot === 'removed')
            return [];
        // 与 SymbolTableImpl.entriesInFile 保持同一顺序：行 → 列 → 名字。
        if (slot)
            return [...slot.entries].sort((a, b) => a.line - b.line || a.column - b.column || (0, symbol_order_1.compareStrings)(a.name, b.name));
        return this.base.entriesInFile(file);
    }
    findByName(name) {
        const result = [];
        for (const entry of this.base.findByName(name)) {
            if (this.changed.has(entry.file))
                continue;
            result.push(entry);
        }
        for (const slot of this.changed.values()) {
            if (slot === 'removed')
                continue;
            for (const entry of slot.entries)
                if (entry.name === name)
                    result.push(entry);
        }
        return result.sort(symbol_order_1.compareSymbolEntries);
    }
    forEachName(callback) {
        const overlayNames = new Set();
        for (const slot of this.changed.values()) {
            if (slot === 'removed')
                continue;
            for (const entry of slot.entries)
                overlayNames.add(entry.name);
        }
        if (overlayNames.size === 0 && this.hiddenBaseNameCounts.size === 0) {
            this.base.forEachName(callback);
            return;
        }
        const extra = [...overlayNames].sort(symbol_order_1.compareStrings);
        let extraIndex = 0;
        this.base.forEachName((name) => {
            while (extraIndex < extra.length && (0, symbol_order_1.compareStrings)(extra[extraIndex], name) < 0) {
                callback(extra[extraIndex++]);
            }
            const inExtra = extraIndex < extra.length && extra[extraIndex] === name;
            if (inExtra)
                extraIndex += 1;
            const hidden = this.hiddenBaseNameCounts.get(name);
            // 名字的全部 base 条目都被隐藏时，只有 overlay 同名条目能把它补回来
            if (hidden === undefined || inExtra || this.base.findByName(name).length > hidden) {
                callback(name);
            }
        });
        while (extraIndex < extra.length)
            callback(extra[extraIndex++]);
    }
    forEachEntry(callback) {
        this.base.forEachEntry((entry) => {
            if (!this.changed.has(entry.file))
                callback(entry);
        });
        for (const slot of this.changed.values()) {
            if (slot === 'removed')
                continue;
            for (const entry of slot.entries)
                callback(entry);
        }
    }
    materialized() {
        if (!this.materializedCache) {
            const result = [];
            this.base.forEachEntry((entry) => {
                if (!this.changed.has(entry.file))
                    result.push(entry);
            });
            for (const slot of this.changed.values()) {
                if (slot === 'removed')
                    continue;
                for (const entry of slot.entries)
                    result.push(entry);
            }
            this.materializedCache = result;
        }
        return this.materializedCache;
    }
    entryAt(index) {
        const array = this.materialized();
        if (index < 0 || index >= array.length) {
            throw new RangeError(`symbol index out of range: ${index}`);
        }
        return array[index];
    }
    toArray() {
        return [...this.materialized()];
    }
    includedFiles(file) {
        if (this.changed.get(file) === 'removed')
            return NO_INCLUDES;
        const recorded = this.includesByFile.get(file);
        const targets = recorded ?? this.base.includedFiles(file);
        if (targets.length === 0)
            return NO_INCLUDES;
        const known = this.pathSet;
        // 过滤 overlay 中已被删除的文件，保证 flatten/合并视图与 base 边一致
        const result = targets.filter((target) => known.has(target));
        return result.length === 0 ? NO_INCLUDES : result;
    }
    isReachable(fromFile, toFile) {
        if (this.changed.get(fromFile) === 'removed')
            return false;
        let reachable = this.reachableCache.get(fromFile);
        if (!reachable) {
            reachable = this.computeReachable(fromFile);
            this.reachableCache.set(fromFile, reachable);
        }
        return reachable.has(toFile);
    }
    /** 在 base 边 + overlay 边上做 BFS（深度上限 64）。 */
    computeReachable(fromFile) {
        const visited = new Set();
        let frontier = [fromFile];
        for (let depth = 0; depth < MAX_INCLUDE_DEPTH && frontier.length > 0; depth++) {
            const next = [];
            for (const file of frontier) {
                // removed 文件不参与 BFS（其 base 边已失效）
                if (this.changed.get(file) === 'removed')
                    continue;
                for (const target of this.includedFiles(file)) {
                    if (visited.has(target))
                        continue;
                    visited.add(target);
                    next.push(target);
                }
            }
            frontier = next;
        }
        return visited;
    }
    contentHashOf(file) {
        const slot = this.changed.get(file);
        if (slot === 'removed')
            return undefined;
        if (slot) {
            const lo = slot.file.contentHashLo ?? 0;
            const hi = slot.file.contentHashHi ?? 0;
            return lo === 0 && hi === 0 ? undefined : { lo, hi };
        }
        return this.base.contentHashOf(file);
    }
    pendingPaths() {
        return [...this.changed.keys()].sort(symbol_order_1.compareStrings);
    }
    flatten() {
        const files = this.files;
        const includes = new Map();
        for (const file of files) {
            const targets = this.includedFiles(file.path);
            if (targets.length > 0)
                includes.set(file.path, targets);
        }
        return (0, symbol_table_1.createSymbolTable)(this.roots, files, this.toArray(), Date.now(), this.version, {
            includes,
        });
    }
}
function createMutableIndex(base) {
    return new MutableIndex(base);
}
function createMutableIndexFromDeltas(base, records) {
    const index = new MutableIndex(base);
    for (const record of records) {
        if (record.kind === 'remove') {
            index.removeFile(record.path);
            continue;
        }
        const file = record.contentHashLo === undefined && record.contentHashHi === undefined
            ? { path: record.path, mtimeMs: record.mtimeMs, size: record.size }
            : {
                path: record.path,
                mtimeMs: record.mtimeMs,
                size: record.size,
                contentHashLo: record.contentHashLo,
                contentHashHi: record.contentHashHi,
            };
        index.applyFile(file, record.entries);
        // v2 记录一定带 includes（空数组也是权威值：该文件现在没有 include，必须清空 base 边）；
        // 字段缺失只可能来自 v1 记录（v1 没有 include 信息），此时不得改动 base 边。
        if (record.includes !== undefined)
            index.applyIncludes(record.path, record.includes);
    }
    return index;
}
