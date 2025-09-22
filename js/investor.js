import { sdk } from 'https://esm.sh/@farcaster/miniapp-sdk';
import { createPublicClient, http, encodeFunctionData } from 'https://esm.sh/viem@2.9.32';
import { arbitrum } from 'https://esm.sh/viem/chains';
import { notify, mountNotificationCenter } from './notifications.js';
import { requestWalletSendCalls, isUserRejectedRequestError } from './wallet.js';
import {
  RPC_URL,
  PLATFORM_ADDRESS,
  PLATFORM_ABI,
  LISTING_ABI,
  R3NT_ADDRESS,
  R3NT_ABI,
  APP_VERSION,
} from './config.js';
import createBackController from './back-navigation.js';

const ARBITRUM_HEX = '0xa4b1';
const USDC_SCALAR = 1_000_000n;

const els = {
  connect: document.getElementById('connect'),
  walletAddress: document.getElementById('walletAddress'),
  status: document.getElementById('status'),
  holdingsList: document.getElementById('holdingsList'),
  tokenisationDashboard: document.getElementById('tokenisationDashboard'),
  rentDashboard: document.getElementById('rentDashboard'),
};

mountNotificationCenter(document.getElementById('notificationTray'), { role: 'investor' });

const pub = createPublicClient({ chain: arbitrum, transport: http(RPC_URL || 'https://arb1.arbitrum.io/rpc') });
let provider;
const state = { account: null, holdings: [] };
const backButton = document.querySelector('[data-back-button]');
const backController = createBackController({ sdk, button: backButton });
backController.update();

function isHexAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function formatUsdc(amount) {
  const value = typeof amount === 'bigint' ? amount : BigInt(amount || 0);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const units = abs / USDC_SCALAR;
  const fraction = (abs % USDC_SCALAR).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${units.toString()}${fraction ? '.' + fraction : ''}`;
}

function shortAddress(addr) {
  if (typeof addr !== 'string') return '';
  if (!addr.startsWith('0x') || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function percentOf(numerator, denominator) {
  const num = typeof numerator === 'bigint' ? numerator : BigInt(numerator || 0);
  const den = typeof denominator === 'bigint' ? denominator : BigInt(denominator || 0);
  if (den <= 0n) return null;
  const scaled = (num * 10000n) / den;
  return Number(scaled) / 100;
}

function setVersionBadge() {
  const badge = document.querySelector('[data-version]');
  if (badge) badge.textContent = `Build ${APP_VERSION}`;
}

function setStatus(message) {
  if (els.status) {
    els.status.textContent = message;
  }
}

async function ensureArbitrum(p) {
  const id = await p.request({ method: 'eth_chainId' });
  if (id !== ARBITRUM_HEX) {
    try {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ARBITRUM_HEX }] });
    } catch {
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: ARBITRUM_HEX,
            chainName: 'Arbitrum One',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://arb1.arbitrum.io/rpc'],
            blockExplorerUrls: ['https://arbiscan.io'],
          },
        ],
      });
    }
  }
}

async function loadListingBookings(listingAddress, account) {
  const entries = [];
  let nextId = 0n;
  try {
    const raw = await pub.readContract({ address: listingAddress, abi: LISTING_ABI, functionName: 'nextBookingId' });
    nextId = typeof raw === 'bigint' ? raw : BigInt(raw || 0);
  } catch (err) {
    console.error('Failed to fetch nextBookingId', listingAddress, err);
    return entries;
  }
  const max = Number(nextId > 0n ? nextId : 0n);
  if (!Number.isFinite(max) || max <= 0) {
    return entries;
  }
  for (let id = 1; id <= max; id++) {
    const bookingId = BigInt(id);
    let info;
    try {
      info = await pub.readContract({ address: listingAddress, abi: LISTING_ABI, functionName: 'bookingInfo', args: [bookingId] });
    } catch (err) {
      console.warn('Skipping booking', listingAddress, id, err);
      continue;
    }
    if (!info) continue;
    const tokenised = Boolean(info.tokenised);
    const totalSqmu = BigInt(info.totalSqmu ?? 0);
    const soldSqmu = BigInt(info.soldSqmu ?? 0);
    const pricePerSqmu = BigInt(info.pricePerSqmu ?? 0);
    const feeBps = Number(info.feeBps ?? 0);
    let balance = 0n;
    let claimable = 0n;
    try {
      balance = await pub.readContract({ address: R3NT_ADDRESS, abi: R3NT_ABI, functionName: 'balanceOf', args: [account, bookingId] });
    } catch {}
    if (tokenised && balance > 0n) {
      try {
        claimable = await pub.readContract({ address: listingAddress, abi: LISTING_ABI, functionName: 'previewClaim', args: [bookingId, account] });
      } catch {}
    }
    entries.push({
      listingAddress,
      bookingId: id,
      tokenised,
      totalSqmu,
      soldSqmu,
      pricePerSqmu,
      feeBps,
      balance,
      claimable,
    });
  }
  return entries;
}

function renderHoldings(entries) {
  const container = els.holdingsList;
  if (!container) return;
  container.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No SQMU-R holdings yet.';
    container.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const card = document.createElement('div');
    card.className = 'data-card';

    const header = document.createElement('div');
    header.className = 'data-card-header';
    const title = document.createElement('strong');
    title.textContent = shortAddress(entry.listingAddress);
    header.appendChild(title);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `Booking #${entry.bookingId}`;
    header.appendChild(badge);
    card.appendChild(header);

    const metrics = document.createElement('div');
    metrics.className = 'metric-row';

    const balanceMetric = document.createElement('div');
    balanceMetric.className = 'metric';
    balanceMetric.innerHTML = '<label>Balance</label>';
    const balanceValue = document.createElement('span');
    balanceValue.textContent = entry.balance.toString();
    balanceMetric.appendChild(balanceValue);
    metrics.appendChild(balanceMetric);

    const claimMetric = document.createElement('div');
    claimMetric.className = 'metric';
    claimMetric.innerHTML = '<label>Claimable rent</label>';
    const claimValue = document.createElement('span');
    claimValue.textContent = `${formatUsdc(entry.claimable)} USDC`;
    if (entry.claimable > 0n) claimValue.classList.add('highlight');
    claimMetric.appendChild(claimValue);
    metrics.appendChild(claimMetric);

    const sharePct = percentOf(entry.balance, entry.totalSqmu);
    if (sharePct != null) {
      const shareMetric = document.createElement('div');
      shareMetric.className = 'metric';
      shareMetric.innerHTML = '<label>Share</label>';
      const shareValue = document.createElement('span');
      shareValue.textContent = `${sharePct.toFixed(2)}%`;
      shareMetric.appendChild(shareValue);
      metrics.appendChild(shareMetric);
    }

    card.appendChild(metrics);

    const progress = document.createElement('div');
    progress.className = 'token-progress';
    const soldPct = percentOf(entry.soldSqmu, entry.totalSqmu);
    if (soldPct != null) {
      progress.textContent = `Sold ${entry.soldSqmu.toString()} of ${entry.totalSqmu.toString()} SQMU-R (${soldPct.toFixed(2)}%)`;
    } else {
      progress.textContent = 'Not tokenised yet.';
    }
    card.appendChild(progress);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const claimBtn = document.createElement('button');
    claimBtn.className = 'secondary';
    claimBtn.textContent = entry.claimable > 0n ? `Claim ${formatUsdc(entry.claimable)} USDC` : 'No rent to claim';
    claimBtn.disabled = entry.claimable === 0n;
    claimBtn.onclick = () => claimRent(entry, claimBtn);
    actions.appendChild(claimBtn);
    card.appendChild(actions);

    container.appendChild(card);
  }
}

