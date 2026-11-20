"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashContent64 = hashContent64;
const FNV32_PRIME = 16777619;
const MIX_PRIME = 2654435761;
/** 对 UTF-16 码元逐字符混合，返回两个 32 位无符号分量。 */
function hashContent64(text) {
    let lo = 0x811c9dc5;
    let hi = 0x9e3779b9;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        lo = Math.imul(lo ^ code, FNV32_PRIME) >>> 0;
        hi = Math.imul(hi ^ code, MIX_PRIME) >>> 0;
    }
    return { lo, hi };
}
