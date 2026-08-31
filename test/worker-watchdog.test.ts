import { describe, expect, it, vi } from "vitest";
import {
    OcctWorkerAbortError,
    OcctWorkerTimeoutError,
    runWithWorkerWatchdog,
    type TerminableWorker,
} from "../ts/src/worker-watchdog.ts";

class FakeWorker implements TerminableWorker {
    terminateCalls = 0;
    shouldThrow = false;

    terminate(): void {
        this.terminateCalls++;
        if (this.shouldThrow) throw new Error("synthetic terminate failure");
    }
}

describe("runWithWorkerWatchdog", () => {
    it("passes successful operations through without terminating", async () => {
        const worker = new FakeWorker();
        await expect(runWithWorkerWatchdog(worker, async () => 42)).resolves.toBe(42);
        expect(worker.terminateCalls).toBe(0);
    });

    it("passes normal operation failures through without terminating", async () => {
        const worker = new FakeWorker();
        const failure = new Error("synthetic operation failure");
        await expect(runWithWorkerWatchdog(worker, async () => { throw failure; })).rejects.toBe(failure);
        expect(worker.terminateCalls).toBe(0);
    });

    it("rejects an already-aborted signal before starting work", async () => {
        const worker = new FakeWorker();
        const controller = new AbortController();
        controller.abort();
        let invoked = false;

        await expect(runWithWorkerWatchdog(
            worker,
            async () => {
                invoked = true;
                return 1;
            },
            { signal: controller.signal },
        )).rejects.toBeInstanceOf(OcctWorkerAbortError);

        expect(invoked).toBe(false);
        expect(worker.terminateCalls).toBe(0);
    });

    it("hard-cancels an in-flight operation on AbortSignal", async () => {
        const worker = new FakeWorker();
        const controller = new AbortController();
        let started = false;

        const pending = runWithWorkerWatchdog(
            worker,
            () => {
                started = true;
                return new Promise<number>(() => {});
            },
            { signal: controller.signal },
        );

        await Promise.resolve();
        expect(started).toBe(true);
        controller.abort();

        await expect(pending).rejects.toBeInstanceOf(OcctWorkerAbortError);
        expect(worker.terminateCalls).toBe(1);
        controller.abort();
        expect(worker.terminateCalls).toBe(1);
    });

    it("hard-cancels an in-flight operation on timeout", async () => {
        vi.useFakeTimers();
        try {
            const worker = new FakeWorker();
            const pending = runWithWorkerWatchdog(
                worker,
                () => new Promise<number>(() => {}),
                { timeoutMs: 250 },
            );
            // Attach the rejection handler before advancing fake timers so the
            // watchdog rejection is never briefly considered unhandled.
            const observed = pending.catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(250);
            const caught = await observed;

            expect(caught).toBeInstanceOf(OcctWorkerTimeoutError);
            expect((caught as OcctWorkerTimeoutError).timeoutMs).toBe(250);
            expect(worker.terminateCalls).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("preserves the watchdog error if terminate itself throws", async () => {
        vi.useFakeTimers();
        try {
            const worker = new FakeWorker();
            worker.shouldThrow = true;
            const pending = runWithWorkerWatchdog(
                worker,
                () => new Promise<number>(() => {}),
                { timeoutMs: 10 },
            );
            const observed = pending.catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(10);
            const caught = await observed;

            expect(caught).toBeInstanceOf(OcctWorkerTimeoutError);
            expect(worker.terminateCalls).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("absorbs an operation rejection that arrives after timeout", async () => {
        vi.useFakeTimers();
        try {
            const worker = new FakeWorker();
            let rejectOperation!: (reason?: unknown) => void;
            const operationPromise = new Promise<number>((_resolve, reject) => {
                rejectOperation = reject;
            });
            const pending = runWithWorkerWatchdog(
                worker,
                () => operationPromise,
                { timeoutMs: 10 },
            );
            const observed = pending.catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(10);
            const caught = await observed;
            expect(caught).toBeInstanceOf(OcctWorkerTimeoutError);
            expect(worker.terminateCalls).toBe(1);

            // A real Comlink call may reject after Worker termination. The
            // watchdog's operation chain must already own that rejection so it
            // cannot surface as an unhandled promise rejection.
            rejectOperation(new Error("late operation failure"));
            await Promise.resolve();
            await Promise.resolve();
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects invalid timeout values before starting work", () => {
        const worker = new FakeWorker();
        for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => runWithWorkerWatchdog(worker, async () => 1, { timeoutMs }))
                .toThrow(RangeError);
        }
        expect(worker.terminateCalls).toBe(0);
    });
});