function renderTokenisation(entries) {
  const container = els.tokenisationDashboard;
  if (!container) return;
  container.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No tokenised bookings yet.';
    container.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const card = document.createElement('div');
    card.className = 'data-card';

    const header = document.createElement('div');
    header.className = 'data-card-header';
    const title = document.createElement('strong');
    title.textContent = shortAddress(entry.listingAddress);
    header.appendChild(title);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `Booking #${entry.bookingId}`;
    header.appendChild(badge);
    card.appendChild(header);

    const metrics = document.createElement('div');
    metrics.className = 'metric-row';

    const supplyMetric = document.createElement('div');
    supplyMetric.className = 'metric';
    supplyMetric.innerHTML = '<label>Supply</label>';
    const supplyValue = document.createElement('span');
    supplyValue.textContent = `${entry.soldSqmu.toString()} / ${entry.totalSqmu.toString()} SQMU-R`;
    supplyMetric.appendChild(supplyValue);
    metrics.appendChild(supplyMetric);

    const priceMetric = document.createElement('div');
    priceMetric.className = 'metric';
    priceMetric.innerHTML = '<label>Price per SQMU</label>';
    const priceValue = document.createElement('span');
    priceValue.textContent = `${formatUsdc(entry.pricePerSqmu)} USDC`;
    priceMetric.appendChild(priceValue);
    metrics.appendChild(priceMetric);

    const feeMetric = document.createElement('div');
    feeMetric.className = 'metric';
    feeMetric.innerHTML = '<label>Platform fee</label>';
    const feeValue = document.createElement('span');
    feeValue.textContent = `${entry.feeBps} bps`;
    feeMetric.appendChild(feeValue);
    metrics.appendChild(feeMetric);

    card.appendChild(metrics);
    container.appendChild(card);
  }
}

function renderRent(entries) {
  const container = els.rentDashboard;
  if (!container) return;
  container.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No claimable rent yet.';
    container.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const card = document.createElement('div');
    card.className = 'data-card';

    const header = document.createElement('div');
    header.className = 'data-card-header';
    const title = document.createElement('strong');
    title.textContent = shortAddress(entry.listingAddress);
    header.appendChild(title);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `Booking #${entry.bookingId}`;
    header.appendChild(badge);
    card.appendChild(header);

    const metric = document.createElement('div');
    metric.className = 'metric-row';
    const amountMetric = document.createElement('div');
    amountMetric.className = 'metric';
    amountMetric.innerHTML = '<label>Claimable rent</label>';
    const amountValue = document.createElement('span');
    amountValue.textContent = `${formatUsdc(entry.claimable)} USDC`;
    amountValue.classList.add('highlight');
    amountMetric.appendChild(amountValue);
    metric.appendChild(amountMetric);
    card.appendChild(metric);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const claimBtn = document.createElement('button');
    claimBtn.textContent = `Claim ${formatUsdc(entry.claimable)} USDC`;
    claimBtn.onclick = () => claimRent(entry, claimBtn);
    actions.appendChild(claimBtn);
    card.appendChild(actions);

    container.appendChild(card);
  }
}

function renderDashboards(results) {
  const holdings = results.filter((entry) => entry.balance > 0n);
  const tokenised = results.filter((entry) => entry.tokenised);
  const rentClaims = holdings.filter((entry) => entry.claimable > 0n);

  renderHoldings(holdings);
  renderTokenisation(tokenised);
  renderRent(rentClaims);
}

async function loadInvestorData(account) {
  setStatus('Loading investor data…');
  try {
    const cleaned = await fetchPlatformListings();
    if (!cleaned.length) {
      renderDashboards([]);
      setStatus('No listings available yet.');
      notify({ message: 'No listings available yet.', variant: 'info', role: 'investor', timeout: 5000 });
      return;
    }
    const allEntries = [];
    for (const listing of cleaned) {
      const bookings = await loadListingBookings(listing, account);
      allEntries.push(...bookings);
    }
    state.holdings = allEntries;
    renderDashboards(allEntries);
    setStatus(`Loaded ${allEntries.length} booking${allEntries.length === 1 ? '' : 's'}.`);
    notify({ message: 'Investor data refreshed.', variant: 'success', role: 'investor', timeout: 5000 });
  } catch (err) {
    console.error('Failed to load investor data', err);
    setStatus('Unable to load investor data.');
    notify({ message: err?.message || 'Unable to load investor data.', variant: 'error', role: 'investor', timeout: 6000 });
  }
}

