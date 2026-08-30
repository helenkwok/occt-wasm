import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { unionAllPairwise } from "../ts/src/union-all.ts";
import type { ShapeHandle } from "../ts/src/index.ts";

// BIMBlock-shaped regression probes for the 3D-print path.
// The print derivative is expressed in millimetres and Z-up before it reaches
// OCCT, matching slicer conventions rather than BIMBlock's live Y-up scene.
let Module: any;
let kernel: any;

beforeAll(async () => {
    const wasmPath = resolve(__dirname, "../dist/occt-wasm.wasm");
    const jsPath = resolve(__dirname, "../dist/occt-wasm.js");
    const createOcctWasm = (await import(jsPath)).default;

    Module = await createOcctWasm({
        locateFile: (path: string) => (path.endsWith(".wasm") ? wasmPath : path),
    });
    kernel = new Module.OcctKernel();
}, 30_000);

afterEach(() => {
    kernel.releaseAll();
});

afterAll(() => {
    kernel.releaseAll();
    kernel.delete();
});

function translatedBox(
    dx: number,
    dy: number,
    dz: number,
    tx: number,
    ty: number,
    tz: number,
): number {
    const box = kernel.makeBox(dx, dy, dz);
    const moved = kernel.translate(box, tx, ty, tz);
    kernel.release(box);
    return moved;
}

function handleVector(handles: number[]) {
    const vector = new Module.VectorUint32();
    for (const handle of handles) vector.push_back(handle);
    return vector;
}

function generalFuseAll(handles: number[]): number {
    const vector = handleVector(handles);
    try {
        return kernel.fuseAll(vector);
    } finally {
        vector.delete();
    }
}

function batchCut(base: number, tools: number[]): number {
    const vector = handleVector(tools);
    try {
        return kernel.cutAll(base, vector);
    } finally {
        vector.delete();
    }
}

function trueUnion(handles: number[]): number {
    // The helper targets the high-level TS OcctKernel. The raw Embind kernel
    // used by this regression has the same fuse/copy/release surface for these
    // methods, so the cast lets the same implementation exercise real WASM.
    return unionAllPairwise(
        kernel,
        handles as unknown as readonly ShapeHandle[],
    ) as unknown as number;
}

