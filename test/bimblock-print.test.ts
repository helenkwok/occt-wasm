import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";

// BIMBlock-shaped regression probe for the 3D-print path.
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

function buildArchitecturalCorner(scale = 1) {
    // Two perpendicular 4 mm walls, 30 mm high. They overlap at the corner,
    // so the boolean union must collapse the duplicate volume.
    const wallX = translatedBox(120 * scale, 4 * scale, 30 * scale, 0, 0, 0);
    const wallY = translatedBox(4 * scale, 100 * scale, 30 * scale, 0, 0, 0);
    const fused = kernel.fuse(wallX, wallY);

    // Tools deliberately extend through the full wall thickness so the result
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

describe("BIMBlock 3D-print boolean workload", () => {
    it("fuses walls, cuts door/window openings, and tessellates the result", () => {
        const { result, expectedVolume } = buildArchitecturalCorner();

        expect(Math.abs(kernel.getVolume(result))).toBeCloseTo(expectedVolume, 3);

        const solids = kernel.getSubShapes(result, "solid");
        expect(solids.size()).toBe(1);
        for (let i = 0; i < solids.size(); i++) kernel.release(solids.get(i));
        solids.delete();

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

    it("keeps the same relative volume across print-scale magnitudes", () => {
        for (const scale of [1, 10]) {
            const { result, expectedVolume } = buildArchitecturalCorner(scale);
            const actual = Math.abs(kernel.getVolume(result));
            const relativeError = Math.abs(actual - expectedVolume) / expectedVolume;
            expect(relativeError).toBeLessThan(1e-9);
            kernel.releaseAll();
        }
    });
});
