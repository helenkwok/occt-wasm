import type { OcctKernel } from "./index.js";
import type { ShapeHandle } from "./types.js";

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
export function unionAllPairwise(kernel: OcctKernel, shapes: readonly ShapeHandle[]): ShapeHandle {
    if (shapes.length === 0) {
        throw new RangeError("unionAllPairwise: no shapes provided");
    }
    if (shapes.length === 1) {
        return kernel.copy(shapes[0]!);
    }

    type Entry = { shape: ShapeHandle; owned: boolean };
    let level: Entry[] = shapes.map((shape) => ({ shape, owned: false }));
    const liveIntermediates = new Set<ShapeHandle>();

    const releaseIntermediate = (entry: Entry): void => {
        if (!entry.owned) return;
        kernel.release(entry.shape);
        liveIntermediates.delete(entry.shape);
    };

    try {
        while (level.length > 1) {
            const next: Entry[] = [];

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
        // A Boolean failure should not leave a partially-built union resident in
        // a long-lived kernel. Input handles are excluded from this set.
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
