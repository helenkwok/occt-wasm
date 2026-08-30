# BIMBlock upstream deep dive

This note records the second-pass investigation of `occt-wasm` for BIMBlock's
3D-print solid pipeline. It separates confirmed current behavior from historical
or differently-attributed problems so later upgrades do not repeat the same
triage.

## 1. `fuseAll()` is intentionally General Fuse

This is confirmed in three independent places:

1. `xtask/src/codegen/config.rs` generates `fuseAll()` with
   `BRepAlgoAPI_BuilderAlgo`.
2. the generated `facade/generated/kernel.cpp` uses `SetArguments()` on that
   builder and returns `builder.Shape()`.
3. the TypeScript comment for `intersectionCells()` explicitly contrasts it with
   `fuseAll()` by saying `fuseAll()` keeps every cell.

OCCT documents General Fuse as a split-parts operation: the result is a compound
containing the split parts/images of the arguments. It is the substrate used to
construct later Boolean results, not itself equivalent to Boolean union.

The original `fuseAll` implementation entered occt-wasm as part of the brepjs
KernelAdapter coverage work. Later brepjs documentation also calls its default
N-way strategy General Fuse. This makes the behavior look deliberate for adapter
compatibility, not an accidental recent regression.

### Manufacturing implication

For BIMBlock, General Fuse is not the final operation we want before tessellation.
With overlapping solids it can preserve multiple cells/internal interfaces while
still reporting the correct total external volume. A volume-only regression test
is therefore insufficient.

The fork adds `occt-wasm/union-all` with `unionAllPairwise()` as an experimental,
compatibility-safe true-union route. It uses a balanced tree of the existing
binary `BRepAlgoAPI_Fuse` binding and owns/releases only the intermediates it
creates.

## 2. The brepjs #1126 corruption must not be misattributed

brepjs issue #1126 is useful history because it demonstrates why an independent
pairwise Boolean path can be valuable, but later triage corrected the kernel
attribution.

The failing case was a spiral stair composed of an annular tread and a Frenet
swept handrail. Through the N-way General-Fuse path the older
`opencascade.js`/`brepjs-opencascade` fallback produced topology that passed
several in-memory checks but caused a STEP writer out-of-bounds trap.

The same BREP-loaded inputs exported cleanly with current `occt-wasm`; brepjs PR
#1352 explicitly corrected its regression-test comment to say the trap was
specific to the opencascade.js fallback.

Therefore:

- do **not** cite #1126 as evidence that current `occt-wasm` General Fuse corrupts
  BIMBlock geometry;
- do keep the pairwise strategy as algorithmic diversity and a true-union path;
- add BIMBlock-native regressions before claiming either strategy is safe for our
  workload.

## 3. The OCCT V8.0.1 performance regression bought correctness

occt-wasm #244 measured approximately 11-15% slower Gridfinity-style Boolean
workloads after adopting the OCCT V8.0.1 `GeomLib_CheckCurveOnSurface` behavior.
The synthetic box/sphere Boolean benchmarks were mostly flat; the cost appeared
on rounded profiles.

A proposed fast sampling path recovered the lost speed but failed an OCCT native
test. A periodic analytic case had true maximum deviation `8.0`, while the fixed
sample pattern aliased against zeros and reported about `5.5e-14`.

This is a strong negative result: adding another fixed sample offset is not a
sound optimization for an unbounded periodic function. The safe performance
route is to widen exact/provably-bounded analytic cases, not restore the sampling
heuristic.

For BIMBlock, whose initial print geometry is mostly planar walls, slabs, columns,
opening boxes and simple roofs, the correct action is to benchmark our workload.
Do not assume the rounded Gridfinity slowdown transfers directly.

## 4. Benchmark infrastructure problems were fixed

occt-wasm #245 noted that its old performance baseline was stale and did not even
contain the Gridfinity `cutAll` / `fuseAll` rows, making the regression gate too
weak.

The current `benchmarks/baseline.json` does contain both rows. Treat #245 as a
fixed historical testing gap, not a reason to distrust every current benchmark.
The BIMBlock probe remains separate because upstream's benchmark corpus does not
measure architectural print topology or our true-union strategy.

## 5. Memory model: Worker isolation is still the right boundary

The current browser build links with:

- `INITIAL_MEMORY=134217728` (128 MiB)
- `ALLOW_MEMORY_GROWTH=1`
- `MAXIMUM_MEMORY=4294967296` (4 GiB address-space ceiling)
- no pthread build flags

