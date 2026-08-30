# BIMBlock 3D-print kernel evaluation

This fork carries a BIMBlock-shaped regression probe for evaluating `occt-wasm`
as the solid-modelling stage behind BIMBlock's 3D-print export.

## Decision

`occt-wasm` is a strong fit for the **solid stage** of BIMBlock's print pipeline.
It provides the operations the current mesh-only MVP is missing:

- B-Rep primitives and transforms
- robust OCCT boolean `fuse` / `cut` / `common`
- `fuseAll` / `cutAll` for larger batches
- shape healing and validity-oriented CAD operations
- tessellation to indexed triangles after booleans
- STL / STEP / BREP I/O
- browser Web Worker support

The intended architecture is:

```text
IFCX semantic model
        |
        v
BIMBlock print recipe
(scale, scope, min feature, base, roof)
        |
        v
millimetre Z-up OCCT solids
        |
        +--> fuse walls/slabs/columns/roof/base
        +--> cut door/window openings
        |
        v
single printable B-Rep / solid set
        |
        v
occt-wasm tessellation
        |
        v
BIMBlock 3MF / STL writer
```

IFCX remains the source of truth. OCCT receives only a temporary manufacturing
derivative and should never become BIMBlock's semantic model.

## BIMBlock regression probe

`test/bimblock-print.test.ts` models a small architectural workload rather than
a generic CAD primitive:

1. create two perpendicular walls;
2. fuse the overlapping wall solids;
3. cut a full-height door opening;
4. cut a window opening with sill/head material remaining;
5. verify the resulting volume and single-solid topology;
6. tessellate the final B-Rep and verify finite mesh coordinates;
7. repeat at a 10x magnitude to catch obvious absolute-tolerance sensitivity.

This test should stay in the fork while BIMBlock evaluates new upstream versions.
It is deliberately small enough to be a regression tripwire, not a performance
benchmark.

## Integration guidance for BIMBlock

### Use print millimetres as OCCT model units

Run BIMBlock's architectural scale conversion before constructing OCCT shapes.
For example, a real 110 mm wall at 1:100 becomes a 1.1 mm print wall before it
enters the kernel. This aligns with slicers and keeps the print pipeline's unit
contract explicit.

### Run the kernel in a Worker

CAD booleans can block the UI. Load `occt-wasm` lazily only after the user opens
3D Print and execute the solid work in a dedicated Worker. Dispose/terminate the
kernel when the export job finishes; do not retain shape handles in the live game
state.

### Prefer batch booleans

For a building/storey export, group compatible solids and use `fuseAll` / `cutAll`
where practical instead of a long JS loop of pairwise operations. Keep openings
as cutting tools and resolve them before tessellation.

### Keep the existing 3MF writer

OCCT is valuable here for B-Rep construction/booleans and tessellation. BIMBlock
already owns the print-product concerns (3MF metadata, scale, naming, Z-up output,
future IFCX revision metadata), so there is no need to make OCCT the file-format
owner.

## Upstream caveats to track

### 1. OCCT V8.0.1 boolean performance trade-off

`occt-wasm` documented an 11-15% regression on some real-world rounded-profile
`cutAll` / `fuseAll` workloads after moving to the safer OCCT V8.0.1
`GeomLib_CheckCurveOnSurface` path (occt-wasm issue #244). An attempted sampling
fast path restored the speed but failed an OCCT correctness test because periodic
geometry could alias the samples. The project correctly rejected that shortcut.

For BIMBlock this is **not a correctness blocker**. It means print export should
stay off the main thread, and we should benchmark larger building/storey cases
before assuming interactive boolean latency.

### 2. Absolute tolerances matter

A historical `sweepOriented` issue (#255) showed scale-sensitive errors caused by
a wrapper construction choice and documented OCCT's absolute sweep tolerance
defaults. That specific defect was fixed in 4.0.0 and pinned by tests, but the
lesson remains useful: regression tests should include at least two model
magnitudes, and BIMBlock should use one explicit unit system in the print kernel.

### 3. Arena handles require deterministic cleanup

The API is arena based. Historical issue #205 demonstrated how easy it was for a
wrapper operation to create orphaned handles; that issue is fixed, but consumers
still need deterministic cleanup. A short-lived Worker/kernel per print job gives
BIMBlock a simple ownership boundary.

### 4. Worker errors lose structured `OcctError` fields

The documented Comlink worker path preserves the error message but does not
preserve `instanceof OcctError`, `code`, or `operation` across the boundary. If
BIMBlock needs structured retry logic, classify the error inside the worker and
return a serializable result object.

### 5. Browser feature floor and payload

The published build requires modern WebAssembly features including SIMD, tail
calls, and wasm exceptions. The WASM payload is roughly 4.5 MB brotli. Do not add
it to BIMBlock's initial game bundle: dynamically import the worker/kernel only
when 3D Print is used and retain the current non-OCCT fallback path for unsupported
clients until browser coverage is validated.

### 6. License boundary

The repository tooling is MIT OR Apache-2.0, but the README identifies the
compiled WASM output as LGPL-2.1-only. BIMBlock must treat this as a distribution
compliance requirement rather than assuming the npm package is wholly MIT.
Review the required notices/source/replacement mechanism before production
shipping.

## Upstream items that are *not* current blockers

- The large geometric parity report in issue #90 was closed after specific facade
  and downstream adapter problems were isolated and fixed; it is useful history,
  not evidence that current 4.3.x booleans are generally wrong.
- The same-type `downcast()` arena allocation issue (#205) is closed/fixed.
- The auxiliary-sweep scale failure (#255) is closed/fixed and verified by the
  reporter on 4.3.0.

## Recommendation

Proceed with an **experimental OCCT print backend** behind a feature flag:

1. keep the current pure-mesh exporter as fallback;
2. construct scaled Z-up solids in an OCCT Worker;
3. fuse structural/architectural components;
4. cut openings in B-Rep;
5. tessellate only once the final printable solid is resolved;
6. feed the resulting triangles into BIMBlock's existing 3MF/STL output code;
7. compare output and timing on representative cottage, multi-storey, and dense
   opening cases before making OCCT the default.

The fork regression test is the first guard for that experiment.
