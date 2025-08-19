// /js/shared.js
import { createPublicClient, createWalletClient, http, getAddress } from "../vendor/viem-2.x.min.js";
import { arbitrum } from "../vendor/viem-2.x.min.js";
import { RPC_URL, CHAIN_ID } from "./config.js";
import { ready, getFCProvider } from "./farcaster.js";

export const publicClient = createPublicClient({ chain: arbitrum, transport: http(RPC_URL) });

export async function getWalletClient() {
  await ready();
  const provider = await getFCProvider();
  if (!provider) return null;
  const walletClient = createWalletClient({ chain: arbitrum, transport: provider });
  const [addr] = await walletClient.getAddresses();
  return { walletClient, account: getAddress(addr) };
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
  const { request } = await publicClient.simulateContract({
    account,
    address,
    abi,
    functionName,
    args,
  });
  return walletClient.writeContract(request);
}
