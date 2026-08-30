# BIMBlock / occt-wasm upstream risk register

This is the short-form companion to the deeper evaluation notes. It separates
confirmed active limitations from historical fixes and BIMBlock integration
requirements.

## Active / current

### A. `fuseAll()` is General Fuse, not a true manufacturing union

**Layer:** occt-wasm API semantics over OCCT

**Status:** confirmed from current source

The TypeScript wrapper currently says `fuseAll()` fuses all shapes "into a single
shape", but the generated facade uses `BRepAlgoAPI_BuilderAlgo`. OCCT General
Fuse keeps the split cells of all arguments. The current `intersectionCells()`
documentation also explicitly states that `fuseAll()` keeps every cell.

**BIMBlock impact:** do not use current `fuseAll()` as the final printable union.
Use the fork's `occt-wasm/union-all` pairwise true-union helper until a dedicated
native `unionAll()` has been validated.

**Upstream action:** candidate API clarification/addition, not evidence of a broken
OCCT kernel. Preserve compatibility with callers that rely on General-Fuse cells.

### B. Rounded-profile Boolean slowdown in OCCT V8.0.1

**Layer:** upstream OCCT

**Status:** accepted correctness/performance trade-off

Issue #244 measured about 11-15% slower Gridfinity-style `cutAll` / General-Fuse
workloads. An attempted sampling optimization recovered speed but failed a native
OCCT periodic-surface test by aliasing against zero-deviation sample points.

**BIMBlock impact:** initial building print geometry is mostly planar, so measure
our workload rather than extrapolating rounded-profile results. Keep CAD work off
the UI thread.

**Do not:** restore the rejected fixed-sampling heuristic.

### C. Zero-length extrusion can escape the JS catch boundary

**Layer:** upstream OCCT/WASM exception boundary

**Status:** documented current limitation in occt-wasm 4.3.2

**BIMBlock impact:** validate all print-derived dimensions before calling OCCT.
Degenerate or collapsed imported elements must be rejected/skipped before
primitive/extrusion construction. Treat the Worker as a crash boundary and
recreate it after an unrecoverable WASM trap.

### D. Single-threaded WASM kernel

**Layer:** build/runtime

**Status:** current design

The build has no pthread flags. `SetRunParallel(true)` on OCCT algorithms therefore
does not turn one browser-WASM Boolean into multicore work.

**BIMBlock impact:** a Worker improves responsiveness and isolation, not per-job
parallel speed. Multiple independent print components could be assigned to
multiple Workers later, but memory use must be measured first.

### E. Face-local tessellation needs a downstream weld for indexed 3MF

**Layer:** integration contract, not necessarily a bug

**Status:** confirmed from `buildMeshData()` source

The tessellator appends the nodes of every `Poly_Triangulation` face independently
and offsets that face's indices. Shared B-Rep edge coordinates are therefore not
necessarily shared by index in the returned mesh.

**BIMBlock impact:** after B-Rep validation and tessellation, position-weld the
manufacturing mesh and check undirected edge multiplicity before writing 3MF.
STL is triangle soup and is less sensitive, but the same validation is still
useful.

See `bimblock-print-mesh-contract.md`.

### F. WASM memory growth and worker lifetime

**Layer:** Emscripten runtime

**Status:** current build configuration

The linker uses 128 MiB initial memory, allows growth, and caps the WASM address
space at 4 GiB.

**BIMBlock impact:** prefer short-lived print Workers or a tightly-scoped reusable
print session. Use `checkpoint()` / `releaseSince()` around each job and terminate
the Worker on traps/OOM. Do not retain OCCT handles in IFCX/game state.

### G. LGPL boundary for the compiled WASM

**Layer:** distribution

**Status:** current license boundary

The project wrapper/build tooling is MIT OR Apache-2.0; compiled OCCT WASM is
LGPL-2.1-only.

**BIMBlock impact:** keep the WASM replaceable/externally loadable and preserve
required notices/compliance. Review this before production distribution.

## Fixed / historical, not current blockers

### H. Same-type `downcast()` arena handle growth (#205 / #208)

Fixed. The old behavior allocated a new handle even when no actual downcast was
needed. BIMBlock still keeps ownership regression tests because this class of
wrapper issue is important for long-running sessions.

### I. Auxiliary-sweep scale failure (#255)

Fixed. Root cause was the wrapper's `curvilinearEquivalence=true` default selecting
an approximate arc-length reparameterization path, not a generic inability of
OCCT to handle architectural scale. Reporter later verified the correction at
large scale on 4.3.0.

### J. Stale Boolean performance baseline (#245)

Fixed. Current `benchmarks/baseline.json` contains the Gridfinity `cutAll` and
`fuseAll` cases that were previously missing.

### K. brepjs #1126 N-way topology/STEP trap

Do **not** attribute this to current occt-wasm. Later brepjs triage showed the trap
on the older `opencascade.js` fallback; the same BREP-loaded input exported
cleanly with current occt-wasm. It remains useful precedent for keeping an
independent pairwise strategy, but it is not a current occt-wasm corruption bug.

## OCCT fork responsibility boundary

The `occt` submodule currently points to official OCCT 8.0.1 plus one
WASM-specific commit that disables `OCC_CONVERT_SIGNALS`, because setjmp/longjmp
signal conversion conflicts with `-fwasm-exceptions` and OS signals are irrelevant
in browser WASM.

That means most modeling/Boolean behavior comes directly from OCCT 8.0.1. The
main occt-wasm-specific risk surface is the facade/API choice, handle arena,
Emscripten marshalling, worker/error transport, and build configuration.

## Current validation gate

PR #1 remains intentionally unmerged. The fork has a complete PR CI workflow, but
GitHub has returned no Actions runs for the fork PR. The architectural WASM tests
and timing probe therefore remain committed expectations, not measured results.

Before BIMBlock integration becomes default, run the probe/test suite and record:

- true-union vs General-Fuse solid counts;
- exact-touch and small-overlap wall/slab behavior;
- dense `cutAll` opening behavior;
- B-Rep validity and closed-form volume error;
- raw vs welded mesh vertex counts;
- boundary/non-manifold edge counts after weld;
- arena handle return-to-baseline;
- timings at representative print scales and model sizes.
