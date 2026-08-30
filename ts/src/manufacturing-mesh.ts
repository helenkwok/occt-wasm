import type { Mesh } from "./types.js";

export interface IndexedPositionMesh {
    positions: Float32Array;
    indices: Uint32Array;
}

export interface WeldedMesh extends IndexedPositionMesh {
    rawVertexCount: number;
    weldedVertexCount: number;
    removedDegenerateTriangles: number;
}

export interface ManifoldAnalysis {
    edgeCount: number;
    boundaryEdges: number;
    manifoldEdges: number;
    nonManifoldEdges: number;
    inconsistentWindingEdges: number;
    isClosedManifold: boolean;
    isClosedOrientedManifold: boolean;
}

export interface ManufacturingMeshResult extends WeldedMesh {
    analysis: ManifoldAnalysis;
}

function assertTolerance(tolerance: number): void {
    if (!Number.isFinite(tolerance) || tolerance <= 0) {
        throw new RangeError("mesh weld tolerance must be a finite number greater than zero");
    }
}

function cellKey(x: number, y: number, z: number, tolerance: number): string {
    return `${Math.floor(x / tolerance)},${Math.floor(y / tolerance)},${Math.floor(z / tolerance)}`;
}

function triangleDoubleAreaSquared(
    positions: readonly number[],
    a: number,
    b: number,
    c: number,
): number {
    const ao = a * 3;
    const bo = b * 3;
    const co = c * 3;
    const abx = positions[bo]! - positions[ao]!;
    const aby = positions[bo + 1]! - positions[ao + 1]!;
    const abz = positions[bo + 2]! - positions[ao + 2]!;
    const acx = positions[co]! - positions[ao]!;
    const acy = positions[co + 1]! - positions[ao + 1]!;
    const acz = positions[co + 2]! - positions[ao + 2]!;
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    return cx * cx + cy * cy + cz * cz;
}

/**
 * Weld coincident/near-coincident mesh vertices by position.
 *
 * OCCT tessellation is face-local, so shared B-Rep edges can appear as distinct
 * vertex indices with identical coordinates. This function removes those seams
 * for manufacturing-style indexed meshes while deliberately ignoring normals
 * and UVs.
 *
 * A small spatial hash is used instead of simple coordinate quantisation so two
 * points within `tolerance` still weld when they fall on opposite grid-cell
 * boundaries. Triangles that collapse after welding, or whose post-weld area is
 * effectively zero at the requested tolerance, are removed.
 */
export function weldMeshPositions(
    mesh: Pick<Mesh, "positions" | "indices"> | IndexedPositionMesh,
    tolerance = 1e-6,
): WeldedMesh {
    assertTolerance(tolerance);

    if (mesh.positions.length % 3 !== 0) {
        throw new RangeError("mesh positions length must be divisible by 3");
    }
    if (mesh.indices.length % 3 !== 0) {
        throw new RangeError("mesh indices length must be divisible by 3");
    }

    const rawVertexCount = mesh.positions.length / 3;
    const remap = new Uint32Array(rawVertexCount);
    const weldedPositions: number[] = [];
    const cells = new Map<string, number[]>();
    const toleranceSquared = tolerance * tolerance;

    for (let vertex = 0; vertex < rawVertexCount; vertex++) {
        const offset = vertex * 3;
        const x = mesh.positions[offset]!;
        const y = mesh.positions[offset + 1]!;
        const z = mesh.positions[offset + 2]!;

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            throw new RangeError(`mesh contains a non-finite position at vertex ${vertex}`);
        }

        const cx = Math.floor(x / tolerance);
        const cy = Math.floor(y / tolerance);
        const cz = Math.floor(z / tolerance);
        let matched: number | undefined;

        search:
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const bucket = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
                    if (bucket === undefined) continue;

                    for (const candidate of bucket) {
                        const candidateOffset = candidate * 3;
                        const px = weldedPositions[candidateOffset]!;
                        const py = weldedPositions[candidateOffset + 1]!;
                        const pz = weldedPositions[candidateOffset + 2]!;
                        const ddx = x - px;
                        const ddy = y - py;
                        const ddz = z - pz;
                        if (ddx * ddx + ddy * ddy + ddz * ddz <= toleranceSquared) {
                            matched = candidate;
                            break search;
                        }
                    }
                }
            }
        }

        if (matched === undefined) {
            matched = weldedPositions.length / 3;
            weldedPositions.push(x, y, z);
            const key = cellKey(x, y, z, tolerance);
            const bucket = cells.get(key);
            if (bucket === undefined) cells.set(key, [matched]);
            else bucket.push(matched);
        }

        remap[vertex] = matched;
    }

    const weldedIndices: number[] = [];
    let removedDegenerateTriangles = 0;
    const areaThresholdSquared = toleranceSquared * toleranceSquared;

    for (let i = 0; i < mesh.indices.length; i += 3) {
        const rawA = mesh.indices[i]!;
        const rawB = mesh.indices[i + 1]!;
        const rawC = mesh.indices[i + 2]!;
        if (rawA >= rawVertexCount || rawB >= rawVertexCount || rawC >= rawVertexCount) {
            throw new RangeError(`mesh triangle ${i / 3} references a vertex outside the position array`);
        }

        const a = remap[rawA]!;
        const b = remap[rawB]!;
        const c = remap[rawC]!;
        if (
            a === b ||
            b === c ||
            c === a ||
            triangleDoubleAreaSquared(weldedPositions, a, b, c) <= areaThresholdSquared
        ) {
            removedDegenerateTriangles++;
            continue;
        }
        weldedIndices.push(a, b, c);
    }

    return {
        positions: Float32Array.from(weldedPositions),
        indices: Uint32Array.from(weldedIndices),
        rawVertexCount,
        weldedVertexCount: weldedPositions.length / 3,
        removedDegenerateTriangles,
    };
}

