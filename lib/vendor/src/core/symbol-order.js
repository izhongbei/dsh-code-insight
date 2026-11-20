"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareStrings = compareStrings;
exports.compareSymbolEntries = compareSymbolEntries;
const types_1 = require("../shared/types");
function compareStrings(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
/** 与 v1 行为一致：kind 顺序 → 名字长度 → 名字 → 文件 → 行 → 列 → 结束行。 */
function compareSymbolEntries(a, b) {
    const kindOrder = types_1.SYMBOL_KIND_ORDER[a.kind] - types_1.SYMBOL_KIND_ORDER[b.kind];
    if (kindOrder !== 0)
        return kindOrder;
    if (a.name.length !== b.name.length)
        return a.name.length - b.name.length;
    if (a.name !== b.name)
        return compareStrings(a.name, b.name);
    if (a.file !== b.file)
        return compareStrings(a.file, b.file);
    if (a.line !== b.line)
        return a.line - b.line;
    if (a.column !== b.column)
        return a.column - b.column;
    return a.endLine - b.endLine;
}
