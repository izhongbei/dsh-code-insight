"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashIdentifier = hashIdentifier;
exports.collectIdentifierHashes = collectIdentifierHashes;
exports.candidatesForName = candidatesForName;
exports.fileSlicesByPath = fileSlicesByPath;
exports.upsertFileIndex = upsertFileIndex;
exports.removeFileIndex = removeFileIndex;
exports.buildNameIndex = buildNameIndex;
exports.encodeNameIndex = encodeNameIndex;
exports.decodeNameIndex = decodeNameIndex;
exports.loadNameIndex = loadNameIndex;
exports.saveNameIndex = saveNameIndex;
exports.nameIndexDeltaPath = nameIndexDeltaPath;
exports.applyNameIndexDeltas = applyNameIndexDeltas;
exports.appendNameIndexDelta = appendNameIndexDelta;
exports.readNameIndexDeltas = readNameIndexDeltas;
exports.loadNameIndexWithDelta = loadNameIndexWithDelta;
exports.compactNameIndex = compactNameIndex;
exports.removeNameIndexDelta = removeNameIndexDelta;
exports.nameIndexDeltaBytes = nameIndexDeltaBytes;
const promises_1 = require("node:fs/promises");
const types_1 = require("../shared/types");
const scan_1 = require("./scan");
/**
 * 引用加速索引（name index）：按文件记录该文件出现过的所有 C 标识符的 32 位哈希，
 * 去重并升序存放。查找引用时只需对每个文件的切片做二分查找，命中候选文件才读盘，
 * 把「全仓库读一遍」降为「只读包含该标识符的少数文件」。
 *
 * 正确性：32 位哈希碰撞只会多出候选文件，读取后仍按词边界精确匹配，因此不会漏报，
 * 也不会产生误报；注释/字符串中的标识符在收集时就被剥离（与 findReferences 一致）。
 *
 * 文件布局（小端）：
 *   magic "SINM" (4B) | version u32 | fileCount u32 | totalHashes u32
 *   fileCount × [pathLen u32, path utf8]
 *   (fileCount+1) × offset u32
 *   totalHashes × hash u32
 */
