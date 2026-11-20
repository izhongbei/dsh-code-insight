"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_worker_threads_1 = require("node:worker_threads");
const hash_1 = require("./hash");
const nameindex_1 = require("./nameindex");
const scan_1 = require("./scan");
if (node_worker_threads_1.parentPort) {
    const port = node_worker_threads_1.parentPort;
    port.on('message', (message) => {
        const response = { id: message.id };
        try {
            const text = message.text;
            const stripped = (0, scan_1.stripSources)(text);
            response.symbols = (0, scan_1.scanSource)(text, stripped);
            response.hashes = (0, nameindex_1.collectIdentifierHashes)(text, stripped);
            response.contentHash = (0, hash_1.hashContent64)(text);
            // worker 不返回条件时间线，只从同一份 stripped 取 include，避免多余的第二次条件扫描
            response.includes = (0, scan_1.scanIncludesFromStripped)(stripped, text);
        }
        catch (err) {
            response.error = err instanceof Error ? err.message : String(err);
        }
        port.postMessage(response);
    });
}
