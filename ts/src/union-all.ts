import type { OcctKernel } from "./index.js";
import type { ShapeHandle } from "./types.js";

type UnionEntry = { shape: ShapeHandle; owned: boolean };

/** Minimal synchronous kernel surface required by {@link unionAllPairwise}. */
export interface UnionKernel {
    fuse(a: ShapeHandle, b: ShapeHandle): ShapeHandle;
    copy(shape: ShapeHandle): ShapeHandle;
    release(shape: ShapeHandle): void;
}

/** Minimal asynchronous kernel surface required by {@link unionAllPairwiseAsync}. */
export interface AsyncUnionKernel {
    fuse(a: ShapeHandle, b: ShapeHandle): Promise<ShapeHandle>;
    copy(shape: ShapeHandle): Promise<ShapeHandle>;
    release(shape: ShapeHandle): Promise<void>;
}

/**
 * Compute a true Boolean union of many shapes using a balanced tree of the
 * existing binary `BRepAlgoAPI_Fuse` operation.
 *
 * This is intentionally separate from `OcctKernel.fuseAll()`: the current raw
 * `fuseAll()` implementation is OCCT General Fuse (`BRepAlgoAPI_BuilderAlgo`),
 * which returns split argument cells rather than a manufacturing union with
 * internal interfaces removed.
 *
 * The balanced tree keeps Boolean depth logarithmic and releases intermediate
 * results as soon as their parent result has been created. Caller-owned input
 * handles are never released. The returned handle is newly allocated and owned
 * by the caller, including the single-input case.
 *
 * If a fuse step throws, every intermediate handle created by this helper is
 * released before the error is rethrown.
 *
 * @throws if `shapes` is empty or an underlying Boolean fuse fails.
 */
export function unionAllPairwise(
    kernel: UnionKernel | OcctKernel,
    shapes: readonly ShapeHandle[],
): ShapeHandle {
    if (shapes.length === 0) {
        throw new RangeError("unionAllPairwise: no shapes provided");
    }
    if (shapes.length === 1) {
        return kernel.copy(shapes[0]!);
    }

    let level: UnionEntry[] = shapes.map((shape) => ({ shape, owned: false }));
    const liveIntermediates = new Set<ShapeHandle>();

    const releaseIntermediate = (entry: UnionEntry): void => {
        if (!entry.owned) return;
        kernel.release(entry.shape);
        liveIntermediates.delete(entry.shape);
    };

    try {
        while (level.length > 1) {
            const next: UnionEntry[] = [];

            for (let i = 0; i < level.length; i += 2) {
                const left = level[i]!;
                const right = level[i + 1];

                if (right === undefined) {
                    next.push(left);
                    continue;
                }

                const fused = kernel.fuse(left.shape, right.shape);
                liveIntermediates.add(fused);

                releaseIntermediate(left);
                releaseIntermediate(right);
                next.push({ shape: fused, owned: true });
            }

            level = next;
        }

        const result = level[0]!;
        liveIntermediates.delete(result.shape);
        return result.shape;
    } catch (error) {
        for (const shape of liveIntermediates) {
            try {
                kernel.release(shape);
            } catch {
                // Preserve the original Boolean error.
            }
        }
        throw error;
    }
}

/**
 * Async counterpart of {@link unionAllPairwise} for Worker/Comlink proxies.
 *
 * The ownership contract is identical to the synchronous helper: caller-owned
 * inputs are never released, helper-owned intermediates are reclaimed eagerly,
 * and the returned handle is caller-owned. Boolean calls are intentionally
 * awaited sequentially within each tree level because one OCCT Worker executes
 * on a single thread; issuing concurrent RPCs would not make the kernel itself
 * parallel and would complicate deterministic handle ownership.
 *
 * @example
 * ```ts
 * import { unionAllPairwiseAsync } from "occt-wasm/union-all";
 * import { OcctWorker } from "occt-wasm/worker";
 *
 * const worker = await OcctWorker.spawn();
 * const result = await unionAllPairwiseAsync(worker.kernel, shapes);
 * ```
 *
 * @throws if `shapes` is empty or an underlying Boolean fuse fails.
 */
export async function unionAllPairwiseAsync(
    kernel: AsyncUnionKernel,
    shapes: readonly ShapeHandle[],
): Promise<ShapeHandle> {
    if (shapes.length === 0) {
        throw new RangeError("unionAllPairwiseAsync: no shapes provided");
    }
    if (shapes.length === 1) {
        return kernel.copy(shapes[0]!);
    }

    let level: UnionEntry[] = shapes.map((shape) => ({ shape, owned: false }));
    const liveIntermediates = new Set<ShapeHandle>();

    const releaseIntermediate = async (entry: UnionEntry): Promise<void> => {
        if (!entry.owned) return;
        await kernel.release(entry.shape);
        liveIntermediates.delete(entry.shape);
    };

    try {
        while (level.length > 1) {
            const next: UnionEntry[] = [];

            for (let i = 0; i < level.length; i += 2) {
                const left = level[i]!;
                const right = level[i + 1];

                if (right === undefined) {
                    next.push(left);
                    continue;
                }

                const fused = await kernel.fuse(left.shape, right.shape);
                liveIntermediates.add(fused);

                await releaseIntermediate(left);
                await releaseIntermediate(right);
                next.push({ shape: fused, owned: true });
            }

            level = next;
        }

        const result = level[0]!;
        liveIntermediates.delete(result.shape);
        return result.shape;
    } catch (error) {
        for (const shape of liveIntermediates) {
            try {
                await kernel.release(shape);
            } catch {
                // Preserve the original Boolean error.
            }
        }
        throw error;
    }
}
