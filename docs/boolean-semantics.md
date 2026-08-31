# Boolean operation semantics

OCCT exposes several operations whose names are easy to treat as interchangeable even though they produce different topology. The TypeScript API keeps the existing names for compatibility and adds semantic names where the distinction matters.

## Binary true union

`OcctKernel.fuse(a, b)` uses `BRepAlgoAPI_Fuse` and performs a Boolean union of two shapes.

```ts
const result = kernel.fuse(a, b);
```

For two overlapping solids intended to become one solid, this is the direct operation.

## N-way true union

For more than two shapes, use the balanced true-union helper:

```ts
import { unionAll } from "occt-wasm/union-all";

const result = unionAll(kernel, shapes);
```

`unionAll()` reduces the inputs through a balanced tree of binary `BRepAlgoAPI_Fuse` operations. Caller-owned inputs are preserved, intermediate results are released eagerly, and the returned handle is caller-owned.

For an arbitrary asynchronous kernel proxy:

```ts
import { unionAllAsync } from "occt-wasm/union-all";

const result = await unionAllAsync(kernelProxy, shapes);
```

For the built-in Worker, prefer the single-RPC API so intermediate handles stay inside the Worker:

```ts
import { OcctWorker } from "occt-wasm/worker";

const worker = await OcctWorker.spawn();
const result = await worker.unionAll(shapes);
```

The older `unionAllPairwise()` and `unionAllPairwiseAsync()` exports remain compatibility aliases. The word "pairwise" describes the implementation strategy, not different Boolean semantics.

## General Fuse

`OcctKernel.fuseAll(shapes)` is historically named but is implemented with OCCT General Fuse (`BRepAlgoAPI_BuilderAlgo`). General Fuse mutually splits all arguments and keeps the resulting cells. It should not be assumed to collapse overlapping solids into one topological solid.

In Worker code, the semantic alias makes that intent explicit:

```ts
const cells = await worker.generalFuse(shapes);
```

`worker.fuseAll(shapes)` remains available and performs the same General-Fuse operation.

General Fuse is useful when the split topology itself is required for downstream cell selection, partitioning, or adjacency workflows.

## Intersection cells

`OcctKernel.intersectionCells(shapes)` also builds on General-Fuse topology, but keeps only regions covered by two or more inputs.

```ts
const overlaps = kernel.intersectionCells(shapes);
```

This is a cell-selection operation, not a replacement for true Boolean union.

## Choosing an operation

| Goal | Operation |
| --- | --- |
| Union two shapes | `kernel.fuse(a, b)` |
| Union many shapes into one intended connected solid | `unionAll(kernel, shapes)` |
| Union many shapes in the built-in Worker | `worker.unionAll(shapes)` |
| Mutually split arguments and preserve all cells | `kernel.fuseAll(shapes)` / `worker.generalFuse(shapes)` |
| Keep only overlap cells | `kernel.intersectionCells(shapes)` |

Do not select an operation only by comparing total volume. A General-Fuse result and a true union can have the same volume while containing different internal topology and different solid counts.
