import { describe, expect, it } from "vitest";
import { OcctError, OcctErrorCode } from "../ts/src/types.ts";
import { createOcctErrorTransferHandler } from "../ts/src/worker-error-transport.ts";

function fakeOriginalHandler() {
    let serializeCalls = 0;
    let deserializeCalls = 0;

    const original = {
        canHandle(_value: unknown): _value is unknown {
            return true;
        },
        serialize(value: unknown): [unknown, Transferable[]] {
            serializeCalls++;
            return [{ delegated: value }, []];
        },
        deserialize(value: unknown): unknown {
            deserializeCalls++;
            throw Object.assign(new TypeError("delegated generic failure"), {
                payload: value,
            });
        },
    };

    return {
        original,
        get serializeCalls() {
            return serializeCalls;
        },
        get deserializeCalls() {
            return deserializeCalls;
        },
    };
}

describe("Worker error transport", () => {
    it("serializes and rehydrates OcctError with structured fields", () => {
        const fake = fakeOriginalHandler();
        const handler = createOcctErrorTransferHandler(fake.original);
        const source = new OcctError(
            "fuse",
            "boolean operation failed",
            OcctErrorCode.BooleanFailed,
        );

        const [wire] = handler.serialize({ value: source });
        expect(fake.serializeCalls).toBe(0);

        let caught: unknown;
        try {
            handler.deserialize(wire);
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(OcctError);
        const error = caught as OcctError;
        expect(error.name).toBe("OcctError");
        expect(error.operation).toBe("fuse");
        expect(error.code).toBe(OcctErrorCode.BooleanFailed);
        expect(error.message).toBe("fuse: boolean operation failed");
        expect(error.stack).toBe(source.stack);
        expect(fake.deserializeCalls).toBe(0);
    });

    it("delegates ordinary errors to the original throw handler", () => {
        const fake = fakeOriginalHandler();
        const handler = createOcctErrorTransferHandler(fake.original);
        const envelope = { value: new TypeError("synthetic generic failure") };

        const [wire] = handler.serialize(envelope);
        expect(fake.serializeCalls).toBe(1);
        expect(wire).toEqual({ delegated: envelope });

        expect(() => handler.deserialize(wire)).toThrow("delegated generic failure");
        expect(fake.deserializeCalls).toBe(1);
    });
});
