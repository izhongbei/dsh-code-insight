"use strict";
/**
 * 跨层唯一数据契约：core（无 vscode 依赖）与 vscode 层都只依赖本文件。
 * 所有结构只读，避免一侧意外修改另一侧状态。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYMBOL_KIND_ORDER = exports.DEFAULT_EXCLUDE = exports.INDEXED_EXTENSIONS = exports.NAME_INDEX_VERSION = exports.SNAPSHOT_VERSION = void 0;
exports.SNAPSHOT_VERSION = 5;
exports.NAME_INDEX_VERSION = 1;
exports.INDEXED_EXTENSIONS = ['.c', '.h', '.cc', '.cpp', '.hpp', '.hh', '.inl'];
exports.DEFAULT_EXCLUDE = [
    '**/.git/**',
    '**/build/**',
    '**/tmp/**',
    '**/node_modules/**',
];
/**
 * 搜索排序：函数/类型/声明/宏 在前，成员/枚举常量/变量 在后（v5）。
 *
 * 既有 kind 的相对顺序锁定为 0.8.0（802f981）的 `function/struct/union/enum/typedef/
 * declaration/macro`，v5 新增的三类追加在尾部；不要因为文档措辞调整既有 kind 的序号。
 */
exports.SYMBOL_KIND_ORDER = {
    function: 0,
    struct: 1,
    union: 2,
    enum: 3,
    typedef: 4,
    declaration: 5,
    macro: 6,
    member: 7,
    enumConstant: 8,
    variable: 9,
};
