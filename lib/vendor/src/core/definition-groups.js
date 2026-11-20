"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.groupDefinitions = groupDefinitions;
exports.formatDefinitionLabel = formatDefinitionLabel;
const rank_definitions_1 = require("./rank-definitions");
/** 代表副本是否对当前源文件可见（同一文件或可达 include）。 */
function isIncluded(context, file) {
    const sourceFile = context.sourceFile;
    if (sourceFile === undefined)
        return false;
    if (file === sourceFile)
        return true;
    if (context.table === undefined)
        return false;
    return context.table.isReachable(sourceFile, file);
}
/**
 * 分组键：内容哈希 + 符号身份；没有哈希时按文件路径 + 符号身份。
 * 哈希的 lo/hi 与 kind 都是无 `:` 的整数/枚举字面量，两段各自无歧义。
 */
function groupKey(entry, table) {
    const hash = table?.contentHashOf(entry.file);
    const identity = `${entry.name}:${entry.kind}`;
    return hash ? `${hash.lo}:${hash.hi}:${identity}` : `file:${entry.file}:${identity}`;
}
/** 折叠结果 -> 对外 DefinitionGroup（代表 = 组内排名最高者）。 */
function toDefinitionGroup(context, pending) {
    const representative = pending.entries[0];
    return {
        entries: pending.entries,
        representative,
        included: isIncluded(context, representative.file),
        conditional: Boolean(representative.condition),
        copies: new Set(pending.entries.map((entry) => entry.file)).size,
    };
}
/**
 * 排序 + 按内容哈希/符号身份分组。组顺序 = 代表副本的排名顺序。
 *
 * 同一文件的两个条目绝不进入同一组（即使内容哈希与符号身份都相同）：`copies` 语义是
 * 「内容相同的不同文件数」，同一文件内的重复条目不是副本，不能虚增计数。
 */
function groupDefinitions(entries, context) {
    const ranked = (0, rank_definitions_1.rankDefinitions)(entries, context);
    // 同一分组键下可能有多个组（同一文件的退化重复只靠 guard 分开），用桶做查找。
    const buckets = new Map();
    // 组在首次创建时按 rank 递增追加，因此 groups 的顺序就是代表副本的排名顺序。
    const groups = [];
    for (const entry of ranked) {
        const key = groupKey(entry, context.table);
        let bucket = buckets.get(key);
        if (bucket === undefined) {
            bucket = [];
            buckets.set(key, bucket);
        }
        // guard：选择第一个「尚未包含该文件」的组；没有则新开一组。
        let target = bucket.find((group) => group.entries.every((item) => item.file !== entry.file));
        if (target === undefined) {
            target = { entries: [] };
            bucket.push(target);
            groups.push(target);
        }
        target.entries.push(entry);
    }
    return groups.map((group) => toDefinitionGroup(context, group));
}
/**
 * core 层纯文本标签（英文）：`name  ·  included  ·  3 copies  ·  #ifdef FOO`。
 * 保留为稳定的纯函数/测试基准；vscode 层在 quickpick.ts 用 l10n 组装同语义的本地化标签，
 * 因此本地化文案变化不会影响 core 的测试与分组/排序语义。
 * 缺省部分直接省略（唯一且无条件时只剩名字）；空条件文本视为没有条件，不产生分隔符。
 */
function formatDefinitionLabel(group) {
    const parts = [group.representative.name];
    if (group.included)
        parts.push('included');
    if (group.copies > 1)
        parts.push(`${group.copies} copies`);
    if (group.conditional) {
        const condition = group.representative.condition;
        if (condition === undefined) {
            // 防御外部构造的 group：conditional 为 true 但条件文本缺失
            parts.push('conditional');
        }
        else if (condition !== '') {
            parts.push(condition);
        }
    }
    return parts.join('  ·  ');
}
