"use strict";
/**
 * 索引规模预算：超过阈值要显式提示，避免静默吃内存。
 *
 * v5 每符号约 27 B（列式快照 10.16 MB / 206,430 符号）且 6M 硬上限只触发状态栏
 * 错误与一次性提示、不拒绝建索引；该上限是刻意保留的**告警阈值**（内存压力信号），
 * 不是硬性限制。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_INDEX_BUDGET = void 0;
exports.evaluateBudget = evaluateBudget;
exports.DEFAULT_INDEX_BUDGET = {
    maxSymbols: 3_000_000,
    maxFiles: 120_000,
    hardMaxSymbols: 6_000_000,
};
function formatNumber(value) {
    return value.toLocaleString('en-US');
}
function evaluateBudget(input) {
    const { symbols, files, budget } = input;
    const base = { symbols, files };
    const suggestions = [
        'Narrow sourceInsight.indexRoots to the modules you actually work on.',
        'Exclude duplicated kernel/vendor copies via sourceInsight.exclude (e.g. **/linux-*/**).',
    ];
    if (symbols > budget.hardMaxSymbols) {
        return {
            ...base,
            level: 'exceeded',
            message: `Index has ${formatNumber(symbols)} symbols (hard maximum ${formatNumber(budget.hardMaxSymbols)}).`,
            suggestions,
        };
    }
    if (symbols > budget.maxSymbols || files > budget.maxFiles) {
        const reason = symbols > budget.maxSymbols
            ? `${formatNumber(symbols)} symbols (budget ${formatNumber(budget.maxSymbols)})`
            : `${formatNumber(files)} files (budget ${formatNumber(budget.maxFiles)})`;
        return { ...base, level: 'warn', message: `Index is large: ${reason}.`, suggestions };
    }
    return { ...base, level: 'ok', suggestions: [] };
}
