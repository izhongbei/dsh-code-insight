"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSearchQuery = parseSearchQuery;
/** 过滤词 -> kind 列表（`@type` 展开成四类类型符号）。 */
const TOKEN_KINDS = {
    '@func': ['function'],
    '@type': ['struct', 'union', 'enum', 'typedef'],
    '@macro': ['macro'],
    '@member': ['member'],
    '@enum': ['enumConstant'],
    '@var': ['variable'],
};
function parseSearchQuery(input) {
    const words = (typeof input === 'string' ? input : '')
        .split(/\s+/)
        .filter((word) => word.length > 0);
    const kinds = [];
    const text = [];
    for (const word of words) {
        const mapped = TOKEN_KINDS[word.toLowerCase()];
        if (!mapped) {
            text.push(word);
            continue;
        }
        for (const kind of mapped) {
            if (!kinds.includes(kind)) {
                kinds.push(kind);
            }
        }
    }
    const query = text.join(' ');
    return kinds.length > 0 ? { query, kinds } : { query };
}
