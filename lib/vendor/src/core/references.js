"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.snapshotIdentity = snapshotIdentity;
exports.clearReferenceCache = clearReferenceCache;
exports.abortError = abortError;
exports.throwIfAborted = throwIfAborted;
exports.findReferences = findReferences;
const nameindex_1 = require("./nameindex");
const signature_1 = require("./signature");
const DEFAULT_CONCURRENCY = 8;
const PROGRESS_INTERVAL = 500;
const RESULT_CACHE_LIMIT = 64;
/**
 * 快照身份：同一 IndexSnapshot 对象复用同一缓存键；重建出的新对象即使
 * builtAt 相同（同一毫秒内）也不会命中旧缓存。
 */
const snapshotIds = new WeakMap();
let nextSnapshotId = 0;
function snapshotIdentity(snapshot) {
    let id = snapshotIds.get(snapshot);
    if (id === undefined) {
        id = ++nextSnapshotId;
        snapshotIds.set(snapshot, id);
    }
    return id;
}
/** 结果缓存：key = generation|snapshotId|includeDeclaration|name → 已排序结果。 */
const resultCache = new Map();
/**
 * 缓存代际：clearReferenceCache() 每次 +1。
 *
 * 清空时把代际写进 key，清空前的旧条目从此不可命中；同时在查询开始时捕获代际、
 * 写回前再校验一次，避免「慢读盘的在途查询」把清空前的旧结果重新写进缓存
 * （overlay 原地修改 + 清缓存与查询并发时的写回竞态）。
 */
let cacheGeneration = 0;
/** 清空引用结果缓存（测试与压测用于对比冷启动耗时）。 */
function clearReferenceCache() {
    cacheGeneration += 1;
    resultCache.clear();
}
function abortError() {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw abortError();
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function makePreview(line) {
    return line.trim().slice(0, 200);
}
function cacheGet(key) {
    return resultCache.get(key);
}
function cacheSet(key, hits) {
    resultCache.set(key, hits);
    while (resultCache.size > RESULT_CACHE_LIMIT) {
        const oldest = resultCache.keys().next();
        if (oldest.done)
            break;
        resultCache.delete(oldest.value);
    }
}
/** 同 file 内同名符号（定义/声明/宏）的行号集合，includeDeclaration=false 时排除。 */
function declarationLinesByName(snapshot, name) {
    const result = new Map();
    for (const entry of snapshot.findByName(name)) {
        if (entry.name !== name)
            continue;
        let lines = result.get(entry.file);
        if (lines === undefined) {
            lines = new Set();
            result.set(entry.file, lines);
        }
        lines.add(entry.line);
    }
    return result;
}
function raceAbort(promise, signal) {
    if (signal.aborted) {
        promise.catch(() => undefined);
        return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}
async function findReferences(snapshot, name, readFile, options = {}) {
    throwIfAborted(options.signal);
    if (name.length === 0)
        return [];
    const includeDeclaration = options.includeDeclaration === true;
    // 捕获查询开始时的代际：key 含代际（清空前条目不可达），写回前再校验（防旧结果写回）。
    const generation = cacheGeneration;
    const cacheKey = `${generation}|${snapshotIdentity(snapshot)}|${includeDeclaration ? 1 : 0}|${name}`;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined)
        return [...cached];
    const excludedLines = includeDeclaration
        ? undefined
        : declarationLinesByName(snapshot, name);
    // 有倒排索引时：先用哈希索引得到候选文件，未命中直接返回空（索引覆盖所有标识符，
    // 注释/字符串中的文本本来就不算引用），命中则只读这些文件。
    let files = snapshot.files;
    if (options.nameIndex) {
        const nameIndex = options.nameIndex;
        const candidateIndexes = (0, nameindex_1.candidatesForName)(nameIndex, name);
        if (candidateIndexes.length === 0) {
            if (generation === cacheGeneration)
                cacheSet(cacheKey, []);
            return [];
        }
        const byPath = new Map(snapshot.files.map((record) => [record.path, record]));
        const narrowed = [];
        for (const candidate of candidateIndexes) {
            const path = nameIndex.filePaths[candidate];
            if (path === undefined)
                continue;
            const record = byPath.get(path);
            if (record !== undefined)
                narrowed.push(record);
        }
        files = narrowed;
    }
    const total = files.length;
    const concurrency = Math.min(DEFAULT_CONCURRENCY, Math.max(total, 1));
    const hits = [];
    let nextIndex = 0;
    let done = 0;
    const reportProgress = (force) => {
        if (options.onProgress === undefined)
            return;
        if (!force && done % PROGRESS_INTERVAL !== 0)
            return;
        options.onProgress(done, total);
    };
    const worker = async () => {
        while (true) {
            throwIfAborted(options.signal);
            const index = nextIndex++;
            if (index >= total)
                return;
            const file = files[index].path;
            let text;
            try {
                text = await readFile(file);
            }
            catch {
                text = undefined;
            }
            throwIfAborted(options.signal);
            done++;
            reportProgress(done === total);
            if (text === undefined)
                continue;
            // 1) 内容预筛：绝大多数文件在这里被跳过，不进入词法剥离。
            if (text.indexOf(name) < 0)
                continue;
            // 2) 词法剥离（注释/字符串内容变空格，行列号与原文一致）。
            const stripped = (0, signature_1.stripSources)(text);
            const originalLines = text.split('\n');
            const strippedLines = stripped.split('\n');
            const excluded = excludedLines?.get(file);
            const boundary = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, 'g');
            for (let line = 0; line < strippedLines.length; line++) {
                if (excluded !== undefined && excluded.has(line))
                    continue;
                const lineText = strippedLines[line];
                boundary.lastIndex = 0;
                let match = boundary.exec(lineText);
                while (match !== null) {
                    hits.push({
                        file,
                        line,
                        column: match.index,
                        preview: makePreview(originalLines[line] ?? ''),
                    });
                    match = boundary.exec(lineText);
                }
            }
        }
    };
    const workers = [];
    for (let i = 0; i < concurrency; i++)
        workers.push(worker());
    const all = Promise.all(workers);
    if (options.signal !== undefined) {
        await raceAbort(all, options.signal);
    }
    else {
        await all;
    }
    hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || a.column - b.column);
    // 读盘期间可能已 clearReferenceCache()：代际变化时旧结果不能写回，否则下一次查询
    // 会命中「清空之后」的缓存键却拿到清空前的旧结果。
    if (generation === cacheGeneration)
        cacheSet(cacheKey, hits);
    return [...hits];
}
