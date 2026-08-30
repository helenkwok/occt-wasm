# Manufacturing solid evaluation

This branch evaluates `occt-wasm` as a solid-modelling stage for browser-based manufacturing and 3D-print workflows.

## Main finding

`OcctKernel.fuseAll()` is backed by `BRepAlgoAPI_BuilderAlgo`, OCCT General Fuse. General Fuse mutually splits arguments and preserves the resulting cells. That is useful CAD topology, but it is not equivalent to a manufacturing union that removes internal overlap interfaces.

For a printable connected component, prefer a true Boolean union before tessellation.

The branch therefore adds `unionAllPairwise()` as a compatibility-safe helper rather than changing `fuseAll()` semantics.

```text
semantic/model input
        |
        v
manufacturing recipe
(units, scale, scope, feature rules)
        |
        v
OCCT B-Rep solids
        |
        +--> true union per intended connected component
        +--> batch cuts for holes/openings
        |
        v
validate B-Rep topology and volume
        |
        v
tessellate once
        |
        v
position weld + mesh manifold validation
        |
        v
3MF / STL / downstream manufacturing format
```

## Units and tolerances

Use one explicit model unit throughout the manufacturing stage. Millimetres are a practical choice for slicer-facing work. Regression coverage should include more than one magnitude because many OCCT tolerances are absolute.

Avoid zero or collapsed dimensions before entering OCCT. Degenerate input is better rejected or repaired at the recipe boundary than delegated to a low-level kernel call.

## Worker boundary

Run heavy B-Rep work in a dedicated Web Worker. The published browser WASM is single-threaded, so a Worker primarily provides UI responsiveness, memory/lifetime isolation and a recovery boundary after a fatal WASM trap.

A short-lived kernel per manufacturing job is simpler to reason about than retaining shape handles in application state.

## Connected components

Do not indiscriminately union every object in a scene. Union shapes that are intended to become one physical component. Keep intentionally disconnected/removable pieces separate and export them as separate components where the target format supports it.

## Distribution

The TypeScript/build tooling is MIT OR Apache-2.0, while the compiled OCCT WASM has LGPL-2.1 obligations. Downstream applications should preserve a replaceable WASM boundary and review notice/source requirements before production distribution.
