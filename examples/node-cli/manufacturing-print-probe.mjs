#!/usr/bin/env node
/**
 * Manufacturing-oriented solid-kernel probe.
 *
 * Builds a simple four-wall room, compares General Fuse with a balanced true
 * Boolean union, batches four opening cuts, tessellates the final B-Rep, and
 * reports topology, timing and arena usage at several model magnitudes.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsPath = resolve(__dirname, "../../dist/occt-wasm.js");
const wasmPath = resolve(__dirname, "../../dist/occt-wasm.wasm");
const createModule = (await import(jsPath)).default;
const initStart = performance.now();
const Module = await createModule({ locateFile: (path) => (path.endsWith(".wasm") ? wasmPath : path) });
const kernel = new Module.OcctKernel();
const initMs = performance.now() - initStart;

function translatedBox(dx, dy, dz, tx, ty, tz) {
    const box = kernel.makeBox(dx, dy, dz);
    const moved = kernel.translate(box, tx, ty, tz);
    kernel.release(box);
    return moved;
}

function vector(handles) {
    const v = new Module.VectorUint32();
    for (const h of handles) v.push_back(h);
    return v;
}

function generalFuseAll(handles) {
    const v = vector(handles);
    try { return kernel.fuseAll(v); } finally { v.delete(); }
}

function cutAll(base, tools) {
    const v = vector(tools);
    try { return kernel.cutAll(base, v); } finally { v.delete(); }
}

function balancedUnion(handles) {
    if (handles.length === 0) throw new Error("balancedUnion requires at least one shape");
    if (handles.length === 1) return kernel.copy(handles[0]);
    let level = [...handles];
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            next.push(i + 1 < level.length ? kernel.fuse(level[i], level[i + 1]) : level[i]);
        }
        level = next;
    }
    return level[0];
}

function buildRoom(scale) {
    const mark = kernel.checkpoint();
    const before = kernel.getShapeCount();
    const walls = [
        translatedBox(120 * scale, 4 * scale, 30 * scale, 0, 0, 0),
        translatedBox(120 * scale, 4 * scale, 30 * scale, 0, 96 * scale, 0),
        translatedBox(4 * scale, 100 * scale, 30 * scale, 0, 0, 0),
        translatedBox(4 * scale, 100 * scale, 30 * scale, 116 * scale, 0, 0),
    ];

    const gfStart = performance.now();
    const general = generalFuseAll(walls);
    const generalMs = performance.now() - gfStart;

    const unionStart = performance.now();
    const shell = balancedUnion(walls);
    const unionMs = performance.now() - unionStart;

    const openings = [
        translatedBox(20 * scale, 10 * scale, 22 * scale, 30 * scale, -3 * scale, 0),
        translatedBox(24 * scale, 10 * scale, 10 * scale, 50 * scale, 93 * scale, 12 * scale),
        translatedBox(10 * scale, 20 * scale, 10 * scale, -3 * scale, 35 * scale, 12 * scale),
        translatedBox(10 * scale, 20 * scale, 22 * scale, 113 * scale, 60 * scale, 0),
    ];

    const cutStart = performance.now();
    const opened = cutAll(shell, openings);
    const cutMs = performance.now() - cutStart;

    const tessStart = performance.now();
    const mesh = kernel.tessellate(opened, 0.1 * scale, 0.5);
    const tessMs = performance.now() - tessStart;

    const result = {
        scale,
        generalMs,
        generalSolids: kernel.subShapeCount(general, "solid"),
        unionMs,
        unionSolids: kernel.subShapeCount(shell, "solid"),
        cutMs,
        tessMs,
        finalSolids: kernel.subShapeCount(opened, "solid"),
        finalVolume: Math.abs(kernel.getVolume(opened)),
        valid: kernel.isValid(opened),
        triangles: mesh.indexCount / 3,
        peakHandles: kernel.getShapeCount(),
        before,
    };

    mesh.delete();
    kernel.releaseSince(mark);
    result.after = kernel.getShapeCount();
    return result;
}

try {
    console.log("occt-wasm manufacturing probe");
    console.log(`WASM init: ${initMs.toFixed(1)} ms\n`);
    for (const scale of [0.1, 1, 10]) {
        const r = buildRoom(scale);
        console.log(`scale ${scale}x`);
        console.log(`  General Fuse: ${r.generalMs.toFixed(2)} ms, solids=${r.generalSolids}`);
        console.log(`  true union:   ${r.unionMs.toFixed(2)} ms, solids=${r.unionSolids}`);
        console.log(`  cutAll:       ${r.cutMs.toFixed(2)} ms`);
        console.log(`  tessellate:   ${r.tessMs.toFixed(2)} ms`);
        console.log(`  final:        solids=${r.finalSolids}, valid=${r.valid}, triangles=${r.triangles}, volume=${r.finalVolume.toFixed(3)}`);
        console.log(`  arena:        before=${r.before}, peak=${r.peakHandles}, after=${r.after}\n`);
    }
} finally {
    kernel.releaseAll();
    kernel.delete();
}
