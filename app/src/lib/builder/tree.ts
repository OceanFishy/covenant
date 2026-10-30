import type { Block } from "./types";

/** Immutable edits on a flow's block tree (top level + flash-loan children). */

export function findBlock(blocks: Block[], id: string): Block | undefined {
  for (const b of blocks) {
    if (b.id === id) return b;
    if (b.type === "flashLoan") {
      const f = findBlock(b.children, id);
      if (f) return f;
    }
  }
  return undefined;
}

export function removeBlock(blocks: Block[], id: string): [Block[], Block | undefined] {
  let removed: Block | undefined;
  const next: Block[] = [];
  for (const b of blocks) {
    if (b.id === id) {
      removed = b;
      continue;
    }
    if (b.type === "flashLoan") {
      const [children, r] = removeBlock(b.children, id);
      if (r) removed = r;
      next.push(r ? { ...b, children } : b);
    } else next.push(b);
  }
  return [next, removed];
}

/** Inserts `block` at `index` of the top level (parentId null) or of a flash loan's children. */
export function insertBlock(blocks: Block[], parentId: string | null, index: number, block: Block): Block[] {
  if (parentId === null) {
    const i = Math.max(0, Math.min(index, blocks.length));
    return [...blocks.slice(0, i), block, ...blocks.slice(i)];
  }
  return blocks.map((b) =>
    b.id === parentId && b.type === "flashLoan"
      ? { ...b, children: insertBlock(b.children, null, index, block) }
      : b.type === "flashLoan"
        ? { ...b, children: insertBlock(b.children, parentId, index, block) }
        : b,
  );
}

/** Moves a block; dropping a flash loan into its own children is ignored. */
export function moveBlock(blocks: Block[], id: string, parentId: string | null, index: number): Block[] {
  if (id === parentId) return blocks;
  const moving = findBlock(blocks, id);
  if (!moving) return blocks;
  if (moving.type === "flashLoan" && parentId && findBlock(moving.children, parentId)) return blocks;
  // Adjust the index when moving down within the same list.
  const siblings = parentId === null ? blocks : (findBlock(blocks, parentId) as Extract<Block, { type: "flashLoan" }>)?.children ?? [];
  const from = siblings.findIndex((b) => b.id === id);
  const [without] = removeBlock(blocks, id);
  return insertBlock(without, parentId, from !== -1 && from < index ? index - 1 : index, moving);
}

export function updateBlock(blocks: Block[], id: string, fn: (b: Block) => Block): Block[] {
  return blocks.map((b) => {
    if (b.id === id) return fn(b);
    if (b.type === "flashLoan") return { ...b, children: updateBlock(b.children, id, fn) };
    return b;
  });
}

/** Parent (null = top level) and index of a block. */
export function locate(blocks: Block[], id: string, parentId: string | null = null): { parentId: string | null; index: number } | undefined {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.id === id) return { parentId, index: i };
    if (b.type === "flashLoan") {
      const l = locate(b.children, id, b.id);
      if (l) return l;
    }
  }
  return undefined;
}
