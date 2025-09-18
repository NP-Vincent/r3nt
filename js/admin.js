import { sdk } from 'https://esm.sh/@farcaster/miniapp-sdk';
import { createPublicClient, http, encodeFunctionData } from 'https://esm.sh/viem@2.9.32';
import { arbitrum } from 'https://esm.sh/viem/chains';
import { CHAIN_ID, RPC_URL, PLATFORM_ADDRESS, PLATFORM_ABI, LISTING_ABI } from './config.js';

const CHAIN_ID_HEX = '0x' + CHAIN_ID.toString(16);
const STATUS_LABELS = ['None', 'Active', 'Completed', 'Cancelled', 'Defaulted'];

const els = {
  contextBar: document.getElementById('contextBar'),
  connect:    document.getElementById('connect'),
  listingId:  document.getElementById('listingId'),
  bookingId:  document.getElementById('bookingId'),
  tenantBps:  document.getElementById('tenantBps'),
  refresh:    document.getElementById('refresh'),
  propose:    document.getElementById('propose'),
  confirm:    document.getElementById('confirm'),
  bookingInfo:document.getElementById('bookingInfo'),
  status:     document.getElementById('status'),
};

const info = (t) => { els.status.textContent = t; };

const pub = createPublicClient({ chain: arbitrum, transport: http(RPC_URL || 'https://arb1.arbitrum.io/rpc') });
let provider;

