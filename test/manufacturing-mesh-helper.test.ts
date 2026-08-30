import { describe, expect, it } from "vitest";
import {
    analyzeManifoldEdges,
    prepareManufacturingMesh,
    weldMeshPositions,
} from "../ts/src/manufacturing-mesh.ts";

function cubeFaceLocalMesh() {
    // A unit cube represented the way a face-local CAD tessellator often emits
    // it: four unique vertices per face, so the 8 geometric corners appear as
    // 24 raw vertices. Face winding points outward on all six sides.
    const positions = Float32Array.from([
        // +X
        1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1,
        // -X
        0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0,
        // +Y
        0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0,
        // -Y
        0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1,
        // +Z
        0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
        // -Z
        1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0,
    ]);
    const indices: number[] = [];
    for (let face = 0; face < 6; face++) {
        const o = face * 4;
        indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    return { positions, indices: Uint32Array.from(indices) };
}

describe("manufacturing mesh helpers", () => {
    it("welds a face-local cube to 8 geometric vertices and a closed oriented manifold", () => {
        const result = prepareManufacturingMesh(cubeFaceLocalMesh(), 1e-6);

        expect(result.rawVertexCount).toBe(24);
        expect(result.weldedVertexCount).toBe(8);
        expect(result.removedDegenerateTriangles).toBe(0);
        expect(result.indices).toHaveLength(36);
        expect(result.analysis.boundaryEdges).toBe(0);
        expect(result.analysis.nonManifoldEdges).toBe(0);
        expect(result.analysis.inconsistentWindingEdges).toBe(0);
        expect(result.analysis.manifoldEdges).toBe(18);
        expect(result.analysis.isClosedManifold).toBe(true);
        expect(result.analysis.isClosedOrientedManifold).toBe(true);
    });

    it("welds points within tolerance even across adjacent hash cells", () => {
        const tolerance = 1;
        const positions = Float32Array.from([
            0.99, 0, 0,
            1.01, 0, 0,
            0, 1, 0,
        ]);
        const welded = weldMeshPositions(
            { positions, indices: Uint32Array.from([0, 1, 2]) },
            tolerance,
        );

        expect(welded.weldedVertexCount).toBe(2);
        expect(welded.removedDegenerateTriangles).toBe(1);
        expect(welded.indices).toHaveLength(0);
    });

    it("removes a collinear zero-area triangle even when its vertices remain distinct", () => {
        const welded = weldMeshPositions({
            positions: Float32Array.from([
                0, 0, 0,
                1, 0, 0,
                2, 0, 0,
            ]),
            indices: Uint32Array.from([0, 1, 2]),
        }, 1e-3);

        expect(welded.weldedVertexCount).toBe(3);
        expect(welded.removedDegenerateTriangles).toBe(1);
        expect(welded.indices).toHaveLength(0);
    });

    it("classifies an open triangle mesh by boundary edges", () => {
        const analysis = analyzeManifoldEdges(Uint32Array.from([0, 1, 2]));
        expect(analysis.edgeCount).toBe(3);
        expect(analysis.boundaryEdges).toBe(3);
        expect(analysis.nonManifoldEdges).toBe(0);
        expect(analysis.inconsistentWindingEdges).toBe(0);
        expect(analysis.isClosedManifold).toBe(false);
        expect(analysis.isClosedOrientedManifold).toBe(false);
    });

    it("detects inconsistent winding when two triangles traverse a shared edge the same way", () => {
        const analysis = analyzeManifoldEdges(Uint32Array.from([
            0, 1, 2,
            0, 1, 3,
        ]));

        expect(analysis.inconsistentWindingEdges).toBe(1);
        expect(analysis.isClosedOrientedManifold).toBe(false);
    });

    it("detects an edge shared by more than two triangles", () => {
        const analysis = analyzeManifoldEdges(Uint32Array.from([
            0, 1, 2,
            1, 0, 3,
            0, 1, 4,
        ]));

        expect(analysis.nonManifoldEdges).toBe(1);
        expect(analysis.isClosedManifold).toBe(false);
        expect(analysis.isClosedOrientedManifold).toBe(false);
    });

    it("rejects malformed arrays, invalid indices, non-finite positions, and bad tolerance", () => {
        expect(() => weldMeshPositions({
            positions: Float32Array.from([0, 0]),
            indices: new Uint32Array(),
        })).toThrow(RangeError);

        expect(() => weldMeshPositions({
            positions: Float32Array.from([0, 0, 0]),
            indices: Uint32Array.from([0, 0]),
        })).toThrow(RangeError);

        expect(() => weldMeshPositions({
            positions: Float32Array.from([0, 0, 0]),
            indices: Uint32Array.from([0, 1, 0]),
        })).toThrow(/outside the position array/);

        expect(() => weldMeshPositions({
            positions: Float32Array.from([Number.NaN, 0, 0]),
            indices: new Uint32Array(),
        })).toThrow(/non-finite position/);

        expect(() => weldMeshPositions({
            positions: Float32Array.from([0, 0, 0]),
            indices: new Uint32Array(),
        }, 0)).toThrow(RangeError);
    });
});