const MAGIC = 'SINM';
const MAGIC_OFFSET = 0;
const HEADER_BYTES = 16;
const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
/** FNV-1a 32 位哈希；同一标识符在任何进程中结果一致。 */
function hashIdentifier(name) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < name.length; i++) {
        hash ^= name.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
/** 收集文本中出现过的标识符哈希（注释/字符串内容不参与），去重后升序返回。 */
function collectIdentifierHashes(text, stripped) {
    // `stripped` 可选：构建 worker 已为符号扫描剥离过一次，直接复用，避免第三次整文件剥离。
    const prepared = stripped === undefined ? (0, scan_1.stripSources)(text) : stripped;
    const seen = new Set();
    IDENTIFIER_RE.lastIndex = 0;
    let match;
    while ((match = IDENTIFIER_RE.exec(prepared)) !== null) {
        seen.add(hashIdentifier(match[0]));
    }
    const hashes = new Uint32Array(seen.size);
    let index = 0;
    for (const hash of seen)
        hashes[index++] = hash;
    hashes.sort();
    return hashes;
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
/** 在 [start, end) 的升序切片中查找 target。 */
function sliceContains(hashes, start, end, target) {
    let low = start;
    let high = end;
    while (low < high) {
        const mid = (low + high) >>> 1;
        const value = hashes[mid];
        if (value < target)
            low = mid + 1;
        else
            high = mid;
    }
    return low < end && hashes[low] === target;
}
/** 返回可能包含该标识符的文件下标（按快照 files 顺序）。 */
function candidatesForName(data, name) {
    const target = hashIdentifier(name);
    const result = [];
    const fileCount = data.filePaths.length;
    for (let file = 0; file < fileCount; file++) {
        const start = data.offsets[file];
        const end = data.offsets[file + 1];
        if (start === end)
            continue;
        if (sliceContains(data.hashes, start, end, target))
            result.push(file);
    }
    return result;
}
/** 从不可变索引中取出每个文件切片（按路径），供增量构建复用。 */
function fileSlicesByPath(data) {
    const map = new Map();
    for (let file = 0; file < data.filePaths.length; file++) {
        const start = data.offsets[file];
        const end = data.offsets[file + 1];
        map.set(data.filePaths[file], data.hashes.subarray(start, end));
    }
    return map;
}
function assemble(filePaths, slices) {
    const offsets = new Uint32Array(filePaths.length + 1);
    let total = 0;
    for (let file = 0; file < filePaths.length; file++) {
        offsets[file] = total;
        total += slices[file]?.length ?? 0;
    }
    offsets[filePaths.length] = total;
    const hashes = new Uint32Array(total);
    let cursor = 0;
    for (const slice of slices) {
        if (slice) {
            hashes.set(slice, cursor);
            cursor += slice.length;
        }
    }
    return { filePaths: [...filePaths], offsets, hashes };
}
/** 用新算出的哈希替换/追加某个文件的切片；未知路径直接追加到末尾。 */
function upsertFileIndex(data, filePath, hashes) {
    const index = data.filePaths.indexOf(filePath);
    if (index < 0) {
        const paths = [...data.filePaths, filePath];
        const slices = fileSlicesByPath(data);
        const list = paths.map((path, position) => position === paths.length - 1 ? hashes : (slices.get(path) ?? new Uint32Array(0)));
        return assemble(paths, list);
    }
    const slices = fileSlicesByPath(data);
    slices.set(filePath, hashes);
    const list = data.filePaths.map((path) => slices.get(path) ?? new Uint32Array(0));
    return assemble(data.filePaths, list);
}
/** 删除某个文件的切片（文件被删除时使用）。 */
function removeFileIndex(data, filePath) {
    const index = data.filePaths.indexOf(filePath);
    if (index < 0)
        return data;
    const paths = data.filePaths.filter((path) => path !== filePath);
    const slices = fileSlicesByPath(data);
    const list = paths.map((path) => slices.get(path) ?? new Uint32Array(0));
    return assemble(paths, list);
}
/** 构建倒排索引：变更文件重新读盘计算，未变更文件复用旧切片。 */
async function buildNameIndex(options) {
    const { files, previous, changedPaths, changedHashes, readFile, signal, onProgress } = options;
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, files.length || 1));
    throwIfAborted(signal);
    const previousSlices = previous ? fileSlicesByPath(previous) : undefined;
    const slices = new Array(files.length);
    let done = 0;
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            throwIfAborted(signal);
            const index = cursor++;
            if (index >= files.length)
                return;
            const file = files[index];
            const reusable = previousSlices?.get(file.path);
            if (reusable !== undefined && !changedPaths.has(file.path)) {
                slices[index] = reusable;
            }
            else {
                const precomputed = changedHashes?.get(file.path);
                if (precomputed !== undefined) {
                    slices[index] = precomputed;
                    done += 1;
                    onProgress?.(done, files.length);
                    continue;
                }
                let text;
                try {
                    text = await readFile(file.path);
                }
                catch {
                    text = undefined;
                }
                throwIfAborted(signal);
                slices[index] = text === undefined ? new Uint32Array(0) : collectIdentifierHashes(text);
            }
            done += 1;
            onProgress?.(done, files.length);
        }
    };
    const workers = [];
    for (let i = 0; i < concurrency; i++)
        workers.push(worker());
    await Promise.all(workers);
    throwIfAborted(signal);
    return assemble(files.map((file) => file.path), slices.map((slice) => slice ?? new Uint32Array(0)));
}
/** 编码为二进制（小端）。 */
function encodeNameIndex(data) {
    const pathBytes = data.filePaths.map((path) => Buffer.byteLength(path, 'utf8'));
    let size = HEADER_BYTES;
    for (const length of pathBytes)
        size += 4 + length;
    size += (data.filePaths.length + 1) * 4;
    size += data.hashes.length * 4;
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    buffer.write(MAGIC, offset, 'latin1');
    offset += 4;
    buffer.writeUInt32LE(types_1.NAME_INDEX_VERSION, offset);
    offset += 4;
    buffer.writeUInt32LE(data.filePaths.length, offset);
    offset += 4;
    buffer.writeUInt32LE(data.hashes.length, offset);
    offset += 4;
    for (let file = 0; file < data.filePaths.length; file++) {
        const path = data.filePaths[file];
        const length = pathBytes[file];
        buffer.writeUInt32LE(length, offset);
        offset += 4;
        buffer.write(path, offset, 'utf8');
        offset += length;
    }
    for (let file = 0; file <= data.filePaths.length; file++) {
        buffer.writeUInt32LE(data.offsets[file], offset);
        offset += 4;
    }
    for (let index = 0; index < data.hashes.length; index++) {
        buffer.writeUInt32LE(data.hashes[index], offset);
        offset += 4;
    }
    return buffer;
}
/** 解码；magic/版本/长度不合法时返回 undefined（不抛异常）。 */
function decodeNameIndex(buffer) {
    if (buffer.length < HEADER_BYTES)
        return undefined;
    if (buffer.toString('latin1', MAGIC_OFFSET, MAGIC_OFFSET + 4) !== MAGIC)
        return undefined;
    const version = buffer.readUInt32LE(4);
    if (version !== types_1.NAME_INDEX_VERSION)
        return undefined;
    const fileCount = buffer.readUInt32LE(8);
    const totalHashes = buffer.readUInt32LE(12);
    if (fileCount > 10_000_000 || totalHashes > 400_000_000)
        return undefined;
    let offset = HEADER_BYTES;
    const filePaths = new Array(fileCount);
    for (let file = 0; file < fileCount; file++) {
        if (offset + 4 > buffer.length)
            return undefined;
        const length = buffer.readUInt32LE(offset);
        offset += 4;
        if (offset + length > buffer.length)
            return undefined;
        filePaths[file] = buffer.toString('utf8', offset, offset + length);
        offset += length;
    }
    const offsetsBytes = (fileCount + 1) * 4;
    if (offset + offsetsBytes + totalHashes * 4 !== buffer.length)
        return undefined;
    const offsets = new Uint32Array(fileCount + 1);
    for (let file = 0; file <= fileCount; file++) {
        offsets[file] = buffer.readUInt32LE(offset);
        offset += 4;
    }
    if (offsets[fileCount] !== totalHashes)
        return undefined;
    for (let file = 0; file < fileCount; file++) {
        if (offsets[file] > offsets[file + 1])
            return undefined;
    }
    const hashes = new Uint32Array(totalHashes);
    for (let index = 0; index < totalHashes; index++) {
        hashes[index] = buffer.readUInt32LE(offset);
        offset += 4;
    }
    return { filePaths, offsets, hashes };
}
/** 读取索引文件；缺失或损坏返回 undefined。 */
async function loadNameIndex(file) {
    try {
        const buffer = await (0, promises_1.readFile)(file);
        return decodeNameIndex(buffer);
    }
    catch {
        return undefined;
    }
}
/** 原子写盘，返回写入字节数。 */
async function saveNameIndex(file, data) {
    const buffer = encodeNameIndex(data);
    const temporary = `${file}.tmp`;
    try {
        await (0, promises_1.writeFile)(temporary, buffer);
        await (0, promises_1.rename)(temporary, file);
    }
    catch (error) {
        await (0, promises_1.unlink)(temporary).catch(() => undefined);
        throw error;
    }
    return buffer.length;
}
const DELTA_MAGIC = 'SIND';
const DELTA_VERSION = 1;
const DELTA_HEADER_BYTES = 8;
const DELTA_KIND_SET = 0;
const DELTA_KIND_REMOVE = 1;
/** 引用索引对应的 delta 文件路径。 */
function nameIndexDeltaPath(basePath) {
    return `${basePath}.delta`;
}
function encodeDeltaRecord(entry) {
    const pathBytes = Buffer.byteLength(entry.path, 'utf8');
    const record = Buffer.allocUnsafe(1 + 4 + pathBytes + 4 + entry.hashes.length * 4);
    let offset = 0;
    record.writeUInt8(entry.kind === 'set' ? DELTA_KIND_SET : DELTA_KIND_REMOVE, offset);
    offset += 1;
    record.writeUInt32LE(pathBytes, offset);
    offset += 4;
    record.write(entry.path, offset, 'utf8');
    offset += pathBytes;
    record.writeUInt32LE(entry.hashes.length, offset);
    offset += 4;
    for (let i = 0; i < entry.hashes.length; i++) {
        record.writeUInt32LE(entry.hashes[i], offset);
        offset += 4;
    }
    return record;
}
function emptyNameIndex() {
    return { filePaths: [], offsets: new Uint32Array(1), hashes: new Uint32Array(0) };
}
/** 逐条应用 delta；base 为空时也能得出新索引。 */
function applyNameIndexDeltas(base, entries) {
    if (entries.length === 0)
        return base;
    let data = base;
    for (const entry of entries) {
        if (entry.kind === 'remove') {
            if (data !== undefined)
                data = removeFileIndex(data, entry.path);
            continue;
        }
        data = upsertFileIndex(data ?? emptyNameIndex(), entry.path, entry.hashes);
    }
    return data;
}
/** 把一条增量记录追加到 delta 文件（O(记录大小)，不重写整个索引）。返回追加字节数。 */
async function appendNameIndexDelta(deltaPath, entry) {
    const record = encodeDeltaRecord(entry);
    try {
        // 首次使用或文件为空时写入 header
        let existing = 0;
        try {
            const stat = await (0, promises_1.stat)(deltaPath);
            existing = stat.size;
        }
        catch {
            existing = 0;
        }
        let written = record.length;
        if (existing === 0) {
            const header = Buffer.alloc(DELTA_HEADER_BYTES);
            header.write(DELTA_MAGIC, 0, 'latin1');
            header.writeUInt32LE(DELTA_VERSION, 4);
            await (0, promises_1.appendFile)(deltaPath, header);
            written += DELTA_HEADER_BYTES;
        }
        await (0, promises_1.appendFile)(deltaPath, record);
        return written;
    }
    catch (error) {
        throw error;
    }
}
/** 读取 delta 文件；magic/版本不符返回 []，尾部未写完的记录被忽略。 */
async function readNameIndexDeltas(deltaPath) {
    let buffer;
    try {
        buffer = await (0, promises_1.readFile)(deltaPath);
    }
    catch {
        return [];
    }
    if (buffer.length < DELTA_HEADER_BYTES)
        return [];
    if (buffer.toString('latin1', 0, 4) !== DELTA_MAGIC)
        return [];
    if (buffer.readUInt32LE(4) !== DELTA_VERSION)
        return [];
    const entries = [];
    let offset = DELTA_HEADER_BYTES;
    while (offset < buffer.length) {
        if (offset + 5 > buffer.length)
            break;
        const kindCode = buffer.readUInt8(offset);
        offset += 1;
        const pathLength = buffer.readUInt32LE(offset);
        offset += 4;
        if (offset + pathLength + 4 > buffer.length)
            break;
        const path = buffer.toString('utf8', offset, offset + pathLength);
        offset += pathLength;
        const hashCount = buffer.readUInt32LE(offset);
        offset += 4;
        if (offset + hashCount * 4 > buffer.length)
            break;
        const hashes = new Uint32Array(hashCount);
        for (let i = 0; i < hashCount; i++) {
            hashes[i] = buffer.readUInt32LE(offset);
            offset += 4;
        }
        entries.push({ kind: kindCode === DELTA_KIND_REMOVE ? 'remove' : 'set', path, hashes });
    }
    return entries;
}
/** 加载 base + delta 合并后的引用索引。 */
async function loadNameIndexWithDelta(basePath) {
    const base = await loadNameIndex(basePath);
    const deltas = await readNameIndexDeltas(nameIndexDeltaPath(basePath));
    return applyNameIndexDeltas(base, deltas);
}
/** 合并写回 base 并清空 delta（构建完成、或 delta 超过阈值时调用）。 */
async function compactNameIndex(basePath, data) {
    const baseBytes = await saveNameIndex(basePath, data);
    const deltaPath = nameIndexDeltaPath(basePath);
    let deltaTruncated = false;
    try {
        await (0, promises_1.truncate)(deltaPath, 0);
        deltaTruncated = true;
    }
    catch {
        // delta 不存在：无需处理
    }
    return { baseBytes, deltaTruncated };
}
/** 删除 delta 文件（清缓存 / 全量重建后）。 */
async function removeNameIndexDelta(deltaPath) {
    try {
        await (0, promises_1.unlink)(deltaPath);
    }
    catch {
        // ignore
    }
}
/** delta 文件大小（用于判断是否该 compaction）。 */
async function nameIndexDeltaBytes(deltaPath) {
    try {
        const stat = await (0, promises_1.stat)(deltaPath);
        return stat.size;
    }
    catch {
        return 0;
    }
}
