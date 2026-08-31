import { OcctError, OcctErrorCode } from "../../../ts/dist/index.js";
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

    // Structured kernel failures must survive the real Worker + Comlink boundary
    // as OcctError instances rather than losing code/operation metadata.
    let structuredError;
    try {
        await worker.getVolume(0x7fffffff);
    } catch (error) {
        structuredError = error;
    }
    assert(structuredError instanceof OcctError,
        `worker error is ${structuredError?.constructor?.name ?? typeof structuredError}, expected OcctError`);
    assert(structuredError.operation === "getVolume",
        `worker error operation ${structuredError.operation}, expected getVolume`);
    assert(structuredError.code === OcctErrorCode.InvalidShapeId,
        `worker error code ${structuredError.code}, expected ${OcctErrorCode.InvalidShapeId}`);

    const a = await worker.makeBox(20, 10, 10);
    const b0 = await worker.makeBox(20, 10, 10);
    const b = await worker.translate(b0, 10, 0, 0);
    await worker.release(b0);

    const union = await worker.unionAll([a, b]);
    const volume = await worker.getVolume(union);
    assert(Math.abs(volume - 3000) < 1e-6, `union volume ${volume}, expected 3000`);

    const solidCount = await worker.kernel.subShapeCount(union, "solid");
    assert(solidCount === 1, `union returned ${solidCount} solids, expected 1`);
    assert(await worker.kernel.isValid(union), "union B-Rep is invalid");

    // General Fuse preserves split cells rather than collapsing the overlap
    // into one topological solid. This is the semantic distinction the public
    // API names are intended to make explicit.
    const generalFuse = await worker.generalFuse([a, b]);
    const generalFuseVolume = await worker.getVolume(generalFuse);
    const generalFuseSolidCount = await worker.kernel.subShapeCount(generalFuse, "solid");
    assert(Math.abs(generalFuseVolume - 3000) < 1e-6,
        `general-fuse volume ${generalFuseVolume}, expected 3000`);
    assert(generalFuseSolidCount > 1,
        `general fuse returned ${generalFuseSolidCount} solid(s), expected split cells`);

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
    await worker.release(generalFuse);

    print(`structured error: ${structuredError.operation}/${structuredError.code}`);
    print(`true union: ${volume.toFixed(1)} volume, ${solidCount} solid`);
    print(`general fuse: ${generalFuseVolume.toFixed(1)} volume, ${generalFuseSolidCount} split solids`);
    print(`mesh: ${mesh.triangleCount} raw triangles, ${prepared.analysis.triangleCount} welded triangles`);

    // Normal shutdown should deterministically dispose the kernel before
    // releasing Comlink proxy state and terminating the Worker. It is safe to
    // call more than once, and released proxies must no longer be usable.
    await worker.close();
    await worker.close();
    let closedError;
    try {
        await worker.makeBox(1, 1, 1);
    } catch (error) {
        closedError = error;
    }
    assert(closedError instanceof Error, "closed Worker proxy remained usable");
    print("graceful close: passed");

    print("--- ALL PASSED ---");
    result.textContent = "ALL PASSED";
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    print(`--- FAILED: ${message} ---`);
    result.textContent = `FAILED: ${message}`;
} finally {
    worker?.terminate();
}
