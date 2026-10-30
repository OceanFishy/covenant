import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

// Local-only app (docs/SPEC.md §3): bound to 127.0.0.1, strict CSP in builds, and aggregator
// APIs reached through this local proxy so the 0x API key never enters the browser bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "..", ""); // reads ../.env (repo root)
  const rpcUrl = env.VITE_RPC_URL || "https://ethereum-rpc.publicnode.com";

  const proxy: Record<string, ProxyOptions> = {
    "/api/0x": {
      target: "https://api.0x.org",
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/0x/, ""),
      headers: { "0x-api-key": env.ZEROX_API_KEY ?? "", "0x-version": "v2" },
    },
    // Flashbots Protect's public tx status API (was this transaction sent privately?)
    "/api/flashbots": {
      target: "https://protect.flashbots.net",
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/flashbots/, ""),
    },
    "/api/kyber": {
      target: "https://aggregator-api.kyberswap.com",
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/kyber/, ""),
      headers: { "x-client-id": "covenant" },
    },
  };
  const local = { host: "127.0.0.1", strictPort: true, proxy };

  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${new URL(rpcUrl).origin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  return {
    envDir: "..",
    plugins: [
      react(),
      {
        name: "covenant-csp",
        apply: "build",
        transformIndexHtml: (html) =>
          html.replace("<!--CSP-->", `<meta http-equiv="Content-Security-Policy" content="${csp}" />`),
      },
    ],
    define: {
      __ZEROX_ENABLED__: JSON.stringify(Boolean(env.ZEROX_API_KEY)),
    },
    build: { chunkSizeWarningLimit: 2000 },
    server: { ...local, port: 5173 },
    preview: { ...local, port: 4173 },
  };
});