So `SetRunParallel(true)` on OCCT algorithms should not be interpreted as browser
multicore execution. The published WASM is single-threaded. A Worker is important
because it prevents CAD work from freezing BIMBlock's render/input loop, not
because it turns a single Boolean into a parallel operation.

For BIMBlock this suggests a simple lifetime model:

```text
open 3D Print
    -> lazy-load one OCCT Worker
    -> checkpoint / build / union / cut / validate / tessellate
    -> transfer mesh result back
    -> releaseSince(checkpoint)
    -> terminate Worker after export (or after a short reusable session)
```

A fresh Worker is also the cleanest recovery boundary if a future uncatchable WASM
trap or browser OOM occurs.

## 6. Arena ownership: historical bug fixed, consumer discipline still required

occt-wasm #205 showed that same-type `downcast()` used to allocate another arena
handle, which caused linear leaks in downstream operation/cast loops. The fix was
merged in #208.

The lesson for BIMBlock is not that current `downcast` leaks; it is that handle
ownership needs explicit regression coverage. The fork now repeats 25 print jobs
inside `checkpoint()` / `releaseSince()` and requires the live shape count to
return to baseline on every iteration.

`unionAllPairwise()` separately tests its own failure cleanup so a failed mid-tree
Boolean cannot strand helper-created intermediate handles.

## 7. Print-specific geometry policy

BIMBlock should not blindly union every exported element into one shape.

### Union connected manufacturing components

Examples:

- one connected storey shell: union
- walls + slab that intentionally form one print piece: union
- detached furniture: separate 3MF object unless explicitly joined
- removable roof: separate component
- different storeys in model-kit mode: separate components

`unionAllPairwise()` therefore returns whatever topology a true Boolean union
produces; BIMBlock remains responsible for deciding the component grouping.

### Avoid merely coplanar construction where possible

Manufacturing geometry is a derivative, so it may add tiny robust-Boolean margins
without changing IFCX truth:

- opening cutters should overrun wall thickness rather than terminate coplanar;
- components meant to become one printed piece may use a tiny join overlap instead
  of relying on exact face-touching coincidence;
- the margin must be expressed in print millimetres and be well below visible
  print resolution.

The exact margin should be measured, not guessed into the semantic model.

## 8. Proposed native `unionAll()` upstream shape

Do not redefine the existing `fuseAll()` silently. Its General-Fuse behavior is
established and may be relied on by adapter callers.

Preferred additive API:

```text
generalFuseAll(shapes)  -> existing BRepAlgoAPI_BuilderAlgo semantics
unionAll(shapes)        -> true Boolean union semantics
fuseAll(shapes)         -> retain for compatibility; document/deprecate ambiguity
```

A native `unionAll()` should be compared against the fork's pairwise helper. One
possible implementation is an N-way `BRepAlgoAPI_Fuse` configured with argument
and tool lists; another is an OCCT CellsBuilder selection that explicitly keeps
the union cells and removes internal boundaries. We should not choose between
these from API names alone: build both prototypes if necessary and grade their
result topology and failure behavior.

### Acceptance tests before adding the native method

1. **Overlapping boxes**
   - closed-form union volume
   - one solid
   - no internal coincident interface
2. **Perpendicular architectural walls**
   - closed-form union volume
   - one solid
3. **Closed four-wall room**
   - one connected shell solid before openings
4. **Dense openings**
   - `cutAll` after union retains expected volume/solid count
5. **Touching/coplanar joints**
   - compare exact touch and small print-space overlap
6. **Disconnected inputs**
   - preserve the expected number of components rather than manufacturing a fake
     bridge
7. **Scale sweep**
   - representative print magnitudes (currently 0.1x / 1x / 10x)
8. **Arena cleanup**
   - no live-handle growth over repeated jobs
9. **Tessellation**
   - finite vertices/indices and expected closed components
10. **Timing**
    - compare General Fuse, pairwise true union, and any native union candidate

Only after these pass should a raw C++/Embind `unionAll()` be proposed upstream.

## 9. Current fork validation limitation

The fork contains pull-request CI workflows, but GitHub currently returns no
workflow runs for PR #1. The new WASM regression cases are committed but have not
executed on this fork.

The pure TypeScript ownership test for `unionAllPairwise()` is also committed, but
should not be described as passing until the test command is run.

This is why PR #1 remains open and unmerged.
