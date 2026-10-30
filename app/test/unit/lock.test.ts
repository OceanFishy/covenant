import { expect, it } from "vitest";
import { withChainLock } from "../../src/lib/chain";

it("withChainLock never interleaves critical sections, even after a failure", async () => {
  const log: string[] = [];
  const section = (name: string, ms: number, fail = false) =>
    withChainLock(async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}:end`);
      if (fail) throw new Error(name);
    });
  await Promise.allSettled([section("sim", 30, true), section("send", 5), section("sim2", 1)]);
  expect(log).toEqual(["sim:start", "sim:end", "send:start", "send:end", "sim2:start", "sim2:end"]);
});
