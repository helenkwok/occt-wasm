/**
 * Worker entry point — runs inside the Web Worker.
 * Initializes an OcctKernel and exposes it via Comlink.
 * @module
 */

import * as Comlink from "comlink";
import type { InitOptions, ShapeHandle } from "./types.js";
import { OcctKernel } from "./index.js";
import { unionAll } from "./union-all.js";
import { installOcctErrorTransferHandler } from "./worker-error-transport.js";

installOcctErrorTransferHandler();

let kernel: OcctKernel | null = null;

function getKernel(): OcctKernel {
    if (!kernel) throw new Error("OcctKernel not initialized — call init() first");
    return kernel;
}

function disposeKernel(): void {
    if (!kernel) return;
    kernel[Symbol.dispose]();
    kernel = null;
}

const api = {
    async init(options?: InitOptions) {
        disposeKernel();
        kernel = await OcctKernel.init(options);
    },
    dispose() {
        disposeKernel();
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
    [Comlink.finalizer]() {
        disposeKernel();
    },
};

Comlink.expose(api);
