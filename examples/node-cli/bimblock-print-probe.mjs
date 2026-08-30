#!/usr/bin/env node
/**
 * BIMBlock 3D-print solid-kernel probe.
 *
 * Builds a small room from architectural wall solids and compares occt-wasm's
 * current `fuseAll` (General Fuse / split cells) with a balanced true Boolean
 * union built from `fuse`. The true union is then cut with four openings,
 * tessellated, position-welded, and checked for manifold edge use.
 *
 * Geometry is Z-up and expressed in millimetres, matching the intended
 * BIMBlock manufacturing path.
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

function generalFuseAll(handles) {
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

function balancedTrueUnion(handles) {
    if (handles.length === 0) throw new Error("balancedTrueUnion needs at least one shape");
    if (handles.length === 1) return kernel.copy(handles[0]);

    let level = handles.map((shape) => ({ shape, owned: false }));
    const live = new Set();

    const releaseIntermediate = (entry) => {
        if (!entry.owned) return;
        kernel.release(entry.shape);
        live.delete(entry.shape);
    };

    try {
        while (level.length > 1) {
            const next = [];
            for (let i = 0; i < level.length; i += 2) {
                const left = level[i];
                const right = level[i + 1];
                if (right === undefined) {
                    next.push(left);
                    continue;
                }

                const fused = kernel.fuse(left.shape, right.shape);
                live.add(fused);
                releaseIntermediate(left);
                releaseIntermediate(right);
                next.push({ shape: fused, owned: true });
            }
            level = next;
        }

        const result = level[0];
        live.delete(result.shape);
        return result.shape;
    } catch (error) {
        for (const shape of live) {
            try { kernel.release(shape); } catch { /* preserve original error */ }
        }
        throw error;
    }
}

function copyMesh(mesh) {
    const positions = new Float32Array(
        Module.HEAPF32.buffer.slice(
            mesh.getPositionsPtr(),
            mesh.getPositionsPtr() + mesh.positionCount * 4,
        ),
    );
    const indices = new Uint32Array(
        Module.HEAPU32.buffer.slice(
            mesh.getIndicesPtr(),
            mesh.getIndicesPtr() + mesh.indexCount * 4,
        ),
    );
    return { positions, indices };
}

function weldAndAnalyze(positions, indices, tolerance) {
    const rawVertexCount = positions.length / 3;
    const rawToWelded = new Uint32Array(rawVertexCount);
    const keyToIndex = new Map();
    let weldedVertexCount = 0;

    const quantize = (value) => Math.round(value / tolerance);
    for (let i = 0; i < rawVertexCount; i++) {
        const base = i * 3;
        const key = `${quantize(positions[base])},${quantize(positions[base + 1])},${quantize(positions[base + 2])}`;
        let welded = keyToIndex.get(key);
        if (welded === undefined) {
            welded = weldedVertexCount++;
            keyToIndex.set(key, welded);
        }
        rawToWelded[i] = welded;
    }

    const edgeUse = new Map();
    let degenerateTriangles = 0;
    const addEdge = (a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const key = `${lo}:${hi}`;
        edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    };

    for (let i = 0; i < indices.length; i += 3) {
        const a = rawToWelded[indices[i]];
        const b = rawToWelded[indices[i + 1]];
        const c = rawToWelded[indices[i + 2]];
        if (a === b || b === c || c === a) {
            degenerateTriangles++;
            continue;
        }
        addEdge(a, b);
        addEdge(b, c);
        addEdge(c, a);
    }

    let boundaryEdges = 0;
    let nonManifoldEdges = 0;
    for (const count of edgeUse.values()) {
        if (count === 1) boundaryEdges++;
        if (count > 2) nonManifoldEdges++;
    }

    return {
        rawVertexCount,
        weldedVertexCount,
        boundaryEdges,
        nonManifoldEdges,
        degenerateTriangles,
    };
}