function copyMesh(mesh: any) {
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

/**
 * Weld only by geometric position, which is appropriate for BIMBlock's 3MF
 * manufacturing mesh: face normals/UV seams are irrelevant to the print mesh.
 *
 * occt-wasm tessellates each B-Rep face independently, so adjacent faces can
 * contain duplicate boundary coordinates under different raw vertex indices.
 */
function weldAndAnalyze(
    positions: Float32Array,
    indices: Uint32Array,
    tolerance: number,
) {
    const rawVertexCount = positions.length / 3;
    const rawToWelded = new Uint32Array(rawVertexCount);
    const keyToIndex = new Map<string, number>();
    let weldedVertexCount = 0;

    const quantize = (value: number) => Math.round(value / tolerance);

    for (let i = 0; i < rawVertexCount; i++) {
        const base = i * 3;
        const key = `${quantize(positions[base]!)},${quantize(positions[base + 1]!)},${quantize(positions[base + 2]!)}`;
        let welded = keyToIndex.get(key);
        if (welded === undefined) {
            welded = weldedVertexCount++;
            keyToIndex.set(key, welded);
        }
        rawToWelded[i] = welded;
    }

    const edgeUse = new Map<string, number>();
    let degenerateTriangles = 0;

    const addEdge = (a: number, b: number) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const key = `${lo}:${hi}`;
        edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    };

    for (let i = 0; i < indices.length; i += 3) {
        const a = rawToWelded[indices[i]!]!;
        const b = rawToWelded[indices[i + 1]!]!;
        const c = rawToWelded[indices[i + 2]!]!;
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

function buildArchitecturalCorner(scale = 1) {
    // Two perpendicular 4 mm walls, 30 mm high. They overlap at the corner,
    // so the Boolean union must collapse the duplicate volume.
    const wallX = translatedBox(120 * scale, 4 * scale, 30 * scale, 0, 0, 0);
    const wallY = translatedBox(4 * scale, 100 * scale, 30 * scale, 0, 0, 0);
    const fused = trueUnion([wallX, wallY]);

    // Tools deliberately extend beyond the full wall thickness so the result
    // is a real opening rather than a coplanar/sliver cut.
    const door = translatedBox(20 * scale, 10 * scale, 22 * scale, 30 * scale, -3 * scale, 0);
    const window = translatedBox(10 * scale, 20 * scale, 10 * scale, -3 * scale, 40 * scale, 12 * scale);
    const result = batchCut(fused, [door, window]);

    // Wall union: 120*4*30 + 4*100*30 - 4*4*30 = 25,920 mm^3.
    // Door removes 20*4*22 = 1,760; window removes 4*20*10 = 800.
    const expectedVolume = 23_360 * scale ** 3;

    return { result, expectedVolume };
}

describe("BIMBlock 3D-print Boolean semantics", () => {
    it("distinguishes General Fuse cells from a true Boolean union", () => {
        // Two overlapping boxes have three General-Fuse cells (A-only,
        // intersection, B-only) but one connected Boolean-union solid.
        const a = kernel.makeBox(20, 10, 10);
        const b = translatedBox(20, 10, 10, 10, 0, 0);

        const general = generalFuseAll([a, b]);
        const union = trueUnion([a, b]);
        const expectedUnionVolume = 30 * 10 * 10;

        expect(Math.abs(kernel.getVolume(general))).toBeCloseTo(expectedUnionVolume, 6);
        expect(Math.abs(kernel.getVolume(union))).toBeCloseTo(expectedUnionVolume, 6);

        // fuseAll is currently backed by BRepAlgoAPI_BuilderAlgo (General
        // Fuse), which retains the split cells. This is useful CAD topology,
        // but it is not the watertight manufacturing union BIMBlock needs.
        expect(kernel.subShapeCount(general, "solid")).toBeGreaterThan(1);
        expect(kernel.subShapeCount(union, "solid")).toBe(1);
    });

    it("preserves disconnected printable components instead of creating a fake bridge", () => {
        const a = kernel.makeBox(10, 10, 10);
        const b = translatedBox(10, 10, 10, 30, 0, 0);
        const union = trueUnion([a, b]);

        expect(Math.abs(kernel.getVolume(union))).toBeCloseTo(2_000, 6);
        expect(kernel.subShapeCount(union, "solid")).toBe(2);
        expect(kernel.isValid(union)).toBe(true);
    });

    it("handles an architectural wall meeting a slab by exact face contact or tiny print overlap", () => {
        const slab = kernel.makeBox(50, 50, 2);

        const touchingWall = translatedBox(50, 4, 20, 0, 0, 2);
        const exact = trueUnion([slab, touchingWall]);
        expect(Math.abs(kernel.getVolume(exact))).toBeCloseTo(9_000, 6);
        expect(kernel.subShapeCount(exact, "solid")).toBe(1);
        expect(kernel.isValid(exact)).toBe(true);

        kernel.releaseAll();

        const slab2 = kernel.makeBox(50, 50, 2);
        const overlappingWall = translatedBox(50, 4, 20, 0, 0, 1.98);
        const overlapped = trueUnion([slab2, overlappingWall]);
        // 0.02 mm overlap * 50 * 4 = 4 mm^3 duplicate volume removed.
        expect(Math.abs(kernel.getVolume(overlapped))).toBeCloseTo(8_996, 6);
        expect(kernel.subShapeCount(overlapped, "solid")).toBe(1);
        expect(kernel.isValid(overlapped)).toBe(true);
    });

    it("fuses walls, batches door/window cuts, and tessellates the result", () => {
        const { result, expectedVolume } = buildArchitecturalCorner();

        expect(Math.abs(kernel.getVolume(result))).toBeCloseTo(expectedVolume, 3);
        expect(kernel.subShapeCount(result, "solid")).toBe(1);
        expect(kernel.isValid(result)).toBe(true);

        const mesh = kernel.tessellate(result, 0.1, 0.5);
        expect(mesh.positionCount).toBeGreaterThan(0);
        expect(mesh.indexCount).toBeGreaterThan(0);
        expect(mesh.indexCount % 3).toBe(0);

        const { positions, indices } = copyMesh(mesh);
        for (const value of positions) expect(Number.isFinite(value)).toBe(true);

        // A B-Rep face mesh is intentionally face-local. Welding equal
        // positions should collapse those seams into a closed manufacturing
        // topology suitable for an indexed 3MF mesh.
        const welded = weldAndAnalyze(positions, indices, 1e-4);
        expect(welded.weldedVertexCount).toBeLessThan(welded.rawVertexCount);
        expect(welded.degenerateTriangles).toBe(0);
        expect(welded.boundaryEdges).toBe(0);
        expect(welded.nonManifoldEdges).toBe(0);

        mesh.delete();
    });

    it("keeps planar architectural booleans stable across print-scale magnitudes", () => {
        // 0.1x covers sub-millimetre wall features; 10x covers oversized model
        // components. These are more representative for print than sweeping an
        // arbitrary CAD model through many orders of magnitude.
        for (const scale of [0.1, 1, 10]) {
            const { result, expectedVolume } = buildArchitecturalCorner(scale);
            const actual = Math.abs(kernel.getVolume(result));
            const relativeError = Math.abs(actual - expectedVolume) / expectedVolume;
            expect(relativeError).toBeLessThan(1e-8);
            expect(kernel.isValid(result)).toBe(true);
            kernel.releaseAll();
        }
    });

    it("returns the arena to its checkpoint after repeated print jobs", () => {
        const baseline = kernel.getShapeCount();

        for (let iteration = 0; iteration < 25; iteration++) {
            const mark = kernel.checkpoint();
            const { result } = buildArchitecturalCorner();
            const mesh = kernel.tessellate(result, 0.2, 0.5);
            expect(mesh.indexCount).toBeGreaterThan(0);
            mesh.delete();

            kernel.releaseSince(mark);
            expect(kernel.getShapeCount()).toBe(baseline);
        }
    });
});