function formatUsdc(amount) {
  const n = typeof amount === 'bigint' ? amount : BigInt(amount || 0);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const units = abs / 1_000_000n;
  const fraction = abs % 1_000_000n;
  const fractionStr = fraction.toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${units.toString()}${fractionStr ? '.' + fractionStr : ''}`;
}

function formatTimestamp(ts) {
  const value = typeof ts === 'bigint' ? ts : BigInt(ts || 0);
  if (value === 0n) return '-';
  const date = new Date(Number(value) * 1000);
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function formatDuration(seconds) {
  const sec = Number(seconds || 0n);
  if (sec === 0) return '0d';
  if (sec < 86400) {
    const hours = Math.max(1, Math.round(sec / 3600));
    return `${hours}h`;
  }
  const days = sec / 86400;
  if (Number.isInteger(days)) return `${days}d`;
  return `${days.toFixed(1)}d`;
}

async function ensureArbitrum(p) {
  const id = await p.request({ method:'eth_chainId' });
  if (id !== CHAIN_ID_HEX) {
    try {
      await p.request({ method:'wallet_switchEthereumChain', params:[{ chainId: CHAIN_ID_HEX }] });
    } catch {
      await p.request({
        method:'wallet_addEthereumChain',
        params:[{
          chainId: CHAIN_ID_HEX,
          chainName:'Arbitrum One',
          nativeCurrency:{ name:'Ether', symbol:'ETH', decimals:18 },
          rpcUrls:[RPC_URL || 'https://arb1.arbitrum.io/rpc'],
          blockExplorerUrls:['https://arbiscan.io']
        }]
      });
    }
  }
}

function parseListingId() {
  const raw = els.listingId.value.trim();
  if (!/^\d+$/.test(raw)) throw new Error('Listing ID must be a whole number.');
  const id = BigInt(raw);
  if (id === 0n) throw new Error('Listing ID must be at least 1.');
  return id;
}

function parseBookingId() {
  const raw = els.bookingId.value.trim();
  if (!/^\d+$/.test(raw)) throw new Error('Booking ID must be a whole number.');
  return BigInt(raw);
}

function parseTenantBps() {
  const raw = els.tenantBps.value.trim();
  if (!/^\d+$/.test(raw)) throw new Error('Tenant share must be whole basis points.');
  const bps = Number(raw);
  if (bps < 0 || bps > 10_000) throw new Error('Basis points must be between 0 and 10000.');
  return bps;
}

async function getListingAddress(listingId) {
  const addr = await pub.readContract({ address: PLATFORM_ADDRESS, abi: PLATFORM_ABI, functionName:'listingById', args:[listingId] });
  if (!addr || addr === '0x0000000000000000000000000000000000000000') {
    throw new Error('Listing not found.');
  }
  return addr;
}

function renderBookingInfo(listingAddr, bookingId, booking, pending) {
  const statusIndex = Number(booking.status || 0n);
  const statusLabel = STATUS_LABELS[statusIndex] || `Unknown (${statusIndex})`;
  const lines = [
    `Listing: ${listingAddr}`,
    `Booking ID: ${bookingId.toString()}`,
    `Status: ${statusLabel}`,
    `Tenant: ${booking.tenant}`,
    `Range: ${formatTimestamp(booking.start)} → ${formatTimestamp(booking.end)} (${formatDuration((booking.end || 0n) - (booking.start || 0n))})`,
    `Deposit held: ${formatUsdc(booking.deposit)} USDC`,
    `Rent (gross/net): ${formatUsdc(booking.grossRent)} / ${formatUsdc(booking.expectedNetRent)} USDC`,
    `Rent paid so far: ${formatUsdc(booking.rentPaid)} USDC`,
    `Deposit released: ${booking.depositReleased ? 'Yes' : 'No'}${booking.depositReleased ? ` · Tenant share: ${(Number(booking.depositTenantBps || 0n) / 100).toFixed(2)}%` : ''}`,
    pending.exists
      ? `Pending proposal: tenant ${ (Number(pending.tenantBps || 0n) / 100).toFixed(2) }% · proposer ${pending.proposer}`
      : 'Pending proposal: none'
  ];
  els.bookingInfo.innerHTML = lines.map(line => line.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>');
}

async function loadBooking() {
  try {
    const listingId = parseListingId();
    const bookingId = parseBookingId();
    const listingAddr = await getListingAddress(listingId);
    const [bookingRaw, pending] = await Promise.all([
      pub.readContract({ address: listingAddr, abi: LISTING_ABI, functionName:'bookingInfo', args:[bookingId] }),
      pub.readContract({ address: listingAddr, abi: LISTING_ABI, functionName:'pendingDepositSplit', args:[bookingId] })
    ]);

    const booking = {
      tenant: bookingRaw.tenant,
      start: bookingRaw.start,
      end: bookingRaw.end,
      grossRent: bookingRaw.grossRent,
      expectedNetRent: bookingRaw.expectedNetRent,
      rentPaid: bookingRaw.rentPaid,
      deposit: bookingRaw.deposit,
      status: bookingRaw.status,
      depositReleased: bookingRaw.depositReleased,
      depositTenantBps: bookingRaw.depositTenantBps,
    };

    renderBookingInfo(listingAddr, bookingId, booking, pending);
    info('Booking details loaded.');
  } catch (e) {
    els.bookingInfo.textContent = '';
    info(e?.message || 'Unable to load booking details.');
  }
}

els.refresh.onclick = () => { loadBooking(); };

els.propose.onclick = async () => {
  try {
    if (!provider) throw new Error('Connect wallet first.');
    const [from] = await provider.request({ method:'eth_accounts' }) || [];
    if (!from) throw new Error('No wallet account.');
    await ensureArbitrum(provider);
    const listingId = parseListingId();
    const bookingId = parseBookingId();
    const tenantBps = parseTenantBps();
    const listingAddr = await getListingAddress(listingId);

    const data = encodeFunctionData({
      abi: LISTING_ABI,
      functionName: 'proposeDepositSplit',
      args: [bookingId, BigInt(tenantBps)]
    });

    const txHash = await provider.request({ method:'eth_sendTransaction', params:[{ from, to: listingAddr, data }] });
    info(`Proposal tx sent: ${txHash}`);
  } catch (e) {
    info(e?.message || 'Failed to propose split.');
  }
};

els.confirm.onclick = async () => {
  try {
    if (!provider) throw new Error('Connect wallet first.');
    const [from] = await provider.request({ method:'eth_accounts' }) || [];
    if (!from) throw new Error('No wallet account.');
    await ensureArbitrum(provider);
    const listingId = parseListingId();
    const bookingId = parseBookingId();
    const listingAddr = await getListingAddress(listingId);

    const data = encodeFunctionData({ abi: LISTING_ABI, functionName:'confirmDepositSplit', args:[bookingId, '0x'] });
    const txHash = await provider.request({ method:'eth_sendTransaction', params:[{ from, to: listingAddr, data }] });
    info(`Confirm tx sent: ${txHash}`);
  } catch (e) {
    info(e?.message || 'Failed to confirm release.');
  }
};

els.connect.onclick = async () => {
  try {
    provider = await sdk.wallet.getEthereumProvider();
    await provider.request({ method:'eth_requestAccounts' });
    await ensureArbitrum(provider);
    els.connect.textContent = 'Wallet Connected';
    els.connect.style.background = '#10b981';
    els.propose.disabled = false;
    els.confirm.disabled = false;
    info('Wallet ready.');
  } catch (e) {
    info(e?.message || 'Wallet connection failed.');
  }
};

(async () => {
  try { await sdk.actions.ready(); } catch {}
  try {
    const { token } = await sdk.quickAuth.getToken();
    const [, payloadB64] = token.split('.');
    const payloadJson = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    els.contextBar.textContent = `FID: ${payloadJson.sub} · Signed in`;
  } catch {
    els.contextBar.textContent = 'QuickAuth failed. Open inside a Farcaster client.';
    return;
  }
  els.connect.disabled = false;
  els.refresh.disabled = false;
})();
