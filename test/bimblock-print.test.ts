import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";

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

/**
 * A true Boolean union built only from the public binary fuse primitive.
 *
 * Keep this test-local for now. It is deliberately balanced rather than a long
 * left fold so a storey with many walls has logarithmic boolean depth. The
 * production candidate should eventually be a native n-ary union API.
 */
function balancedTrueUnion(handles: number[]): number {
    if (handles.length === 0) throw new Error("balancedTrueUnion needs at least one shape");
    if (handles.length === 1) return kernel.copy(handles[0]);

    let level = [...handles];
    while (level.length > 1) {
        const next: number[] = [];
        for (let i = 0; i < level.length; i += 2) {
            if (i + 1 >= level.length) {
                next.push(level[i]);
            } else {
                next.push(kernel.fuse(level[i], level[i + 1]));
            }
        }
        level = next;
    }
    return level[0];
}

function buildArchitecturalCorner(scale = 1) {
    // Two perpendicular 4 mm walls, 30 mm high. They overlap at the corner,
    // so the Boolean union must collapse the duplicate volume.
    const wallX = translatedBox(120 * scale, 4 * scale, 30 * scale, 0, 0, 0);
    const wallY = translatedBox(4 * scale, 100 * scale, 30 * scale, 0, 0, 0);
    const fused = balancedTrueUnion([wallX, wallY]);

    // Tools deliberately extend beyond the full wall thickness so the result
    // is a real opening rather than a coplanar/sliver cut.
    const door = translatedBox(20 * scale, 10 * scale, 22 * scale, 30 * scale, -3 * scale, 0);
    const withDoor = kernel.cut(fused, door);

    const window = translatedBox(10 * scale, 20 * scale, 10 * scale, -3 * scale, 40 * scale, 12 * scale);
    const result = kernel.cut(withDoor, window);

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
        const union = balancedTrueUnion([a, b]);
        const expectedUnionVolume = 30 * 10 * 10;

        expect(Math.abs(kernel.getVolume(general))).toBeCloseTo(expectedUnionVolume, 6);
        expect(Math.abs(kernel.getVolume(union))).toBeCloseTo(expectedUnionVolume, 6);

        // fuseAll is currently backed by BRepAlgoAPI_BuilderAlgo (General
        // Fuse), which retains the split cells. This is useful CAD topology,
        // but it is not the watertight manufacturing union BIMBlock needs.
        expect(kernel.subShapeCount(general, "solid")).toBeGreaterThan(1);
        expect(kernel.subShapeCount(union, "solid")).toBe(1);
    });

    it("fuses walls, cuts door/window openings, and tessellates the result", () => {
        const { result, expectedVolume } = buildArchitecturalCorner();

        expect(Math.abs(kernel.getVolume(result))).toBeCloseTo(expectedVolume, 3);
        expect(kernel.subShapeCount(result, "solid")).toBe(1);

        const mesh = kernel.tessellate(result, 0.1, 0.5);
        expect(mesh.positionCount).toBeGreaterThan(0);
        expect(mesh.indexCount).toBeGreaterThan(0);
        expect(mesh.indexCount % 3).toBe(0);

        const positions = new Float32Array(
            Module.HEAPF32.buffer,
            mesh.getPositionsPtr(),
            mesh.positionCount,
        );
        for (const value of positions) expect(Number.isFinite(value)).toBe(true);
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
