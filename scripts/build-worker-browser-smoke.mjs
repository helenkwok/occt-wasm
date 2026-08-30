#!/usr/bin/env node

import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build as viteBuild } from "vite";

const root = resolve(import.meta.dirname, "../test/browser/worker-app");
const outDir = resolve(import.meta.dirname, "../test/browser/worker-dist");

async function walk(dir) {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (entry.isFile()) found.push(resolve(entry.parentPath, entry.name));
    }
    return found;
}

await rm(outDir, { recursive: true, force: true });

await viteBuild({
    root,
    base: "./",
    logLevel: "error",
    build: {
        outDir,
        emptyOutDir: true,
        target: "esnext",
        minify: false,
        assetsInlineLimit: 0,
    },
});

const emitted = await walk(outDir);
if (!emitted.some((file) => file.endsWith(".wasm"))) {
    throw new Error("worker browser fixture emitted no .wasm asset");
}
if (!emitted.some((file) => /worker/i.test(file) && /\.(m?js)$/.test(file))) {
    throw new Error("worker browser fixture emitted no worker JavaScript chunk");
}

console.log(`worker browser fixture: ${emitted.length} emitted files`);
