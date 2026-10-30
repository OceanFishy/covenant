import type { Page } from "@playwright/test";

/** Real market A borrower, impersonated on the fork. */
export const OWNER = "0xa95d6286853320487cB0897304ad8A210F8D12c4" as const;
export const RPC = "http://127.0.0.1:8545";

/**
 * A stand-in for Rabby: announces itself over EIP-6963 as io.rabby and forwards every request
 * to the fork node, where OWNER is impersonated (so eth_sendTransaction "signs").
 */
export async function installMockRabby(page: Page) {
  await page.addInitScript(
    ({ owner, rpc }) => {
      let id = 0;
      const provider = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          // Like Rabby: no accounts until the site is approved; approval survives reloads.
          if (method === "eth_requestAccounts") {
            sessionStorage.setItem("mockRabbyApproved", "1");
            return [owner];
          }
          if (method === "eth_accounts") return sessionStorage.getItem("mockRabbyApproved") ? [owner] : [];
          if (method === "wallet_switchEthereumChain") return null;
          const res = await fetch(rpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
          });
          const body = await res.json();
          if (body.error) throw Object.assign(new Error(body.error.message), body.error);
          return body.result;
        },
        on() {},
        removeListener() {},
      };
      const detail = Object.freeze({
        info: { uuid: "00000000-0000-4000-8000-000000000000", name: "Rabby Wallet (mock)", icon: "data:,", rdns: "io.rabby" },
        provider,
      });
      const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
    },
    { owner: OWNER, rpc: RPC },
  );
}
