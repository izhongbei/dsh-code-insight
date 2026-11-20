"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchSymbols = searchSymbols;
exports.findByName = findByName;
exports.entriesInFile = entriesInFile;
const symbol_order_1 = require("./symbol-order");
/**
 * 符号搜索 / 按名查找 / 按文件查询。
 *
 * 排序键（严格按计划 Task 5）：
 *   权重：完全相等(0) > 前缀(1) > 子词/驼峰(2) > 普通子串(3)
 *   同权重：kind 顺序（function→declaration→macro）、名字长度、名字、文件、行
 * 全表线性过滤 + 只对命中项排序：1M 符号表下通常 <100ms。
 */
const DEFAULT_SEARCH_LIMIT = 200;
/** 0 = 完全相等，1 = 前缀，2 = 子词/驼峰，3 = 普通子串；找不到返回 undefined。 */
function searchSymbols(table, query, options = {}) {
    const trimmed = query.trim();
    if (trimmed.length === 0)
        return [];
    const lowerQuery = trimmed.toLowerCase();
    const limit = Math.max(0, options.limit ?? DEFAULT_SEARCH_LIMIT);
    if (limit === 0)
        return [];
    const kinds = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : undefined;
    const matches = [];
    const candidateCap = limit * 40;
    table.forEachName((name) => {
        if (matches.length >= candidateCap)
            return;
        const weight = nameWeight(name, lowerQuery);
        if (weight < 0)
            return;
        for (const entry of table.findByName(name)) {
            if (kinds && !kinds.has(entry.kind))
                continue;
            matches.push({ entry, weight });
            if (matches.length >= candidateCap)
                break;
        }
    });
    matches.sort((a, b) => {
        if (a.weight !== b.weight)
            return a.weight - b.weight;
        const kindCompare = (0, symbol_order_1.compareSymbolEntries)(a.entry, b.entry);
        if (kindCompare !== 0)
            return kindCompare;
        return (0, symbol_order_1.compareStrings)(a.entry.name, b.entry.name);
    });
    return matches.slice(0, limit).map((item) => item.entry);
}
/** 0=完全相等，1=前缀，2=子词/驼峰，3=子串，-1=不匹配。 */
function nameWeight(name, lowerQuery) {
    const lowerName = name.toLowerCase();
    if (lowerName === lowerQuery)
        return 0;
    if (lowerName.startsWith(lowerQuery))
        return 1;
    // 先做便宜的 includes 预筛，命中后才计算子词/驼峰（1.5M 符号下差别明显）
    if (!lowerName.includes(lowerQuery))
        return -1;
    if (isSubwordMatch(name, lowerName, lowerQuery))
        return 2;
    return 3;
}
function isSubwordMatch(name, lowerName, lowerQuery) {
    const parts = lowerName.split(/[^a-z0-9]+/).filter((part) => part.length > 0);
    if (parts.some((part) => part.startsWith(lowerQuery)))
        return true;
    const camel = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return camel.split(/[^a-z0-9]+/).some((part) => part.startsWith(lowerQuery));
}
function findByName(table, name) {
    if (name.length === 0)
        return [];
    return table.findByName(name).sort(symbol_order_1.compareSymbolEntries);
}
function entriesInFile(table, file) {
    if (file.length === 0)
        return [];
    return table.entriesInFile(file);
}
