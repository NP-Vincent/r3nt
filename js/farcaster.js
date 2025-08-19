// minimal FC helpers
export async function ready() {
  if (window.sdk?.actions?.ready) await window.sdk.actions.ready();
}

export async function getFCProvider() {
  try { return await window.sdk?.wallet?.getEthereumProvider?.() ?? null; }
  catch { return null; }
}

export function castUrl(fid, castHash) {
  // https://warpcast.com/<fid or username>/<castHash> – adjust if you have a canonical pattern
  return `https://warpcast.com/~/conversations/${castHash}?fid=${fid}`;
}
