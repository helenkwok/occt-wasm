# BIMBlock print mesh contract

OCCT B-Rep validity and print-mesh validity are related but different checks.
This note defines the handoff BIMBlock should require from `occt-wasm` before
writing an indexed 3MF mesh.

## Why a weld stage is required

`OcctKernel::buildMeshData()` traverses every B-Rep face independently. For each
face it reads that face's `Poly_Triangulation`, appends all of its nodes to the
output position array, and offsets that face's triangle indices by a new
`vertexOffset`.

There is no cross-face vertex deduplication in `buildMeshData()`.

Therefore two adjacent B-Rep faces can share a topological edge while the returned
mesh contains geometrically identical edge coordinates under different vertex
indices. This is normal for a face-oriented CAD tessellator and is useful for
face-local normals/UVs. It is not yet the indexed manufacturing topology BIMBlock
wants to place in 3MF.

STL is less sensitive because STL is triangle soup by design. For 3MF, BIMBlock
should explicitly build a welded position/index mesh.

## Required pipeline

```text
IFCX semantic model
  -> print-space component grouping
  -> true OCCT Boolean union per connected component
  -> cutAll openings
  -> B-Rep validity / volume / component checks
  -> OCCT tessellation
  -> POSITION WELD
  -> triangle/edge manifold validation
  -> 3MF writer
```

The weld is intentionally downstream of OCCT. It should not alter the B-Rep and
should not merge IFCX semantic identities.

## Position-weld policy

For the manufacturing mesh, only positions and triangle indices matter. Face
normal and UV seams do not need to survive into the 3MF geometry mesh.

A first implementation can quantize positions by a small **print-space**
tolerance:

```text
key = round(x / weldTol), round(y / weldTol), round(z / weldTol)
```

and remap all triangle indices to the first vertex for each key.

`weldTol` must be derived from the print recipe / tessellation resolution. Do not
reuse a BIM model tolerance measured in metres and do not hard-code a tolerance
into IFCX. The regression currently uses 1e-4 mm only as a tripwire for a simple
architectural test model; production should calibrate this against the chosen
linear deflection and minimum printable feature.

## Validation after welding

For every non-degenerate triangle, count each undirected welded edge `(min,max)`.
For a closed orientable 2-manifold component:

- edge use count `1` -> boundary / hole in the triangle mesh;
- edge use count `2` -> expected manifold edge;
- edge use count `>2` -> non-manifold edge.

The BIMBlock regression requires:

- zero degenerate triangles after welding;
- zero boundary edges;
- zero non-manifold edges.

This catches a class of failures that B-Rep `isValid()` and positive volume do not
cover: a good CAD solid can still be serialized into an unsuitable indexed mesh
if the face-local triangulations are copied without welding.

## Component grouping matters

Do not require every 3MF object to become one global solid.

Examples:

- connected storey shell -> expected closed manifold component;
- removable roof -> its own closed component;
- separate storeys in model-kit mode -> separate components;
- detached furniture -> separate objects/components unless the user asks to join
  them;
- intentionally connected wall + slab -> one component after true union.

The validator should report manifold status **per intended print component**.

## Robust joining policy

Architectural semantics often contain exact contacts (wall bottom exactly on slab
top). Exact coplanar contact is a legitimate BIM relationship but can be a fragile
manufacturing Boolean input across kernels and model histories.

Because the print model is a derivative, BIMBlock may use a tiny controlled
print-space overlap for components that are intended to become one physical part.
Likewise, opening cutters should overrun the wall by a small margin rather than
terminate exactly on the wall surface.

Those margins belong to `PrintRecipe`, not IFCX.

The regression suite contains both an exact-contact wall/slab case and a 0.02 mm
overlap variant so we can characterize current OCCT behavior before choosing a
production margin.
