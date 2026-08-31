/**
 * Worker entry point — runs inside the Web Worker.
 * Initializes an OcctKernel and exposes it via Comlink.
 * @module
 */

import * as Comlink from "comlink";
import type { InitOptions, ShapeHandle } from "./types.js";
import { OcctKernel } from "./index.js";
import { unionAll } from "./union-all.js";

let kernel: OcctKernel | null = null;

function getKernel(): OcctKernel {
    if (!kernel) throw new Error("OcctKernel not initialized — call init() first");
    return kernel;
}

const api = {
    async init(options?: InitOptions) {
        if (kernel) {
            kernel[Symbol.dispose]();
            kernel = null;
        }
        kernel = await OcctKernel.init(options);
    },
    get kernel() {
        return Comlink.proxy(getKernel());
    },
    unionAll(shapes: ShapeHandle[]) {
        return unionAll(getKernel(), shapes);
    },
    // Backward-compatible algorithm-named alias.
    unionAllPairwise(shapes: ShapeHandle[]) {
        return unionAll(getKernel(), shapes);
    },
};

Comlink.expose(api);
