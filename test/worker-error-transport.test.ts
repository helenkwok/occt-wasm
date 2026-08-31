import * as Comlink from "comlink";
import { describe, expect, it } from "vitest";
import { OcctError, OcctErrorCode } from "../ts/src/types.ts";
import { installOcctErrorTransferHandler } from "../ts/src/worker-error-transport.ts";

installOcctErrorTransferHandler();

interface ThrowingApi {
    failOcct(): void;
    failGeneric(): void;
}

async function withRemote(run: (remote: Comlink.Remote<ThrowingApi>) => Promise<void>): Promise<void> {
    const channel = new MessageChannel();
    Comlink.expose<ThrowingApi>({
        failOcct() {
            throw new OcctError(
                "fuse",
                "boolean operation failed",
                OcctErrorCode.BooleanFailed,
            );
        },
        failGeneric() {
            throw new TypeError("synthetic generic failure");
        },
    }, channel.port1);

    const remote = Comlink.wrap<ThrowingApi>(channel.port2);
    try {
        await run(remote);
    } finally {
        remote[Comlink.releaseProxy]();
        channel.port1.close();
        channel.port2.close();
    }
}

describe("Worker error transport", () => {
    it("rehydrates OcctError with its structured fields", async () => {
        await withRemote(async (remote) => {
            let caught: unknown;
            try {
                await remote.failOcct();
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(OcctError);
            const error = caught as OcctError;
            expect(error.name).toBe("OcctError");
            expect(error.operation).toBe("fuse");
            expect(error.code).toBe(OcctErrorCode.BooleanFailed);
            expect(error.message).toBe("fuse: boolean operation failed");
        });
    });

    it("delegates ordinary errors to Comlink's original throw handler", async () => {
        await withRemote(async (remote) => {
            let caught: unknown;
            try {
                await remote.failGeneric();
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(Error);
            expect(caught).not.toBeInstanceOf(OcctError);
            expect((caught as Error).name).toBe("TypeError");
            expect((caught as Error).message).toBe("synthetic generic failure");
        });
    });
});
