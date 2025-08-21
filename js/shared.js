// /js/shared.js
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
} from "https://cdn.jsdelivr.net/npm/viem@2.34.0/+esm";
import { arbitrum } from "https://cdn.jsdelivr.net/npm/viem@2.34.0/chains/+esm";
import { RPC_URL, CHAIN_ID, EXPLORER } from "./config.js";
import { sdk, ready, getFCProvider } from "./farcaster.js";
import { showToast } from "./toast.js";

export { sdk, ready, getFCProvider, maybeShowReadOnlyBanner };

export const publicClient = createPublicClient({ chain: arbitrum, transport: http(RPC_URL) });

export async function maybeShowReadOnlyBanner() {
  const provider = await getFCProvider();
  if (!provider && typeof document !== "undefined") {
    if (!document.getElementById("readonly-banner")) {
      const banner = document.createElement("div");
      banner.id = "readonly-banner";
      banner.className = "banner banner--readonly";
      banner.textContent = "Viewing only. Open in Farcaster.";
      const container = document.querySelector("main") ?? document.body;
      container.prepend(banner);
    }
  }
  return provider;
}

export async function ensureArbitrum() {
  await ready();
  const provider = await maybeShowReadOnlyBanner();
  if (!provider) return null;
  const current = parseInt(await provider.request({ method: "eth_chainId" }), 16);
  if (current !== CHAIN_ID) {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
    });
  }
  return provider;
}

export async function getWalletClient() {
  const provider = await ensureArbitrum();
  if (!provider) return null;
  const walletClient = createWalletClient({ chain: arbitrum, transport: provider });
  const [addr] = await walletClient.getAddresses();
  return { walletClient, account: getAddress(addr) };
}

export async function getAddresses() {
  const w = await getWalletClient();
  return w ? { walletClient: w.walletClient, account: w.account } : { walletClient: null, account: null };
}

export async function ensureWritable() {
  const w = await getWalletClient();
  if (!w) throw new Error("No wallet provider (Mini App).");
  const network = await w.walletClient.getChainId();
  if (network !== CHAIN_ID) throw new Error("Wrong network. Switch to Arbitrum One.");
}

export function toUnits(s, decimals = 6) {
  const [int, frac = ""] = String(s).split(".");
  const f = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(int) * (10n ** BigInt(decimals)) + BigInt(f);
}
export function fromUnits(bi, decimals = 6) {
  const s = bi.toString();
  if (s.length <= decimals) return `0.${"0".repeat(decimals - s.length)}${s}`.replace(/0+$/,'').replace(/\.$/,'');
  const i = s.slice(0, -decimals), f = s.slice(-decimals).replace(/0+$/,'');
  return f ? `${i}.${f}` : i;
}

export async function readVar(address, abi, name) {
  return publicClient.readContract({ address, abi, functionName: name });
}
export async function readStruct(address, abi, name, args = []) {
  const out = await publicClient.readContract({ address, abi, functionName: name, args });
  // viem returns nice structs already; keep as-is
  return out;
}

export async function simulateAndWrite({ address, abi, functionName, args }) {
  const w = await getWalletClient();
  if (!w) throw new Error("No wallet");
  const { walletClient, account } = w;
  const toast =
    typeof showToast === "function"
      ? showToast
      : (msg, type) => console.warn(`Toast unavailable [${type}]: ${msg}`);
  try {
    const { request } = await publicClient.simulateContract({
      account,
      address,
      abi,
      functionName,
      args,
    });
    const hash = await walletClient.writeContract(request);
    toast(
      `Sent: <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${hash}</a>`,
      "info"
    );
    publicClient
      .waitForTransactionReceipt({ hash })
      .then((r) => {
        const ok = r.status === "success";
        toast(
          `${ok ? "Confirmed" : "Failed"}: <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${hash}</a>`,
          ok ? "success" : "error"
        );
      })
      .catch((e) => toast(e.shortMessage || e.message, "error"));
    return hash;
  } catch (e) {
    toast(e.shortMessage || e.message, "error");
    throw e;
  }
}
