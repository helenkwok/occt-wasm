import { OcctWorker } from "../../../ts/dist/worker.js";
import { prepareManufacturingMesh } from "../../../ts/dist/manufacturing-mesh.js";

const log = document.getElementById("log");
const result = document.getElementById("result");

function print(message) {
    log.textContent += `${message}\n`;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

let worker;
try {
    print("Spawning OCCT Worker...");
    worker = await OcctWorker.spawn();
    print("Worker ready.");

    const a = await worker.makeBox(20, 10, 10);
    const b0 = await worker.makeBox(20, 10, 10);
    const b = await worker.translate(b0, 10, 0, 0);
    await worker.release(b0);

    const union = await worker.unionAllPairwise([a, b]);
    const volume = await worker.getVolume(union);
    assert(Math.abs(volume - 3000) < 1e-6, `union volume ${volume}, expected 3000`);

    const solidCount = await worker.kernel.subShapeCount(union, "solid");
    assert(solidCount === 1, `union returned ${solidCount} solids, expected 1`);
    assert(await worker.kernel.isValid(union), "union B-Rep is invalid");

    // The true-union helper must never release caller-owned input handles.
    const volumeA = await worker.getVolume(a);
    const volumeB = await worker.getVolume(b);
    assert(Math.abs(volumeA - 2000) < 1e-6, "first input was invalidated by union");
    assert(Math.abs(volumeB - 2000) < 1e-6, "second input was invalidated by union");

    const mesh = await worker.tessellate(union, {
        linearDeflection: 0.1,
        angularDeflection: 0.5,
    });
    assert(mesh.triangleCount > 0, "worker tessellation returned no triangles");

    const prepared = prepareManufacturingMesh(mesh, 1e-5);
    assert(prepared.analysis.triangleCount > 0, "welded mesh returned no triangles");
    assert(prepared.analysis.boundaryEdges === 0,
        `welded mesh has ${prepared.analysis.boundaryEdges} boundary edges`);
    assert(prepared.analysis.nonManifoldEdges === 0,
        `welded mesh has ${prepared.analysis.nonManifoldEdges} non-manifold edges`);
    assert(prepared.analysis.inconsistentWindingEdges === 0,
        `welded mesh has ${prepared.analysis.inconsistentWindingEdges} winding inconsistencies`);
    assert(prepared.analysis.isClosedOrientedManifold,
        "welded mesh is not a closed oriented manifold");

    await worker.release(a);
    await worker.release(b);
    await worker.release(union);

    print(`true union: ${volume.toFixed(1)} volume, ${solidCount} solid`);
    print(`mesh: ${mesh.triangleCount} raw triangles, ${prepared.analysis.triangleCount} welded triangles`);
    print("--- ALL PASSED ---");
    result.textContent = "ALL PASSED";
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    print(`--- FAILED: ${message} ---`);
    result.textContent = `FAILED: ${message}`;
} finally {
    worker?.terminate();
}
