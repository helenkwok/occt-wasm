# Upstream risk register

| Area | Status | Relevance | Mitigation |
| --- | --- | --- | --- |
| `fuseAll()` General Fuse semantics | Known compatibility concern | High when callers expect a true N-way union | Preserve `fuseAll()` behavior; prefer canonical `unionAll()` / `worker.unionAll()` for true union and `worker.generalFuse()` when split-cell topology is intentional |
| Rounded-profile Boolean slowdown on OCCT 8.0.1 | Accepted trade-off | Medium; workload-dependent | Benchmark representative geometry; do not restore unsafe sampling shortcut |
| Single-threaded browser WASM | Current architecture | Medium | Run kernel off-main-thread; measure before using multiple Workers |
| WASM memory growth to 4 GiB ceiling | Current architecture | Medium/high for large models | Scope jobs, release handles deterministically, terminate Worker after job/trap/OOM |
| Zero/collapsed geometry exception boundary | Current limitation | Medium | Validate dimensions before OCCT calls; treat Worker as fatal-trap boundary |
| Face-local tessellation duplicates seam positions | Current mesh packaging | High for indexed print meshes | Position weld and validate manifold edges before export |
| Arena handle ownership | Managed but important | Medium | Use checkpoints/`releaseSince`, short-lived jobs and helper cleanup tests |
| Worker error serialization loses rich class identity | Current transport concern | Low/medium | Classify errors inside Worker into structured-cloneable results |
| Compiled WASM LGPL-2.1 obligations | Current distribution requirement | High for production | Preserve replaceable WASM boundary and review notices/source obligations |
| Same-type `downcast()` allocation | Fixed | Low | Keep regression coverage when updating upstream |
| Auxiliary sweep scale defect | Fixed | Low | Retain multi-scale regressions |
| Old benchmark baseline blind spot | Fixed | Low | Keep real-world Boolean benchmark rows current |

## Update policy

Review this register when changing the OCCT submodule, Emscripten version, Boolean facade, tessellation code or memory build flags.
