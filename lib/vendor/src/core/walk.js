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
exports.isIndexableFile = isIndexableFile;
exports.walkFiles = walkFiles;
exports.isAbortError = isAbortError;
const fsp = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const types_1 = require("../shared/types");
const exclude_1 = require("./exclude");
const INDEXABLE_EXTENSIONS = new Set(types_1.INDEXED_EXTENSIONS);
const PROGRESS_EVERY = 500;
function isAbortError(err) {
    return err instanceof Error && err.name === 'AbortError';
}
function makeAbortError() {
    const err = new Error('aborted');
    err.name = 'AbortError';
    return err;
}
/** 只接受契约里列出的 C/C++ 扩展名（大小写敏感，`a.C` 不算）。 */
function isIndexableFile(filePath) {
    return INDEXABLE_EXTENSIONS.has(path.extname(filePath));
}
/** roots 里的路径（可能是绝对路径、`./x`）→ 相对 workspaceRoot 的 posix 路径。 */
function toRelativeRoot(workspaceRoot, root) {
    let rel = root;
    if (path.isAbsolute(rel))
        rel = path.relative(workspaceRoot, rel);
    rel = rel.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    while (rel.startsWith('./'))
        rel = rel.slice(2);
    if (rel === '.')
        rel = '';
    return rel.replace(/\/+$/, '');
}
/**
 * 遍历 roots，返回按字典序排序的 C/C++ 文件清单。
 *
 * - `exclude` 相对 workspace 根匹配；目录用「尾部带 `/`」的路径参与匹配，便于剪枝；
 * - 目录名 `.git` 永远跳过；`followSymlinks=false` 时所有符号链接跳过；
 * - 超过 `maxFileSizeKB` 的文件静默跳过（不进入返回值）；
 * - 每 500 个文件回调一次进度，结束时补一次收尾进度；
 * - `signal.aborted` 时抛 `AbortError`。
 */
async function walkFiles(options) {
    const { workspaceRoot, roots, exclude, maxFileSizeKB, followSymlinks, signal, onProgress } = options;
    const isExcluded = (0, exclude_1.compileExclude)(exclude);
    const maxBytes = maxFileSizeKB > 0 ? maxFileSizeKB * 1024 : Number.POSITIVE_INFINITY;
    const results = [];
    const seen = new Set();
    const visitedDirs = new Set();
    let done = 0;
    const checkAbort = () => {
        if (signal?.aborted)
            throw makeAbortError();
    };
    const report = (currentFile) => {
        onProgress?.({ phase: 'walk', done, total: 0, currentFile });
    };
    const addFile = (relPath, stat) => {
        if (seen.has(relPath))
            return;
        seen.add(relPath);
        results.push({ path: relPath, mtimeMs: stat.mtimeMs, size: stat.size });
        done += 1;
        if (done % PROGRESS_EVERY === 0)
            report(relPath);
    };
    const walkDir = async (absDir, relDir) => {
        checkAbort();
        let entries;
        try {
            entries = await fsp.readdir(absDir, { withFileTypes: true });
        }
        catch {
            return; // 目录不可读/已消失：跳过而不是中断整次构建
        }
        if (followSymlinks) {
            try {
                const real = await fsp.realpath(absDir);
                if (visitedDirs.has(real))
                    return; // 符号链接目录成环保护
                visitedDirs.add(real);
            }
            catch {
                return;
            }
        }
        for (const entry of entries) {
            checkAbort();
            const name = entry.name;
            if (name === '.git')
                continue;
            const childAbs = path.join(absDir, name);
            const childRel = relDir ? `${relDir}/${name}` : name;
            const isLink = entry.isSymbolicLink();
            if (isLink && !followSymlinks)
                continue;
            let isDir = entry.isDirectory();
            let isFile = entry.isFile();
            if (isLink && !isDir && !isFile) {
                try {
                    const stat = await fsp.stat(childAbs);
                    isDir = stat.isDirectory();
                    isFile = stat.isFile();
                }
                catch {
                    continue;
                }
            }
            if (isDir) {
                if (isExcluded(`${childRel}/`))
                    continue;
                await walkDir(childAbs, childRel);
            }
            else if (isFile) {
                if (!isIndexableFile(name))
                    continue;
                if (isExcluded(childRel))
                    continue;
                let stat;
                try {
                    stat = await fsp.stat(childAbs);
                }
                catch {
                    continue;
                }
                if (!stat.isFile() || stat.size > maxBytes)
                    continue;
                addFile(childRel, stat);
            }
        }
    };
    for (const root of roots) {
        checkAbort();
        const relRoot = toRelativeRoot(workspaceRoot, root);
        const absRoot = relRoot ? path.join(workspaceRoot, relRoot) : workspaceRoot;
        await walkDir(absRoot, relRoot);
    }
    results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (done > 0 && done % PROGRESS_EVERY !== 0)
        report();
    checkAbort();
    return results;
}