/**
 * Analyze triangle-edge usage in an indexed mesh.
 *
 * For a closed 2-manifold triangle mesh every undirected edge is referenced by
 * exactly two triangles. One use indicates a boundary/hole; more than two uses
 * indicates a non-manifold edge. For a consistently oriented closed mesh, the
 * two triangles sharing an edge must traverse that edge in opposite directions.
 */
export function analyzeManifoldEdges(indices: Uint32Array): ManifoldAnalysis {
    if (indices.length % 3 !== 0) {
        throw new RangeError("mesh indices length must be divisible by 3");
    }

    type EdgeUse = { count: number; forward: number; reverse: number };
    const edgeUse = new Map<string, EdgeUse>();
    const addEdge = (a: number, b: number): void => {
        const low = Math.min(a, b);
        const high = Math.max(a, b);
        const key = `${low}:${high}`;
        const stats = edgeUse.get(key) ?? { count: 0, forward: 0, reverse: 0 };
        stats.count++;
        if (a === low && b === high) stats.forward++;
        else stats.reverse++;
        edgeUse.set(key, stats);
    };

    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i]!;
        const b = indices[i + 1]!;
        const c = indices[i + 2]!;
        if (a === b || b === c || c === a) continue;
        addEdge(a, b);
        addEdge(b, c);
        addEdge(c, a);
    }

    let boundaryEdges = 0;
    let manifoldEdges = 0;
    let nonManifoldEdges = 0;
    let inconsistentWindingEdges = 0;
    for (const stats of edgeUse.values()) {
        if (stats.count === 1) {
            boundaryEdges++;
        } else if (stats.count === 2) {
            manifoldEdges++;
            if (stats.forward !== 1 || stats.reverse !== 1) inconsistentWindingEdges++;
        } else if (stats.count > 2) {
            nonManifoldEdges++;
        }
    }

    const isClosedManifold = boundaryEdges === 0 && nonManifoldEdges === 0;
    return {
        edgeCount: edgeUse.size,
        boundaryEdges,
        manifoldEdges,
        nonManifoldEdges,
        inconsistentWindingEdges,
        isClosedManifold,
        isClosedOrientedManifold: isClosedManifold && inconsistentWindingEdges === 0,
    };
}

/** Weld face-local seams and immediately analyze the resulting topology. */
export function prepareManufacturingMesh(
    mesh: Pick<Mesh, "positions" | "indices"> | IndexedPositionMesh,
    tolerance = 1e-6,
): ManufacturingMeshResult {
    const welded = weldMeshPositions(mesh, tolerance);
    return {
        ...welded,
        analysis: analyzeManifoldEdges(welded.indices),
    };
}
