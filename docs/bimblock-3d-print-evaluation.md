# BIMBlock 3D-print kernel evaluation

This fork carries BIMBlock-shaped regression probes for evaluating `occt-wasm`
as the solid-modelling stage behind BIMBlock's 3D-print export.

## Decision

`occt-wasm` remains a strong fit for the **solid stage** of BIMBlock's print
pipeline, but the deeper review found one API-semantic issue that changes the
integration plan: **do not use the current `fuseAll()` as the final manufacturing
union**.

The library provides the operations the current mesh-only MVP is missing:

- B-Rep primitives and transforms
- robust OCCT Boolean `fuse` / `cut` / `common`
- batched `cutAll`
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
        +--> TRUE UNION walls/slabs/columns/roof/base
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

## Important finding: `fuseAll()` is General Fuse, not Boolean union

The public TypeScript documentation currently describes `fuseAll()` as:

> Fuse all shapes in the array into a single shape.

However, the generated C++ implementation uses `BRepAlgoAPI_BuilderAlgo` with all
inputs passed as arguments. In OCCT this is the **General Fuse** algorithm. Its
purpose is to split all input shapes against one another and return the resulting
cells/parts. It is deliberately different from `BRepAlgoAPI_Fuse`, which is the
Boolean union operation.

For overlapping solids this distinction matters even when the total volume looks
correct:

```text
A overlaps B

General Fuse / current fuseAll:
    A-only cell + intersection cell + B-only cell
    -> multiple solids/cells, internal interfaces retained

Boolean union:
    A union B
    -> one connected solid, internal interface removed
```

General Fuse is useful CAD topology, but a 3D-print pipeline must not confuse it
with a watertight manufacturing union. Internal coincident faces/cells are exactly
what BIMBlock is trying to eliminate before 3MF/STL tessellation.

The fork regression test now explicitly distinguishes these semantics with two
overlapping boxes. It expects current `fuseAll()` to retain more than one solid
while a true union made from `fuse()` returns one connected solid with the same
external volume.

### Compatibility-safe direction

Do **not** silently change `fuseAll()` in the fork yet, because downstream callers
may rely on its General-Fuse cell behaviour. A better upstream-compatible API is:

- keep/rename the existing operation as `generalFuseAll()`;
- add a new `unionAll()` implemented with a true n-ary Boolean union;
- deprecate or clarify the ambiguous `fuseAll()` name/documentation.

Until a native `unionAll()` exists, BIMBlock's experiment should use a balanced
tree of the existing binary `fuse()` operation. Balanced pairing avoids a long
left-fold Boolean chain and gives us correct manufacturing semantics without
modifying the OCCT kernel.

## BIMBlock regression probes

`test/bimblock-print.test.ts` now checks four manufacturing properties:

1. **General Fuse versus true union semantics**
   - overlapping boxes have the same external volume;
   - current `fuseAll()` retains multiple General-Fuse cells;
   - balanced binary `fuse()` produces one connected union solid.
2. **Architectural openings**
   - fuse perpendicular walls;
   - cut a full-height door opening;
   - cut a window opening with sill/head material remaining;
   - verify closed-form volume and one-solid topology;
   - tessellate and verify finite mesh coordinates.
3. **Print-scale magnitude stability**
   - run the planar workload at 0.1x, 1x, and 10x;
   - this includes sub-millimetre print features and oversized model parts rather
     than arbitrary CAD magnitudes.
4. **Arena ownership**
   - repeat 25 print jobs behind `checkpoint()` / `releaseSince()`;
   - verify the live shape count returns to baseline after every job.

This test should stay in the fork while BIMBlock evaluates new upstream versions.
It is deliberately small enough to be a regression tripwire, not a performance
benchmark.

`examples/node-cli/bimblock-print-probe.mjs` is a separate timing/semantic probe.
For a four-wall room it now reports both:

- current `fuseAll()` General-Fuse time, volume and solid count; and
- balanced true-union time, volume and solid count.

It then runs `cutAll`, tessellates once, compares against closed-form expected
volumes, and reports arena handle counts before/after checkpoint release at 0.1x,
1x and 10x. This is the workload to compare between upstream versions rather than
relying only on generic CAD benchmarks.

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

### Batch cuts, but use a true union for manufacturing

`cutAll()` is implemented with `BRepAlgoAPI_Cut` and is appropriate for batching
many door/window tools against one base shape.

The current `fuseAll()` is **not** the equivalent union batch primitive. For the
experiment use balanced binary `fuse()` until a native `unionAll()` is introduced
and validated. Do not feed the General-Fuse result directly to the print mesh.

### Overcut openings slightly

Door/window cutters should extend beyond wall thickness rather than ending exactly
coplanar with wall faces. BIMBlock already controls the manufacturing derivative,
so it can add a small print-space overcut margin without altering IFCX geometry.
This avoids avoidable coincident-face/sliver cases in any B-Rep kernel.

### Keep the existing 3MF writer

OCCT is valuable here for B-Rep construction/booleans and tessellation. BIMBlock
already owns the print-product concerns (3MF metadata, scale, naming, Z-up output,
future IFCX revision metadata), so there is no need to make OCCT the file-format
owner.

### BIMBlock Vite integration gap

The current BIMBlock `vite.config.ts` does not yet contain the configuration
recommended by `occt-wasm` for Vite:

```ts
optimizeDeps: {
  exclude: ["occt-wasm"],
},
build: {
  target: "esnext",
},
```

