// /js/support.js
import {
  CHAIN_ID,
  RPC_URL,
  R3NT_ADDRESS,
  FACTORY_ADDRESS,
  USDC_ADDRESS,
  PLATFORM_ADDRESS,
  FEE_BPS,
  VIEW_PASS_SECONDS,
  APP_DOMAIN,
  EXPLORER,
} from "./config.js";
import { showToast } from "./toast.js";

function link(addr) {
  if (!addr || addr.startsWith("0x") === false) return `<code>${addr}</code>`;
  return `<a class="link mono" href="${EXPLORER}/address/${addr}" target="_blank" rel="noopener">${addr}</a>`;
}

function secondsToHms(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function renderSupport() {
  const el = document.getElementById("support");
  el.innerHTML = `
    <div class="card">
      <h3>Environment</h3>
      <ul>
        <li>Network: <b>${CHAIN_ID === 42161 ? "Arbitrum One (42161)" : `Chain ${CHAIN_ID}`}</b></li>
        <li>RPC (reads only): <span class="mono">${RPC_URL}</span></li>
        <li>App Origin: <span class="mono">${APP_DOMAIN}</span></li>
      </ul>
    </div>

    <div class="card">
      <h3>Contract Addresses</h3>
      <ul>
        <li>r3nt (proxy): ${link(R3NT_ADDRESS)}</li>
        <li>ListingFactory (proxy): ${link(FACTORY_ADDRESS)}</li>
        <li>USDC (canonical): ${link(USDC_ADDRESS)}</li>
        <li>Platform / Owner: ${link(PLATFORM_ADDRESS)}</li>
      </ul>
      <p class="muted">If any address is <i>PLACEHOLDER</i>, update <code>/js/config.js</code> after deployment.</p>
    </div>

    <div class="card">
      <h3>Fees & Timers</h3>
      <ul>
        <li>Platform fee: <b>${FEE_BPS / 100}%</b> (split 0.5% tenant + 0.5% landlord)</li>
        <li>View Pass window: <b>${secondsToHms(VIEW_PASS_SECONDS)}</b></li>
      </ul>
    </div>

    <div class="card">
      <h3>Troubleshooting</h3>
      <ul>
        <li><b>The provider does not support the requested method</b><br/>
          You attempted a read via the Mini App provider. Fix: route <i>all</i> reads through the public RPC.</li>
        <li><b>Insufficient funds</b><br/>
          The connected wallet lacks ETH for gas on Arbitrum. Ask user to top up ~0.0002–0.0005 ETH.</li>
        <li><b>fee mismatch</b><br/>
          Quotes or fee basis changed. Re-read fees immediately before booking and retry.</li>
        <li><b>Allowance too low</b><br/>
          Approve the required USDC amount to the r3nt contract, then retry.</li>
        <li><b>Wrong network</b><br/>
          Ensure wallet is on Arbitrum One (Chain ID 42161).</li>
      </ul>
    </div>

    <div class="card">
      <h3>Best Practices</h3>
      <ul>
        <li>Call <code>sdk.actions.ready()</code> on page load.</li>
        <li>Use <code>sdk.wallet.getEthereumProvider()</code> for writes only.</li>
        <li>All reads via <code>${RPC_URL}</code>; never mix eth_call through provider.</li>
        <li>Always <code>eth_estimateGas</code> before writes; show “Insufficient funds” clearly.</li>
      </ul>
    </div>
  `;
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    renderSupport();
  } catch (e) {
    console.error("renderSupport", e);
    showToast("Failed to render support page", "error");
  }
});
