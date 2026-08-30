#!/usr/bin/env node
/**
 * BIMBlock 3D-print solid-kernel probe.
 *
 * Builds a small room from architectural wall solids, fuses them, cuts four
 * openings in one batch, and tessellates the final B-Rep. Geometry is Z-up and
 * expressed in millimetres, matching the intended BIMBlock manufacturing path.
 *
 * Build occt-wasm first, then run:
 *   node examples/node-cli/bimblock-print-probe.mjs
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsPath = resolve(__dirname, "../../dist/occt-wasm.js");
const wasmPath = resolve(__dirname, "../../dist/occt-wasm.wasm");

const initStart = performance.now();
const createModule = (await import(jsPath)).default;
const Module = await createModule({
    locateFile: (path) => (path.endsWith(".wasm") ? wasmPath : path),
});
const kernel = new Module.OcctKernel();
const initMs = performance.now() - initStart;

function translatedBox(dx, dy, dz, tx, ty, tz) {
    const box = kernel.makeBox(dx, dy, dz);
    const moved = kernel.translate(box, tx, ty, tz);
    kernel.release(box);
    return moved;
}

function handleVector(handles) {
    const vector = new Module.VectorUint32();
    for (const handle of handles) vector.push_back(handle);
    return vector;
}

function fuseAll(handles) {
    const vector = handleVector(handles);
    try {
        return kernel.fuseAll(vector);
    } finally {
        vector.delete();
    }
}

function cutAll(base, tools) {
    const vector = handleVector(tools);
    try {
        return kernel.cutAll(base, vector);
    } finally {
        vector.delete();
    }
}

function buildRoom(scale) {
    const walls = [
        translatedBox(120 * scale, 4 * scale, 30 * scale, 0, 0, 0),
        translatedBox(120 * scale, 4 * scale, 30 * scale, 0, 96 * scale, 0),
        translatedBox(4 * scale, 100 * scale, 30 * scale, 0, 0, 0),
        translatedBox(4 * scale, 100 * scale, 30 * scale, 116 * scale, 0, 0),
    ];

    const fuseStart = performance.now();
    const shell = fuseAll(walls);
    const fuseMs = performance.now() - fuseStart;

    const openings = [
        // south wall door
        translatedBox(20 * scale, 10 * scale, 22 * scale, 30 * scale, -3 * scale, 0),
        // north wall window
        translatedBox(24 * scale, 10 * scale, 10 * scale, 50 * scale, 93 * scale, 12 * scale),
        // west wall window
        translatedBox(10 * scale, 20 * scale, 10 * scale, -3 * scale, 35 * scale, 12 * scale),
        // east wall door
        translatedBox(10 * scale, 20 * scale, 22 * scale, 113 * scale, 60 * scale, 0),
    ];

    const cutStart = performance.now();
    const opened = cutAll(shell, openings);
    const cutMs = performance.now() - cutStart;

    const tessStart = performance.now();
    const mesh = kernel.tessellate(opened, 0.1, 0.5);
    const tessellateMs = performance.now() - tessStart;

    const solids = kernel.getSubShapes(opened, "solid");
    const solidCount = solids.size();
    for (let i = 0; i < solids.size(); i++) kernel.release(solids.get(i));
    solids.delete();

    const result = {
        scale,
        fuseMs,
        cutMs,
        tessellateMs,
        totalKernelMs: fuseMs + cutMs + tessellateMs,
        volume: Math.abs(kernel.getVolume(opened)),
        solidCount,
        triangles: mesh.indexCount / 3,
    };

    mesh.delete();
    kernel.releaseAll();
    return result;
}

try {
    console.log("BIMBlock occt-wasm print probe");
    console.log(`WASM init: ${initMs.toFixed(1)} ms`);
    console.log("All model dimensions are millimetres and Z-up.\n");

    for (const scale of [1, 10]) {
        const result = buildRoom(scale);
        console.log(`geometry scale ${scale}x`);
        console.log(`  fuseAll:     ${result.fuseMs.toFixed(2)} ms`);
        console.log(`  cutAll:      ${result.cutMs.toFixed(2)} ms`);
        console.log(`  tessellate:  ${result.tessellateMs.toFixed(2)} ms`);
        console.log(`  kernel total:${result.totalKernelMs.toFixed(2)} ms`);
        console.log(`  solids:      ${result.solidCount}`);
        console.log(`  triangles:   ${result.triangles}`);
        console.log(`  volume:      ${result.volume.toFixed(3)} mm^3\n`);
    }
} finally {
    kernel.releaseAll();
    kernel.delete();
}
