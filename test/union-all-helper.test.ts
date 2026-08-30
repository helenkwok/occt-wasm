import { describe, expect, it } from "vitest";
import { unionAllPairwise } from "../ts/src/union-all.ts";
import type { OcctKernel, ShapeHandle } from "../ts/src/index.ts";

const shape = (id: number) => id as ShapeHandle;

class FakeKernel {
    next = 100;
    readonly fuseCalls: Array<[ShapeHandle, ShapeHandle]> = [];
    readonly released: ShapeHandle[] = [];
    readonly copied: ShapeHandle[] = [];
    failOnFuseCall: number | undefined;

    fuse(a: ShapeHandle, b: ShapeHandle): ShapeHandle {
        this.fuseCalls.push([a, b]);
        if (this.failOnFuseCall === this.fuseCalls.length) {
            throw new Error(`synthetic fuse failure ${this.fuseCalls.length}`);
        }
        return shape(this.next++);
    }

    copy(input: ShapeHandle): ShapeHandle {
        this.copied.push(input);
        return shape(this.next++);
    }

    release(input: ShapeHandle): void {
        this.released.push(input);
    }
}

function asKernel(fake: FakeKernel): OcctKernel {
    return fake as unknown as OcctKernel;
}

describe("unionAllPairwise ownership", () => {
    it("uses a balanced tree and never releases caller-owned inputs", () => {
        const fake = new FakeKernel();
        const inputs = [1, 2, 3, 4, 5].map(shape);

        const result = unionAllPairwise(asKernel(fake), inputs);

        expect(result).toBe(shape(103));
        expect(fake.fuseCalls).toEqual([
            [shape(1), shape(2)],
            [shape(3), shape(4)],
            [shape(100), shape(101)],
            [shape(102), shape(5)],
        ]);
        expect(fake.released).toEqual([shape(100), shape(101), shape(102)]);
        for (const input of inputs) expect(fake.released).not.toContain(input);
    });

    it("releases helper-owned intermediates when a later fuse fails", () => {
        const fake = new FakeKernel();
        fake.failOnFuseCall = 2;

        expect(() =>
            unionAllPairwise(asKernel(fake), [shape(1), shape(2), shape(3), shape(4)]),
        ).toThrow("synthetic fuse failure 2");

        expect(fake.released).toEqual([shape(100)]);
        expect(fake.released).not.toContain(shape(1));
        expect(fake.released).not.toContain(shape(2));
        expect(fake.released).not.toContain(shape(3));
        expect(fake.released).not.toContain(shape(4));
    });

    it("copies a single input so returned ownership is consistent", () => {
        const fake = new FakeKernel();
        const result = unionAllPairwise(asKernel(fake), [shape(7)]);

        expect(result).toBe(shape(100));
        expect(fake.copied).toEqual([shape(7)]);
        expect(fake.fuseCalls).toHaveLength(0);
        expect(fake.released).toHaveLength(0);
    });

    it("rejects empty input without touching the kernel", () => {
        const fake = new FakeKernel();
        expect(() => unionAllPairwise(asKernel(fake), [])).toThrow(RangeError);
        expect(fake.fuseCalls).toHaveLength(0);
        expect(fake.released).toHaveLength(0);
        expect(fake.copied).toHaveLength(0);
    });
});
