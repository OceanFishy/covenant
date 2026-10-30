import { describe, expect, it } from "vitest";
import { insertBlock, locate, moveBlock, removeBlock } from "../../src/lib/builder/tree";
import type { Block } from "../../src/lib/builder/types";

const g = (id: string): Block => ({ id, type: "guardNoDebt", market: "m" });
const flash = (id: string, children: Block[]): Block => ({
  id,
  type: "flashLoan",
  token: "0x0000000000000000000000000000000000000001",
  amount: { kind: "fixed", value: "1" },
  children,
});
const ids = (list: Block[]): unknown[] => list.map((b) => (b.type === "flashLoan" ? [b.id, ids(b.children)] : b.id));

describe("block tree", () => {
  const base = [g("a"), flash("f", [g("x"), g("y")]), g("b")];

  it("moves down by one and up by one (as the ↓ / ↑ buttons do)", () => {
    // ↓ on "a" (index 0): target index 2 in the original list, adjusted for removal.
    expect(ids(moveBlock(base, "a", null, 2))).toEqual([["f", ["x", "y"]], "a", "b"]);
    expect(ids(moveBlock(base, "b", null, 1))).toEqual(["a", "b", ["f", ["x", "y"]]]);
  });

  it("moves blocks into and out of a flash loan", () => {
    expect(ids(moveBlock(base, "a", "f", 1))).toEqual([["f", ["x", "a", "y"]], "b"]);
    expect(ids(moveBlock(base, "y", null, 0))).toEqual(["y", "a", ["f", ["x"]], "b"]);
  });

  it("never nests a flash loan inside itself", () => {
    expect(moveBlock(base, "f", "f", 0)).toBe(base);
  });

  it("inserts, removes and locates nested blocks", () => {
    const withZ = insertBlock(base, "f", 2, g("z"));
    expect(locate(withZ, "z")).toEqual({ parentId: "f", index: 2 });
    const [without, removed] = removeBlock(withZ, "x");
    expect(removed?.id).toBe("x");
    expect(ids(without)).toEqual(["a", ["f", ["y", "z"]], "b"]);
  });
});
