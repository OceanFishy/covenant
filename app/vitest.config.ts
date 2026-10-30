import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __ZEROX_ENABLED__: "false" },
  test: { fileParallelism: false },
});