async function fetchPlatformListings() {
  try {
    const addresses = await pub.readContract({ address: PLATFORM_ADDRESS, abi: PLATFORM_ABI, functionName: 'allListings' });
    const cleaned = Array.isArray(addresses)
      ? addresses.filter((addr) => isHexAddress(addr) && !/^0x0+$/i.test(addr))
      : [];
    if (cleaned.length) {
      return Array.from(new Set(cleaned));
    }
  } catch (err) {
    console.warn('allListings() not available, falling back to listingCount/listingById', err);
  }

  try {
    const countRaw = await pub.readContract({ address: PLATFORM_ADDRESS, abi: PLATFORM_ABI, functionName: 'listingCount' });
    const total = typeof countRaw === 'bigint' ? countRaw : BigInt(countRaw || 0);
    const max = Number(total);
    if (!Number.isFinite(max) || max <= 0) {
      return [];
    }
    const lookups = [];
    for (let id = 1; id <= max; id++) {
      lookups.push(
        pub
          .readContract({ address: PLATFORM_ADDRESS, abi: PLATFORM_ABI, functionName: 'listingById', args: [BigInt(id)] })
          .catch((err) => {
            console.warn('listingById lookup failed', id, err);
            return null;
          })
      );
    }
    const results = await Promise.all(lookups);
    const cleaned = results.filter((addr) => isHexAddress(addr) && !/^0x0+$/i.test(addr));
    return Array.from(new Set(cleaned));
  } catch (err) {
    console.error('Fallback listing enumeration failed', err);
    throw err;
  }
}

async function claimRent(entry, button) {
  try {
    if (!state.account) {
      notify({ message: 'Connect your wallet before claiming rent.', variant: 'warning', role: 'investor', timeout: 5000 });
      return;
    }
    const p = provider || (provider = await sdk.wallet.getEthereumProvider());
    const [from] = (await p.request({ method: 'eth_accounts' })) || [];
    if (!from) throw new Error('No wallet account connected.');
    await ensureArbitrum(p);
    const bookingId = BigInt(entry.bookingId);
    const data = encodeFunctionData({ abi: LISTING_ABI, functionName: 'claim', args: [bookingId] });
    const call = { to: entry.listingAddress, data };
    if (button) button.disabled = true;
    setStatus('Submitting claim transaction…');
    let walletSendUnsupported = false;
    try {
      const { unsupported } = await requestWalletSendCalls(p, {
        calls: [call],
        from,
        chainId: ARBITRUM_HEX,
      });
      walletSendUnsupported = unsupported;
    } catch (err) {
      if (isUserRejectedRequestError(err)) {
        setStatus('Claim cancelled by user.');
        notify({ message: 'Claim cancelled by user.', variant: 'warning', role: 'investor', timeout: 5000 });
        return;
      }
      throw err;
    }

    if (walletSendUnsupported) {
      await p.request({ method: 'eth_sendTransaction', params: [{ from, to: entry.listingAddress, data }] });
    }
    setStatus('Claim transaction sent.');
    notify({ message: 'Claim transaction sent.', variant: 'success', role: 'investor', timeout: 6000 });
    await loadInvestorData(state.account);
  } catch (err) {
    console.error('Claim failed', err);
    if (isUserRejectedRequestError(err)) {
      setStatus('Claim cancelled by user.');
      notify({ message: 'Claim cancelled by user.', variant: 'warning', role: 'investor', timeout: 5000 });
      return;
    }
    setStatus(err?.message || 'Claim failed.');
    notify({ message: err?.message || 'Claim failed.', variant: 'error', role: 'investor', timeout: 6000 });
  } finally {
    if (button) button.disabled = false;
  }
}

function boot() {
  setVersionBadge();
  setStatus('Connect your wallet to begin.');
}

els.connect?.addEventListener('click', async () => {
  try {
    provider = await sdk.wallet.getEthereumProvider();
    await provider.request({ method: 'eth_requestAccounts' });
    await ensureArbitrum(provider);
    const [addr] = (await provider.request({ method: 'eth_accounts' })) || [];
    if (!addr) throw new Error('No wallet account connected.');
    state.account = addr;
    els.connect.textContent = 'Wallet Connected';
    els.connect.style.background = '#10b981';
    if (els.walletAddress) {
      els.walletAddress.textContent = `Connected: ${shortAddress(addr)}`;
    }
    notify({ message: 'Wallet connected.', variant: 'success', role: 'investor', timeout: 5000 });
    await loadInvestorData(addr);
  } catch (err) {
    console.error('Wallet connection failed', err);
    state.account = null;
    setStatus(err?.message || 'Wallet connection failed.');
    notify({ message: err?.message || 'Wallet connection failed.', variant: 'error', role: 'investor', timeout: 6000 });
  }
});

(function init() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

(async () => {
  try { await sdk.actions.ready(); } catch {}
})();
