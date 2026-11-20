"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.indexRootsChanged = indexRootsChanged;
exports.createSnapshot = createSnapshot;
exports.buildIndex = buildIndex;
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const node_worker_threads_1 = require("node:worker_threads");
const types_1 = require("../shared/types");
const hash_1 = require("./hash");
const include_resolve_1 = require("./include-resolve");
const nameindex_1 = require("./nameindex");
const symbol_table_1 = require("./symbol-table");
const scan_1 = require("./scan");
const store_1 = require("./store");
const walk_1 = require("./walk");
/**
 * 并行索引构建（A）。
 *
 * 流程：walk → 与旧快照按 `mtimeMs + size` 比对 → 变更文件走 worker 池并行 `scanSource`
 * → 合并 → 可选写盘。worker 不可用/崩溃时自动退化为主线程串行，不中断构建。
 */
const DEFAULT_CONCURRENCY = 4;
const WORKER_SCRIPT = path.join(__dirname, 'worker-scan.js');
function makeAbortError() {
    const err = new Error('aborted');
    err.name = 'AbortError';
    return err;
}
function isAbortError(err) {
    return err instanceof Error && err.name === 'AbortError';
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw makeAbortError();
}
function normalizeConcurrency(value) {
    if (!Number.isFinite(value) || value <= 0)
        return DEFAULT_CONCURRENCY;
    return Math.min(64, Math.max(1, Math.floor(value)));
}
function compareStrings(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
/**
 * 归一 indexRoot，用于「本次构建 vs 旧快照」比较（规则与 walk 的 `toRelativeRoot` 对齐）：
 * `\`→`/`、折叠重复 `/`、去前导 `./`、`.`→空、去尾部 `/`、绝对路径相对化到 workspaceRoot。
 * 未提供 workspaceRoot（例如没有打开工作区）时不做绝对路径相对化。
 */
function normalizeRootPath(workspaceRoot, root) {
    let rel = root;
    if (workspaceRoot !== undefined && path.isAbsolute(rel)) {
        rel = path.relative(workspaceRoot, rel);
    }
    rel = rel.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    while (rel.startsWith('./'))
        rel = rel.slice(2);
    if (rel === '.')
        rel = '';
    return rel.replace(/\/+$/, '');
}
function normalizeRoots(workspaceRoot, roots) {
    return roots.map((root) => normalizeRootPath(workspaceRoot, root));
}
/** 顺序敏感：roots 顺序决定 include 的 root 前缀搜索顺序，顺序变了也要重新解析。 */
function sameRoots(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}
/**
 * 归一后顺序敏感的 roots 比较（indexer 与 service.rootsChanged 共用）。
 *
 * - 归一等价（`proj/` vs `proj`、`./proj` vs `proj`、绝对 vs 相对）不算变化；
 * - 仅顺序变化（`['a','b']` vs `['b','a']`）**算**变化 —— include 的 root 前缀搜索顺序
 *   是语义的一部分，必须让调用方重新解析。
 */
function indexRootsChanged(workspaceRoot, previous, current) {
    return !sameRoots(normalizeRoots(workspaceRoot, previous), normalizeRoots(workspaceRoot, current));
}
/** 组装符号表：文件与符号都做稳定排序，索引查询走 name/file 两个维度。 */
function createSnapshot(roots, files, entries, includes) {
    return (0, symbol_table_1.createSymbolTable)(roots, files, entries, Date.now(), types_1.SNAPSHOT_VERSION, { includes });
}
/** 扫描结果 → 索引条目（无 condition/parent 条目不 materialize 可选属性，保持旧快照形状）。 */
function toSymbolEntries(file, symbols) {
    return symbols.map((symbol) => {
        const entry = {
            name: symbol.name,
            kind: symbol.kind,
            file: file.path,
            line: symbol.line,
            endLine: symbol.endLine,
            column: symbol.column,
        };
        // v5：成员/枚举常量的 parent 必须透传（全局变量等无 parent 的条目保持旧形状）
        const withParent = symbol.parent === undefined || symbol.parent === ''
            ? entry
            : { ...entry, parent: symbol.parent };
        // 无条件条目不 materialize condition（与 SymbolEntry/快照的旧形状一致）
        if (symbol.condition === undefined || symbol.condition === '')
            return withParent;
        return { ...withParent, condition: symbol.condition };
    });
}
class WorkerPool {
    workers = [];
    queues = [];
    pending = new Map();
    nextId = 1;
    failure;
    closed = false;
    constructor(scriptPath, size) {
        for (let i = 0; i < size; i++) {
            const worker = new node_worker_threads_1.Worker(scriptPath);
            worker.on('message', (message) => this.handleMessage(message));
            worker.on('error', (error) => {
                this.handleFailure(error instanceof Error ? error : new Error(String(error)));
            });
            worker.on('exit', (code) => {
                if (!this.closed && code !== 0)
                    this.handleFailure(new Error(`scan worker exited with code ${code}`));
            });
            this.workers.push(worker);
            this.queues.push(0);
        }
    }
    get size() {
        return this.workers.length;
    }
    handleMessage(message) {
        const item = this.pending.get(message.id);
        if (!item)
            return;
        this.pending.delete(message.id);
        if (message.error !== undefined)
            item.reject(new Error(message.error));
        else {
            item.resolve({
                symbols: message.symbols ?? [],
                hashes: message.hashes ?? new Uint32Array(0),
                // worker 始终回传；缺省值仅为协议异常时的防御（数据仅供 0.8.0 后续任务使用）
                contentHash: message.contentHash ?? { lo: 0, hi: 0 },
                includes: message.includes ?? [],
            });
        }
    }
    handleFailure(error) {
        if (this.failure)
            return;
        this.failure = error;
        for (const item of this.pending.values())
            item.reject(error);
        this.pending.clear();
    }
    run(text) {
        if (this.failure)
            return Promise.reject(this.failure);
        let best = 0;
        for (let i = 1; i < this.queues.length; i++) {
            if (this.queues[i] < this.queues[best])
                best = i;
        }
        const worker = this.workers[best];
        this.queues[best] += 1;
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {
                resolve: (result) => {
                    this.queues[best] -= 1;
                    resolve(result);
                },
                reject: (error) => {
                    this.queues[best] -= 1;
                    reject(error);
                },
            });
            try {
                worker.postMessage({ id, text });
            }
            catch (error) {
                this.pending.delete(id);
                this.queues[best] -= 1;
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    async terminate() {
        this.closed = true;
        await Promise.all(this.workers.map((worker) => worker.terminate().catch(() => undefined)));
    }
}
async function dispatchThroughPool(pool, job) {
    let next = 0;
    const runners = [];
    for (let i = 0; i < pool.size; i++) {
        runners.push((async () => {
            for (;;) {
                throwIfAborted(job.signal);
                const index = next++;
                if (index >= job.pending.length)
                    return;
                const file = job.pending[index];
                if (job.isDone(file))
                    continue;
                let text;
                try {
                    text = String(await job.readFile(file.path));
                }
                catch {
                    job.finishSkipped(file);
                    continue;
                }
                throwIfAborted(job.signal);
                const result = await pool.run(text);
                job.finish(file, result);
            }
        })());
    }
    await Promise.all(runners);
}
async function parseRemainingSerial(job) {
    for (const file of job.pending) {
        throwIfAborted(job.signal);
        if (job.isDone(file))
            continue;
        let text;
        try {
            text = String(await job.readFile(file.path));
        }
        catch {
            job.finishSkipped(file);
            continue;
        }
        throwIfAborted(job.signal);
        const stripped = (0, scan_1.stripSources)(text);
        job.finish(file, {
            symbols: (0, scan_1.scanSource)(text, stripped),
            hashes: (0, nameindex_1.collectIdentifierHashes)(text, stripped),
            contentHash: (0, hash_1.hashContent64)(text),
            includes: (0, scan_1.scanIncludesFromStripped)(stripped, text),
        });
    }
}
/**
 * 建索引：遍历 → 增量比对 → 并行解析 → 组装（可选写快照）。
 * `summary.snapshotBytes` 仅在提供 `snapshotPath` 时非 0。
 */
async function buildIndex(options) {
    const startedAt = Date.now();
    const { workspaceRoot, roots, exclude, maxFileSizeKB, followSymlinks, previous, snapshotPath, nameIndexPath, signal, onProgress, readFile, } = options;
    const cap = options.concurrencyCap ?? Number.POSITIVE_INFINITY;
    const configuredConcurrency = normalizeConcurrency(Math.min(options.concurrency, cap));
    throwIfAborted(signal);
    const files = await (0, walk_1.walkFiles)({
        workspaceRoot,
        roots,
        exclude,
        maxFileSizeKB,
        followSymlinks,
        signal,
        onProgress,
    });
    throwIfAborted(signal);
    // 大工程自动降并发：以本次实际 walk 到的文件数为准（首次构建 / 清缓存后同样生效，
    // 不再依赖「上一轮文件数」这类外部状态）。concurrencyCap 已在上面的 configuredConcurrency
    // 中先应用，这里按实际文件数再取更小值。
    const downgrade = options.concurrencyDowngrade;
    const concurrency = downgrade && files.length > downgrade.files
        ? normalizeConcurrency(Math.min(configuredConcurrency, downgrade.concurrency))
        : configuredConcurrency;
    // 旧快照按文件建索引（版本不符视为没有旧快照：快照元数据契约不跨版本复用）。
    //
    // indexRoots 变了同样不能复用：include 边依赖 roots 做前缀解析（相对目录 → 原样 →
    // `<root>/<include>`），复用旧 `includedFiles` 会把「旧 roots 下未命中的空图」带进新
    // 索引。例如 roots 从 proj/src 改成 proj 后，proj/src/a.c 的 #include "inc/x.h" 本应
    // 解析到 proj/inc/x.h，但文件本身没变（mtime/size 相同）会走复用分支。因此 roots 归一
    // 后不一致就当作没有 previous：全部文件重扫、include 图按新 roots 重新解析。
    const rootsChanged = previous !== undefined && indexRootsChanged(workspaceRoot, previous.roots, roots);
    const previousTable = previous && !rootsChanged && previous.version === types_1.SNAPSHOT_VERSION ? previous : undefined;
    const previousFiles = new Map();
    const previousEntries = new Map();
    if (previousTable) {
        for (const file of previousTable.files)
            previousFiles.set(file.path, file);
        previousTable.forEachEntry((entry) => {
            const list = previousEntries.get(entry.file);
            if (list)
                list.push(entry);
            else
                previousEntries.set(entry.file, [entry]);
        });
    }
    // 增量比对：mtimeMs + size 都没变的文件直接复用旧符号。
    //
    // 快照元数据可用性判定（升级路径修复，格式不变）：旧版本（本任务之前的 2ffa868）写出的
    // 旧快照里，文件记录没有内容哈希、include CSR 为空、条目无条件。这种快照「版本号正确」
    // 但元数据全缺，若按 mtime+size 复用它，B1/B2/B4 会一直失效到每个文件被编辑或清缓存。
    // 因此旧快照里的文件只有「确实带哈希」才算可用于增量复用；无哈希一律当作变更重新
    // 扫描，下一次 build 就会自然补齐哈希、include 边与条件。这里刻意不写日志：升级后首次
    // 全量重扫是预期的一次性修复，不是异常。
    const reused = [];
    const pending = [];
    const unchanged = new Set();
    for (const file of files) {
        const old = previousFiles.get(file.path);
        const reusable = previousTable !== undefined && previousTable.contentHashOf(file.path) !== undefined;
        if (old && reusable && old.mtimeMs === file.mtimeMs && old.size === file.size) {
            unchanged.add(file.path);
            const entries = previousEntries.get(file.path);
            if (entries)
                reused.push(...entries);
        }
        else {
            pending.push(file);
        }
    }
    // 解析待处理文件
    const parsed = new Map();
    const skipped = new Set();
    const total = pending.length;
    let done = 0;
    const reportParse = (currentFile) => {
        onProgress?.({ phase: 'parse', done, total, currentFile });
        if (signal?.aborted)
            throw makeAbortError();
    };
    /** 每个文件的标识符哈希（单遍解析产出，供引用索引复用，不再二次读盘） */
    const parsedHashes = new Map();
    /** 每个变更文件的原始 include 路径（解析为索引内文件要等 walk 结果与 skipped 集合齐备） */
    const parsedIncludePaths = new Map();
    /** 每个变更文件的内容哈希（worker/串行扫描同遍产出，零额外 IO） */
    const parsedContentHashes = new Map();
    const finish = (file, result) => {
        parsedHashes.set(file.path, result.hashes);
        parsedIncludePaths.set(file.path, result.includes.map((include) => include.path));
        parsedContentHashes.set(file.path, result.contentHash);
        parsed.set(file.path, toSymbolEntries(file, result.symbols));
        done += 1;
        reportParse(file.path);
    };
    const finishSkipped = (file) => {
        skipped.add(file.path);
        done += 1;
        reportParse(file.path);
    };
    onProgress?.({ phase: 'parse', done: 0, total });
    if (total > 0) {
        const job = {
            pending,
            readFile,
            concurrency,
            signal,
            finish,
            finishSkipped,
            isDone: (file) => parsed.has(file.path) || skipped.has(file.path),
        };
        const workerCount = Math.min(concurrency, total);
        let pool;
        if (workerCount > 1 && (0, node_fs_1.existsSync)(WORKER_SCRIPT)) {
            try {
                pool = new WorkerPool(WORKER_SCRIPT, workerCount);
                await dispatchThroughPool(pool, job);
            }
            catch (error) {
                // worker 创建/崩溃：吞掉错误，下面串行兜底；AbortError 继续上抛
                if (isAbortError(error))
                    throw error;
            }
            finally {
                await pool?.terminate();
            }
        }
        await parseRemainingSerial(job);
    }
    // 组装统计
    const successfulFiles = [];
    const successfulPaths = new Set();
    let added = 0;
    let updated = 0;
    let unchangedCount = 0;
    for (const file of files) {
        if (skipped.has(file.path))
            continue;
        successfulFiles.push(file);
        successfulPaths.add(file.path);
        const old = previousFiles.get(file.path);
        if (!old)
            added += 1;
        else if (unchanged.has(file.path))
            unchangedCount += 1;
        else
            updated += 1;
    }
    let removed = 0;
    for (const oldPath of previousFiles.keys()) {
        if (!successfulPaths.has(oldPath))
            removed += 1;
    }
    // I2：include 边在扫描时解析，未变更文件直接复用旧边。若上一轮的某个已解析目标不在
    // 本次「成功文件」集合里（被删除、被 exclude、超过 maxFileSizeKB，或本轮读失败被
    // skipped），复用旧边会在建表时被静默忽略，而且该 includer 之后永远不会重新解析。
    // 因此把这类未变更文件当作变更重扫一次 —— 只重读 includer 本身，不读目标文件。
    // 刻意不写日志：目标消失/重建是正常的增量场景，不是异常。
    const rescannedPaths = new Set();
    if (previousTable) {
        const staleIncluders = [];
        for (const file of successfulFiles) {
            if (!unchanged.has(file.path))
                continue;
            const targets = previousTable.includedFiles(file.path);
            if (targets.some((target) => !successfulPaths.has(target)))
                staleIncluders.push(file);
        }
        for (const file of staleIncluders) {
            throwIfAborted(signal);
            let text;
            try {
                text = String(await readFile(file.path));
            }
            catch {
                // includer 自身本轮读失败：保留旧符号与旧元数据；悬空目标在建表时被忽略，
                // 与「未变更文件不读盘」的既有行为一致，不额外降级整次构建。
                continue;
            }
            const stripped = (0, scan_1.stripSources)(text);
            parsed.set(file.path, toSymbolEntries(file, (0, scan_1.scanSource)(text, stripped)));
            parsedIncludePaths.set(file.path, (0, scan_1.scanIncludesFromStripped)(stripped, text).map((include) => include.path));
            parsedHashes.set(file.path, (0, nameindex_1.collectIdentifierHashes)(text, stripped));
            parsedContentHashes.set(file.path, (0, hash_1.hashContent64)(text));
            unchanged.delete(file.path);
            unchangedCount -= 1;
            updated += 1;
            rescannedPaths.add(file.path);
        }
    }
    // 快照元数据：未变更文件复用旧表（仅旧表、且上面的「哈希可用」判定通过才进入
    // unchanged；因此复用到的哈希/include 必然存在）；变更文件用本轮扫描结果。
    // include 只在命中「索引内文件」时建边（skipped 文件不在表里，同样丢弃）。
    const includeContext = { indexedPaths: successfulPaths, roots };
    const includesByFile = new Map();
    const nextFiles = [];
    for (const file of successfulFiles) {
        let contentHash;
        let targets;
        if (unchanged.has(file.path) && previousTable) {
            contentHash = previousTable.contentHashOf(file.path);
            targets = previousTable.includedFiles(file.path);
        }
        else {
            contentHash = parsedContentHashes.get(file.path);
            targets = (0, include_resolve_1.resolveIncludePaths)(file.path, parsedIncludePaths.get(file.path) ?? [], includeContext);
        }
        if (targets.length > 0)
            includesByFile.set(file.path, targets);
        nextFiles.push(contentHash
            ? {
                path: file.path,
                mtimeMs: file.mtimeMs,
                size: file.size,
                contentHashLo: contentHash.lo,
                contentHashHi: contentHash.hi,
            }
            : file);
    }
    // 被 I2 重扫的文件用本轮解析结果，旧条目不能与新条目同时进表。
    const entries = reused.filter((entry) => !rescannedPaths.has(entry.file));
    for (const list of parsed.values())
        entries.push(...list);
    const snapshot = createSnapshot(roots, nextFiles, entries, includesByFile);
    onProgress?.({ phase: 'save', done: 0, total: 0 });
    let snapshotBytes = 0;
    if (snapshotPath)
        snapshotBytes = await (0, store_1.saveSnapshot)(snapshotPath, snapshot);
    // 引用加速索引：直接用本次解析同时产出的标识符哈希（单遍构建，不再二次读盘）；
    // 未变更文件复用旧索引切片。
    let nameIndexBytes = 0;
    if (nameIndexPath) {
        const previousNameIndex = await (0, nameindex_1.loadNameIndex)(nameIndexPath);
        // I2 重扫的文件也算变更：它们的标识符哈希已在本轮算出，直接复用，避免再读一次盘。
        const changedPaths = new Set([
            ...pending.map((file) => file.path),
            ...rescannedPaths,
        ]);
        onProgress?.({ phase: 'index', done: 0, total: successfulFiles.length });
        const nameIndex = await (0, nameindex_1.buildNameIndex)({
            files: successfulFiles,
            previous: previousNameIndex,
            changedPaths,
            changedHashes: parsedHashes,
            readFile,
            signal,
            concurrency: Math.min(64, Math.max(8, concurrency * 8)),
            onProgress: (done, total) => onProgress?.({ phase: 'index', done, total }),
        });
        nameIndexBytes = await (0, nameindex_1.saveNameIndex)(nameIndexPath, nameIndex);
    }
    const summary = {
        files: successfulFiles.length,
        entries: entries.length,
        added,
        updated,
        removed,
        unchanged: unchangedCount,
        skipped: skipped.size,
        durationMs: Date.now() - startedAt,
        snapshotBytes,
        concurrency,
        nameIndexBytes,
    };
    return { snapshot, summary };
}
