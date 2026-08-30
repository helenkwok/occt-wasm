# Manufacturing print mesh contract

A valid B-Rep and a valid indexed manufacturing mesh are related but distinct requirements.

## Face-local tessellation

`OcctKernel::buildMeshData()` traverses each B-Rep face and appends that face's `Poly_Triangulation` nodes to the output buffer. Triangle indices are offset per face. Shared B-Rep edges can therefore appear as geometrically identical vertices with different mesh indices.

This is useful for face-specific normals and UV seams, but a closed indexed manufacturing mesh should not rely on index identity from the raw tessellation.

## Required post-process

For manufacturing export:

1. copy the tessellated positions and indices out of WASM memory;
2. weld vertices by position using a tolerance appropriate to output scale;
3. remove/reject degenerate triangles created by welding;
4. count undirected edge use after welding;
5. require every edge in a closed component to be used exactly twice.

Interpretation:

- edge use = 1: boundary/hole;
- edge use = 2: manifold;
- edge use > 2: non-manifold.

## Validation order

Prefer validating before and after tessellation:

```text
B-Rep: isValid + expected solid/component count + volume checks
                  |
                  v
             tessellate
                  |
                  v
Mesh: finite coordinates + weld + no degenerates + manifold edge count
```

The weld tolerance is a manufacturing-output policy and should not be written back into the source CAD/semantic model.
