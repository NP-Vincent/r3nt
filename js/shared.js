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

function ensureDebugConsole() {
  let el = document.getElementById("debug-console");
  if (!el) {
    el = document.createElement("div");
    el.id = "debug-console";
    Object.assign(el.style, {
      position: "fixed",
      bottom: "0",
      left: "0",
      width: "100%",
      maxHeight: "40%",
      overflowY: "auto",
      background: "rgba(0,0,0,0.8)",
      color: "#f00",
      font: "12px monospace",
      zIndex: "9999",
      padding: "4px",
      whiteSpace: "pre-wrap",
    });
    (document.body || document.documentElement).appendChild(el);
  }
  return el;
}

export function debugLog(msg) {
  const el = ensureDebugConsole();
  const t = new Date().toISOString();
  const text = msg && (msg.stack || msg.message) ? msg.stack || msg.message : String(msg);
  console.error(msg);
  const div = document.createElement("div");
  div.textContent = `[${t}] ${text}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

window.addEventListener("error", (e) => debugLog(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => debugLog(e.reason));

export { sdk, ready, getFCProvider, debugLog };

export const publicClient = createPublicClient({ chain: arbitrum, transport: http(RPC_URL) });

export async function getWalletClient() {
  await ready();
  const provider = await getFCProvider();
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
