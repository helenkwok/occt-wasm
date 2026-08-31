/**
 * Hard-cancel watchdog for long-running Worker operations.
 *
 * OCCT operations execute synchronously inside the browser Worker. Once a
 * modeling call has entered OCCT there is no safe cooperative cancellation
 * hook, so aborting a running operation requires terminating that Worker and
 * creating a fresh one before more CAD work can continue.
 *
 * @module
 */

/** Minimal Worker surface required by the watchdog. */
export interface TerminableWorker {
    terminate(): void;
}

/** Timeout / cancellation controls for {@link runWithWorkerWatchdog}. */
export interface WorkerWatchdogOptions {
    /** AbortSignal used to hard-cancel an operation. */
    signal?: AbortSignal | undefined;
    /** Maximum operation time in milliseconds. Must be finite and > 0. */
    timeoutMs?: number | undefined;
}

/** Raised when an in-flight Worker operation is hard-cancelled by AbortSignal. */
export class OcctWorkerAbortError extends Error {
    constructor() {
        super("OCCT Worker operation aborted; the Worker was terminated and must be recreated");
        this.name = "OcctWorkerAbortError";
    }
}

/** Raised when an in-flight Worker operation exceeds its watchdog timeout. */
export class OcctWorkerTimeoutError extends Error {
    readonly timeoutMs: number;

    constructor(timeoutMs: number) {
        super(`OCCT Worker operation timed out after ${timeoutMs}ms; the Worker was terminated and must be recreated`);
        this.name = "OcctWorkerTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}

function terminateBestEffort(worker: TerminableWorker): void {
    try {
        worker.terminate();
    } catch {
        // Preserve the watchdog error even if the host's terminate hook throws.
    }
}

/**
 * Run one asynchronous Worker operation under an AbortSignal and/or timeout.
 *
 * If cancellation happens after the operation starts, the Worker is terminated
 * because synchronous OCCT code cannot be interrupted safely in place. The
 * caller must create a fresh Worker before issuing additional operations.
 *
 * An already-aborted signal rejects before `operation` is invoked and therefore
 * does not terminate the Worker because no CAD work has started yet.
 *
 * Normal operation failures are passed through unchanged and do not terminate
 * the Worker.
 *
 * @example
 * ```ts
 * import { runWithWorkerWatchdog } from "occt-wasm/worker-watchdog";
 *
 * const result = await runWithWorkerWatchdog(
 *   worker,
 *   () => worker.unionAll(shapes),
 *   { timeoutMs: 10_000, signal: controller.signal },
 * );
 * ```
 */
export function runWithWorkerWatchdog<T>(
    worker: TerminableWorker,
    operation: () => PromiseLike<T>,
    options: WorkerWatchdogOptions = {},
): Promise<T> {
    const { signal, timeoutMs } = options;

    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new RangeError("timeoutMs must be a finite number greater than zero");
    }

    if (signal?.aborted) {
        return Promise.reject(new OcctWorkerAbortError());
    }

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };

        const interrupt = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            terminateBestEffort(worker);
            reject(error);
        };

        const onAbort = () => interrupt(new OcctWorkerAbortError());

        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        if (timeoutMs !== undefined) {
            timer = setTimeout(() => interrupt(new OcctWorkerTimeoutError(timeoutMs)), timeoutMs);
        }

        // Defer invocation one microtask so an AbortSignal fired immediately
        // after registration can prevent the operation from starting at all.
        Promise.resolve()
            .then(() => {
                if (settled) return undefined as T;
                return operation();
            })
            .then(
                (value) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve(value);
                },
                (error: unknown) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(error);
                },
            );
    });
}