function buildRoom(scale) {
    const mark = kernel.checkpoint();
    const shapeCountBefore = kernel.getShapeCount();

    const walls = [
        translatedBox(120 * scale, 4 * scale, 30 * scale, 0, 0, 0),
        translatedBox(120 * scale, 4 * scale, 30 * scale, 0, 96 * scale, 0),
        translatedBox(4 * scale, 100 * scale, 30 * scale, 0, 0, 0),
        translatedBox(4 * scale, 100 * scale, 30 * scale, 116 * scale, 0, 0),
    ];

    // Current occt-wasm fuseAll uses BRepAlgoAPI_BuilderAlgo (General Fuse).
    // Measure it because it is a useful upstream baseline, but do not feed it
    // into the manufacturing path: it retains split cells/internal boundaries.
    const generalStart = performance.now();
    const general = generalFuseAll(walls);
    const generalFuseMs = performance.now() - generalStart;
    const generalSolidCount = kernel.subShapeCount(general, "solid");
    const generalVolume = Math.abs(kernel.getVolume(general));

    // BIMBlock needs a true union before tessellation. Until occt-wasm exposes
    // a native n-ary Boolean union, compare a balanced tree of binary fuses.
    const unionStart = performance.now();
    const shell = balancedTrueUnion(walls);
    const trueUnionMs = performance.now() - unionStart;
    const trueUnionSolidCount = kernel.subShapeCount(shell, "solid");
    const trueUnionVolume = Math.abs(kernel.getVolume(shell));
    const trueUnionValid = kernel.isValid(shell);

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

    const linearDeflection = 0.1 * scale;
    const tessStart = performance.now();
    const mesh = kernel.tessellate(opened, linearDeflection, 0.5);
    const tessellateMs = performance.now() - tessStart;

    const { positions, indices } = copyMesh(mesh);
    // Face-local tessellation duplicates boundary vertices. The weld tolerance
    // is deliberately tiny relative to the meshing deflection for this probe.
    const weldTolerance = Math.max(1e-7, linearDeflection * 1e-3);
    const weld = weldAndAnalyze(positions, indices, weldTolerance);

    const expectedShellVolume = 50_880 * scale ** 3;
    const expectedOpenedVolume = 45_600 * scale ** 3;
    const openedVolume = Math.abs(kernel.getVolume(opened));
    const openedSolidCount = kernel.subShapeCount(opened, "solid");
    const openedValid = kernel.isValid(opened);

    const result = {
        scale,
        generalFuseMs,
        generalSolidCount,
        generalVolume,
        trueUnionMs,
        trueUnionSolidCount,
        trueUnionVolume,
        trueUnionValid,
        cutMs,
        tessellateMs,
        totalManufacturingMs: trueUnionMs + cutMs + tessellateMs,
        expectedShellVolume,
        expectedOpenedVolume,
        openedVolume,
        openedSolidCount,
        openedValid,
        triangles: mesh.indexCount / 3,
        weldTolerance,
        ...weld,
        shapeCountPeak: kernel.getShapeCount(),
    };

    mesh.delete();
    kernel.releaseSince(mark);
    result.shapeCountAfterRelease = kernel.getShapeCount();
    result.shapeCountBefore = shapeCountBefore;
    return result;
}

function relError(actual, expected) {
    return Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
}

try {
    console.log("BIMBlock occt-wasm print probe");
    console.log(`WASM init: ${initMs.toFixed(1)} ms`);
    console.log("All model dimensions are millimetres and Z-up.");
    console.log("fuseAll is reported separately because it is General Fuse, not true union.\n");

    for (const scale of [0.1, 1, 10]) {
        const result = buildRoom(scale);
        console.log(`geometry scale ${scale}x`);
        console.log("  General Fuse (current fuseAll)");
        console.log(`    time:        ${result.generalFuseMs.toFixed(2)} ms`);
        console.log(`    solids:      ${result.generalSolidCount}`);
        console.log(`    volume:      ${result.generalVolume.toFixed(3)} mm^3`);
        console.log("  True union (balanced binary fuse)");
        console.log(`    time:        ${result.trueUnionMs.toFixed(2)} ms`);
        console.log(`    solids:      ${result.trueUnionSolidCount}`);
        console.log(`    valid:       ${result.trueUnionValid}`);
        console.log(`    volume:      ${result.trueUnionVolume.toFixed(3)} mm^3`);
        console.log(`    shell error: ${relError(result.trueUnionVolume, result.expectedShellVolume).toExponential(2)}`);
        console.log("  Open + tessellate");
        console.log(`    cutAll:      ${result.cutMs.toFixed(2)} ms`);
        console.log(`    tessellate:  ${result.tessellateMs.toFixed(2)} ms`);
        console.log(`    total:       ${result.totalManufacturingMs.toFixed(2)} ms`);
        console.log(`    solids:      ${result.openedSolidCount}`);
        console.log(`    valid:       ${result.openedValid}`);
        console.log(`    triangles:   ${result.triangles}`);
        console.log(`    volume:      ${result.openedVolume.toFixed(3)} mm^3`);
        console.log(`    volume error:${relError(result.openedVolume, result.expectedOpenedVolume).toExponential(2)}`);
        console.log("  Welded 3MF topology");
        console.log(`    weld tol:    ${result.weldTolerance.toExponential(2)} mm`);
        console.log(`    vertices:    ${result.rawVertexCount} raw -> ${result.weldedVertexCount} welded`);
        console.log(`    degenerate:  ${result.degenerateTriangles}`);
        console.log(`    boundary:    ${result.boundaryEdges}`);
        console.log(`    non-manifold:${result.nonManifoldEdges}`);
        console.log("  Arena");
        console.log(`    peak handles:${result.shapeCountPeak}`);
        console.log(`    before/after checkpoint release: ${result.shapeCountBefore}/${result.shapeCountAfterRelease}\n`);
    }
} finally {
    kernel.releaseAll();
    kernel.delete();
}
