import { describe, expect, it } from "vitest";
import {
    unionAll,
    unionAllAsync,
    unionAllPairwise,
    unionAllPairwiseAsync,
    type AsyncUnionKernel,
} from "../ts/src/union-all.ts";
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

class FakeAsyncKernel implements AsyncUnionKernel {
    next = 100;
    readonly fuseCalls: Array<[ShapeHandle, ShapeHandle]> = [];
    readonly released: ShapeHandle[] = [];
    readonly copied: ShapeHandle[] = [];
    failOnFuseCall: number | undefined;

    async fuse(a: ShapeHandle, b: ShapeHandle): Promise<ShapeHandle> {
        this.fuseCalls.push([a, b]);
        if (this.failOnFuseCall === this.fuseCalls.length) {
            throw new Error(`synthetic async fuse failure ${this.fuseCalls.length}`);
        }
        return shape(this.next++);
    }

    async copy(input: ShapeHandle): Promise<ShapeHandle> {
        this.copied.push(input);
        return shape(this.next++);
    }

    async release(input: ShapeHandle): Promise<void> {
        this.released.push(input);
    }
}

function asKernel(fake: FakeKernel): OcctKernel {
    return fake as unknown as OcctKernel;
}

describe("unionAll ownership", () => {
    it("uses a balanced tree and never releases caller-owned inputs", () => {
        const fake = new FakeKernel();
        const inputs = [1, 2, 3, 4, 5].map(shape);

        const result = unionAll(asKernel(fake), inputs);

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
            unionAll(asKernel(fake), [shape(1), shape(2), shape(3), shape(4)]),
        ).toThrow("synthetic fuse failure 2");

        expect(fake.released).toEqual([shape(100)]);
        expect(fake.released).not.toContain(shape(1));
        expect(fake.released).not.toContain(shape(2));
        expect(fake.released).not.toContain(shape(3));
        expect(fake.released).not.toContain(shape(4));
    });

    it("copies a single input so returned ownership is consistent", () => {
        const fake = new FakeKernel();
        const result = unionAll(asKernel(fake), [shape(7)]);

        expect(result).toBe(shape(100));
        expect(fake.copied).toEqual([shape(7)]);
        expect(fake.fuseCalls).toHaveLength(0);
        expect(fake.released).toHaveLength(0);
    });

    it("rejects empty input without touching the kernel", () => {
        const fake = new FakeKernel();
        expect(() => unionAll(asKernel(fake), [])).toThrow(RangeError);
        expect(fake.fuseCalls).toHaveLength(0);
        expect(fake.released).toHaveLength(0);
        expect(fake.copied).toHaveLength(0);
    });

    it("retains the algorithm-named compatibility alias", () => {
        expect(unionAllPairwise).toBe(unionAll);
    });
});

describe("unionAllAsync ownership", () => {
    it("preserves the same balanced pairing and input ownership over async RPC", async () => {
        const fake = new FakeAsyncKernel();
        const inputs = [1, 2, 3, 4, 5].map(shape);

        const result = await unionAllAsync(fake, inputs);

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

    it("cleans up helper-owned async intermediates after a failure", async () => {
        const fake = new FakeAsyncKernel();
        fake.failOnFuseCall = 2;

        await expect(
            unionAllAsync(fake, [shape(1), shape(2), shape(3), shape(4)]),
        ).rejects.toThrow("synthetic async fuse failure 2");

        expect(fake.released).toEqual([shape(100)]);
        expect(fake.released).not.toContain(shape(1));
        expect(fake.released).not.toContain(shape(2));
        expect(fake.released).not.toContain(shape(3));
        expect(fake.released).not.toContain(shape(4));
    });

    it("copies one input and rejects empty async input", async () => {
        const fake = new FakeAsyncKernel();
        await expect(unionAllAsync(fake, [shape(9)])).resolves.toBe(shape(100));
        expect(fake.copied).toEqual([shape(9)]);

        const untouched = new FakeAsyncKernel();
        await expect(unionAllAsync(untouched, [])).rejects.toThrow(RangeError);
        expect(untouched.fuseCalls).toHaveLength(0);
        expect(untouched.released).toHaveLength(0);
        expect(untouched.copied).toHaveLength(0);
    });

    it("retains the algorithm-named async compatibility alias", () => {
        expect(unionAllPairwiseAsync).toBe(unionAllAsync);
    });
});
