import { createPublicClient, createWalletClient, http, getAddress } from "../vendor/viem-2.x.min.js";
import { arbitrum } from "../vendor/viem-2.x.min.js"; // ensure the build includes chains
import { RPC_URL, CHAIN_ID } from "./config.js";
import { getFCProvider, ready } from "./farcaster.js";

export const publicClient = createPublicClient({ chain: arbitrum, transport: http(RPC_URL) });

export async function getWalletClient() {
  await ready();
  const provider = await getFCProvider();
  if (!provider) return null;
  const walletClient = createWalletClient({ chain: arbitrum, transport: provider });
  const [account] = await walletClient.getAddresses();
  return { walletClient, account: getAddress(account) };
}