Add those settings only when the experimental backend is integrated. BIMBlock's
TanStack Start app is prerendered and deployed as static client assets, so the
OCCT module must remain client/Worker-only. Prefer an explicit emitted WASM URL or
pre-fetched `ArrayBuffer` passed to the Worker if automatic co-location is not
preserved by the production build; do not let SSR/server evaluation instantiate
the kernel.

## Upstream caveats to track

### 1. `fuseAll()` naming/documentation does not match its General-Fuse implementation

This is the most directly relevant current finding for BIMBlock. The implementation
uses `BRepAlgoAPI_BuilderAlgo`, while the wrapper description reads like Boolean
union. The distinction may be invisible in volume-only tests but is significant
for manufacturing topology.

This fork records it as an upstream-candidate issue rather than changing the public
operation silently. A native, explicitly named `unionAll()` is the preferred fix.

### 2. OCCT V8.0.1 Boolean performance/correctness trade-off

`occt-wasm` issue #244 measured roughly 11-15% slower `cutAll` / General-Fuse
workloads on some rounded Gridfinity profiles after the OCCT V8.0.1 update.

A proposed sampling fast path initially recovered that speed, but native OCCT
GTests exposed a concrete correctness failure: for a periodic circle-on-torus
composition over many periods it reported a maximum deviation around `5.5e-14`
when the true value was `8.0`. The sample pattern aliased against zeros of the
periodic deviation function. Adding another fixed sampling offset cannot prove
flatness for unbounded oscillation.

Therefore the slowdown is not simply an optimization regression; part of the cost
buys correctness. **Do not restore that heuristic in this fork.** The durable
optimization route is to extend OCCT's exact/provably bounded analytic cases, not
to add more fixed samples.

For BIMBlock this is not presently a correctness blocker. Our dominant geometry is
planar boxes/extrusions and orthogonal openings, so the fork probe must measure the
actual building workload before assuming the rounded-profile regression applies.
Worker execution remains mandatory regardless.

### 3. Absolute tolerances and wrapper construction choices matter

Historical issue #255 originally looked like a scale/tolerance problem in
`sweepOriented(SweepMode.Auxiliary)`. The real cause was a wrapper default:
`curvilinearEquivalence=true` selected an arc-length reparameterized approximate
construction that converted planar sides to B-splines. The fix changed the default
to `false` and exposed the remaining options.

The reporter subsequently verified the fix through 100x scale on 4.3.0. This is a
good example of why we should diagnose the operation/configuration before trying
to cure geometry errors by loosening or tightening tolerances.

### 4. Arena handles require deterministic cleanup

Historical issue #205 demonstrated how easy it was for a wrapper operation to
create orphaned handles; that issue is fixed. The current API also exposes
`subShapeCount` / `subShapeHashes` to avoid materialising handles when only counts
or hashes are needed.

Consumers still need deterministic ownership. BIMBlock should use a short-lived
Worker/kernel or checkpoint/release scope per print job. The regression suite now
pins this pattern with repeated checkpoint cleanup.

### 5. Worker errors lose structured `OcctError` fields

The documented Comlink worker path preserves the error message but does not
preserve `instanceof OcctError`, `code`, or `operation` across the boundary. If
BIMBlock needs structured retry logic, classify the error inside the worker and
return a serializable result object.

### 6. Browser feature floor and payload

The published build requires modern WebAssembly features including SIMD, tail
calls, and wasm exceptions. The bundled compressed WASM is several megabytes. Do
not add it to BIMBlock's initial game bundle: dynamically import the worker/kernel
only when 3D Print is used and retain the current non-OCCT fallback path for
unsupported clients until browser coverage is validated.

### 7. License boundary

The repository tooling is MIT OR Apache-2.0, but the README identifies the
compiled WASM output as LGPL-2.1-only. BIMBlock must treat this as a distribution
compliance requirement rather than assuming the npm package is wholly MIT.
Review the required notices/source/replacement mechanism before production
shipping.

## Upstream items that are *not* current blockers

- The large geometric parity report in issue #90 was closed after specific facade
  and downstream adapter problems were isolated and fixed; it is useful history,
  not evidence that current booleans are generally wrong.
- The same-type `downcast()` arena allocation issue (#205) is closed/fixed.
- The auxiliary-sweep scale failure (#255) is closed/fixed and independently
  verified by the reporter on 4.3.0.

At the first evaluation pass, the upstream repository search returned no open
issues and no open pull requests. That point-in-time status does not remove the
need to watch the underlying OCCT fork/submodule and new upstream releases.

## Validation status of this fork

The repository contains CI workflows triggered for pull requests to `main`, but no
workflow runs were returned for this fork's PR head. The new BIMBlock probes have
therefore **not yet executed in GitHub Actions on this fork**. Do not treat the
regression expectations or timing numbers as measured results until Actions are
enabled/run or the same build/test commands are executed in an equivalent
Emscripten environment.

## Recommendation

Proceed with an **experimental OCCT print backend** behind a feature flag, with one
important correction to the original plan:

1. keep the current pure-mesh exporter as fallback;
2. construct scaled Z-up solids in an OCCT Worker;
3. use a **true Boolean union**, not current `fuseAll()`, for connected printable
   components;
4. batch door/window subtraction through `cutAll()`;
5. validate solid count/volume before tessellation;
6. tessellate only once the final printable B-Rep is resolved;
7. feed the resulting triangles into BIMBlock's existing 3MF/STL output code;
8. compare output, handle ownership and timing on representative cottage,
   multi-storey, dense-opening and curved-roof cases before making OCCT default.

The fork regression test and timing probe are the compatibility gates for that
experiment. A native `unionAll()` should be the first wrapper-level enhancement
we consider after those probes are executable.
