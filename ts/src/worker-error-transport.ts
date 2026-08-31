import * as Comlink from "comlink";
import { OcctError, OcctErrorCode } from "./types.js";

/** Serialized payload carried by Comlink's existing `throw` transfer channel. */
interface SerializedOcctError {
    readonly __occtWasmOcctError: true;
    readonly operation: string;
    readonly code: OcctErrorCode;
    /** Error detail without the `operation: ` prefix added by OcctError. */
    readonly message: string;
    readonly stack?: string | undefined;
}

interface ThrownEnvelope {
    readonly value?: unknown;
}

let installed = false;

function errorDetail(error: OcctError): string {
    const prefix = `${error.operation}: `;
    return error.message.startsWith(prefix)
        ? error.message.slice(prefix.length)
        : error.message;
}

function isSerializedOcctError(value: unknown): value is SerializedOcctError {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<SerializedOcctError>;
    return candidate.__occtWasmOcctError === true
        && typeof candidate.operation === "string"
        && typeof candidate.code === "string"
        && typeof candidate.message === "string";
}

/**
 * Extend Comlink's built-in thrown-error transfer handler so {@link OcctError}
 * keeps its structured `operation` and `code` fields across a Worker boundary.
 *
 * Comlink 4.x intentionally serializes ordinary Error objects as only
 * `{ message, name, stack }`. We preserve that behaviour for every non-OCCT
 * exception by delegating to the handler that was installed before this one.
 *
 * This function must run in both realms: before `Comlink.expose()` in the
 * Worker and before `Comlink.wrap()` on the caller side. It is idempotent per
 * JavaScript realm.
 */
export function installOcctErrorTransferHandler(): void {
    if (installed) return;

    const original = Comlink.transferHandlers.get("throw");
    if (!original) {
        throw new Error("Comlink throw transfer handler is unavailable");
    }

    const handler: Comlink.TransferHandler<unknown, unknown> = {
        canHandle(value): value is unknown {
            return original.canHandle(value);
        },
        serialize(value) {
            const thrown = value as ThrownEnvelope;
            if (thrown.value instanceof OcctError) {
                const error = thrown.value;
                const serialized: SerializedOcctError = {
                    __occtWasmOcctError: true,
                    operation: error.operation,
                    code: error.code,
                    message: errorDetail(error),
                    stack: error.stack,
                };
                return [serialized, []];
            }
            return original.serialize(value);
        },
        deserialize(value) {
            if (isSerializedOcctError(value)) {
                const error = new OcctError(value.operation, value.message, value.code);
                if (value.stack !== undefined) error.stack = value.stack;
                throw error;
            }
            return original.deserialize(value);
        },
    };

    Comlink.transferHandlers.set("throw", handler);
    installed = true;
}
