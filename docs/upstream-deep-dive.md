# Upstream deep dive

## OCCT responsibility boundary

The `occt` submodule points to official OCCT 8.0.1 plus a WASM-specific change that disables `OCC_CONVERT_SIGNALS`. Signal conversion uses setjmp/longjmp, which conflicts with `-fwasm-exceptions` and is not useful for browser OS-signal handling.

Most Boolean and B-Rep behaviour therefore belongs to OCCT 8.0.1. The `occt-wasm`-specific surface is primarily facade semantics, arena ownership, Emscripten marshalling/build flags, Worker transport and mesh packaging.

## General Fuse vs Boolean union

The current `fuseAll()` implementation uses `BRepAlgoAPI_BuilderAlgo`. The result retains split cells. A binary `fuse()` uses `BRepAlgoAPI_Fuse` and expresses true Boolean union semantics.

For downstream manufacturing callers this distinction should be explicit. A future additive API such as `unionAll()` is safer than changing `fuseAll()` behaviour in place.

## OCCT 8.0.1 Boolean performance trade-off

Issue #244 measured roughly 11-15% slower rounded-profile `cutAll` / General-Fuse workloads after moving to OCCT 8.0.1. An attempted sampling fast path recovered much of the performance but failed a native OCCT correctness test: a periodic case sampled near zero while the actual maximum deviation was 8.0.

The sampling heuristic should not be restored. Exactness is more important than the recovered speed. Consumers should benchmark their own geometry mix.

## Memory and threading

The browser build starts with 128 MiB of WASM memory, allows growth and has a 4 GiB address-space ceiling. It is not a pthread build. `SetRunParallel(true)` inside OCCT does not make one browser-WASM operation multicore.

Workers remain useful for responsiveness and isolation. Multiple concurrent kernels should be measured carefully because each carries a substantial WASM/runtime footprint.

## Historical items

- same-type `downcast()` arena allocation was fixed upstream;
- auxiliary-spine sweep scale sensitivity was fixed by correcting wrapper construction defaults;
- the benchmark baseline now includes real-world Boolean rows that were previously missing;
- a previously reported General-Fuse/STEP trap was later attributed to an older fallback build rather than current `occt-wasm`.
