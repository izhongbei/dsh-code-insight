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
exports.resolveIncludePath = resolveIncludePath;
exports.resolveIncludePaths = resolveIncludePaths;
const path = __importStar(require("node:path"));
/** Windows 盘符绝对路径（`C:/x`）；posix 规则只把前导 `/` 当绝对路径。 */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//;
/** 反斜杠归一为 `/`（Windows 风格 include / 路径与平台无关地比较）。 */
function toPosix(value) {
    return value.replace(/\\/g, '/');
}
/**
 * include 文本本身是否绝对路径。
 *
 * 绝对 include（`/etc/passwd`、`C:/...`、`\\server\share`）在真实工程里表示系统/编译器
 * 搜索路径下的文件，绝不等价于工作区里的同名相对路径。必须在构造候选**之前**拒绝：
 * 否则 `src/a.c` 里的 `/etc/passwd` 会被 dir 候选归一成 `src/etc/passwd`，甚至在根目录
 * 文件里归一成 `etc/passwd`，从而对工作区里恰好存在的 `etc/passwd` 造出假边。
 */
function isAbsoluteInclude(include) {
    return path.posix.isAbsolute(include) || WINDOWS_ABSOLUTE.test(include);
}
/**
 * 归一 indexRoot，规则与 walk 的 `toRelativeRoot` 对齐（walk 无 workspaceRoot 可相对化时
 * 的等价部分）：`\`→`/`、折叠重复 `/`、去前导 `./`、去尾部 `/`。
 * 绝对 root 保持绝对（拼出的候选会被 isWorkspaceRelative 拒绝，不会误命中工作区路径）。
 */
function normalizeRoot(root) {
    let rel = toPosix(root).trim().replace(/\/{2,}/g, '/');
    while (rel.startsWith('./'))
        rel = rel.slice(2);
    return rel.replace(/\/+$/, '');
}
/**
 * 只有 workspace 相对、非 `.`/`..`/绝对路径的候选才可能是索引内文件。
 *
 * 候选已经过 `toPosix`（`\`→`/`）与 `path.posix.normalize`，所以这里还要显式拒绝
 * 「posix 规则看不出来」的 Windows 盘符形式：`C:/x` 不是 posix 绝对路径，若照收会去
 * 匹配索引里恰好叫 `C:` 的目录。
 *
 * UNC 不需要单独判断：`path.posix.normalize('//server/share/x')` 会把前导双斜杠折叠成
 * `/server/share/x`，随后由 `path.posix.isAbsolute` 拒绝；include 文本本身是 UNC 时更早
 * 由 `isAbsoluteInclude` 拒绝。
 */
function isWorkspaceRelative(candidate) {
    return (candidate !== '' &&
        candidate !== '.' &&
        candidate !== '..' &&
        !candidate.startsWith('../') &&
        !path.posix.isAbsolute(candidate) &&
        !WINDOWS_ABSOLUTE.test(candidate));
}
/**
 * 解析单个 include；返回命中的索引内文件路径，未命中返回 undefined。
 */
function resolveIncludePath(fromFile, includePath, context) {
    const include = toPosix(includePath).trim();
    if (include === '' || isAbsoluteInclude(include))
        return undefined;
    const from = toPosix(fromFile);
    const dir = path.posix.dirname(from);
    // 候选去重（例如 roots 里的 `.` 与「原样」候选重复），顺序即优先级。
    const seen = new Set();
    const consider = (candidate) => {
        const normalized = path.posix.normalize(candidate);
        if (seen.has(normalized))
            return undefined;
        seen.add(normalized);
        if (!isWorkspaceRelative(normalized))
            return undefined;
        return context.indexedPaths.has(normalized) ? normalized : undefined;
    };
    const relative = consider(path.posix.join(dir, include));
    if (relative !== undefined)
        return relative;
    const asIs = consider(include);
    if (asIs !== undefined)
        return asIs;
    for (const root of context.roots) {
        const rooted = consider(path.posix.join(normalizeRoot(root), include));
        if (rooted !== undefined)
            return rooted;
    }
    return undefined;
}
/**
 * 批量解析一个文件里的 include 列表：保持首次出现顺序、按目标去重、丢弃未命中。
 * （同一目标的重复 `#include` 只会增加无意义的边。）
 */
function resolveIncludePaths(fromFile, includePaths, context) {
    const result = [];
    const seen = new Set();
    for (const includePath of includePaths) {
        const target = resolveIncludePath(fromFile, includePath, context);
        if (target === undefined || seen.has(target))
            continue;
        seen.add(target);
        result.push(target);
    }
    return result;
}
