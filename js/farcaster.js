// minimal FC helpers
import { sdk as farcasterSdk } from "https://esm.sh/@farcaster/miniapp-sdk";

const globalSdk = typeof window !== "undefined" ? window.sdk : undefined;
export const sdk = globalSdk ?? farcasterSdk;
if (typeof window !== "undefined" && !window.sdk) window.sdk = sdk;

let isReady = false;
export async function ready() {
  if (isReady) return;
  if (sdk?.actions?.ready) await sdk.actions.ready();
  isReady = true;
}

export async function getFCProvider() {
  try { return await sdk.wallet?.getEthereumProvider?.() ?? null; }
  catch { return null; }
}

export function castUrl(fid, castHash) {
  // https://warpcast.com/<fid or username>/<castHash> – adjust if you have a canonical pattern
  return `https://warpcast.com/~/conversations/${castHash}?fid=${fid}`;
}
