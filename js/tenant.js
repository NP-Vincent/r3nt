import { sdk } from 'https://esm.sh/@farcaster/miniapp-sdk';
import { encodeFunctionData, erc20Abi, createPublicClient, http } from 'https://esm.sh/viem@2.9.32';
import { arbitrum } from 'https://esm.sh/viem/chains';
import { bytes32ToCastHash, buildFarcasterCastUrl, geohashToLatLon } from './tools.js';
import { requestWalletSendCalls, isUserRejectedRequestError } from './wallet.js';
import { notify, mountNotificationCenter } from './notifications.js';
import createBackController from './back-navigation.js';
import { ListingCard, BookingCard, TokenisationCard } from './ui/cards.js';
import { el } from './ui/dom.js';
import {
  RPC_URL,
  REGISTRY_ADDRESS,
  REGISTRY_ABI,
  PLATFORM_ADDRESS,
  PLATFORM_ABI,
  LISTING_ABI,
  USDC_ADDRESS,
  APP_VERSION,
} from './config.js';

(async () => { try { await sdk.actions.ready(); } catch {} setTimeout(()=>{ try { sdk.actions.ready(); } catch {} }, 800); })();

const els = {
  connect: document.getElementById('connect'),
  buy: document.getElementById('buy'),
  addr: document.getElementById('address'),
  status: document.getElementById('status'),
  listings: document.getElementById('listings'),
  start: document.getElementById('startDate'),
  end: document.getElementById('endDate'),
  period: document.getElementById('paymentPeriod'),
  confirmBooking: document.getElementById('confirmBooking'),
  summary: {
    container: document.getElementById('bookingSummary'),
    title: document.querySelector('[data-summary-title]'),
    subtitle: document.querySelector('[data-summary-subtitle]'),
    nights: document.querySelector('[data-summary-nights]'),
    deposit: document.querySelector('[data-summary-deposit]'),
    rent: document.querySelector('[data-summary-rent]'),
    installment: document.querySelector('[data-summary-installment]'),
    total: document.querySelector('[data-summary-total]'),
    notice: document.querySelector('[data-summary-notice]'),
  },
  bookings: {
    section: document.getElementById('bookingsSection'),
    list: document.getElementById('bookingsList'),
    status: document.querySelector('[data-bookings-status]'),
    refresh: document.getElementById('refreshBookings'),
  },
};
const tokenProposalHost = document.getElementById('tokenProposalPanel');

if (els.connect && !els.connect.dataset.defaultLabel) {
  const initialLabel = (els.connect.textContent || '').trim();
  if (initialLabel) {
    els.connect.dataset.defaultLabel = initialLabel;
  }
}

let selectedListing = null;
let selectedCard = null;
let selectedListingTitle = '';
let pub;
let viewPassPrice;
let viewPassDuration;
let configLoading;
let viewPassRequired = false;
let hasActiveViewPass = false;
let connectedAccount = null;
let bookingsLoading = null;
let lastBookingsAccount = '';
let bookingsRendered = false;

const listingInfoCache = new Map();
const bookingRecords = new Map();
const listingRecords = new Map();
let activeTokenProposalKey = null;

mountNotificationCenter(document.getElementById('notificationTray'), { role: 'tenant' });

const backButton = document.querySelector('[data-back-button]');
const backController = createBackController({ sdk, button: backButton });
let selectionBackEntry = null;
backController.update();

if (els.period && !els.period.value) {
  els.period.value = 'month';
}

if (els.start) {
  els.start.addEventListener('change', updateSummary);
  els.start.addEventListener('input', updateSummary);
}
if (els.end) {
  els.end.addEventListener('change', updateSummary);
  els.end.addEventListener('input', updateSummary);
}
if (els.period) {
  els.period.addEventListener('change', updateSummary);
}

updateSummary();

const setVersionBadge = () => {
  const badge = document.querySelector('[data-version]');
  if (badge) badge.textContent = `Build ${APP_VERSION}`;
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setVersionBadge);
} else {
  setVersionBadge();
}

const ARBITRUM_HEX = '0xa4b1';           // 42161
const USDC_SCALAR = 1_000_000n;
const SECONDS_PER_DAY = 86_400n;
const PERIOD_OPTIONS = {
  day: { label: 'Daily', value: 1n, days: 1n },
  week: { label: 'Weekly', value: 2n, days: 7n },
  month: { label: 'Monthly', value: 3n, days: 30n },
};

function getPeriodKeyFromValue(periodValue) {
  let value;
  try {
    value = typeof periodValue === 'bigint' ? periodValue : BigInt(periodValue || 0);
  } catch {
    value = 0n;
  }
  for (const [key, info] of Object.entries(PERIOD_OPTIONS)) {
    if (info.value === value) {
      return key;
    }
  }
  return '';
}
const MULTICALL_CHUNK = 120;
const BOOKING_STATUS_META = {
  0: { label: 'Pending', className: 'pending' },
  1: { label: 'Active', className: 'active' },
  2: { label: 'Completed', className: 'completed' },
  3: { label: 'Cancelled', className: 'cancelled' },
  4: { label: 'Defaulted', className: 'defaulted' },
};
const BOOKING_PERIOD_LABELS = {
  0: 'Unspecified',
  1: 'Daily',
  2: 'Weekly',
  3: 'Monthly',
};
const BOOKING_INFO_FIELDS = [
  'tenant',
  'start',
  'end',
  'grossRent',
  'expectedNetRent',
  'rentPaid',
  'deposit',
  'status',
  'tokenised',
  'totalSqmu',
  'soldSqmu',
  'pricePerSqmu',
  'feeBps',
  'period',
  'proposer',
  'accRentPerSqmu',
  'landlordAccrued',
  'depositReleased',
  'depositTenantBps',
  'calendarReleased',
];
const TOKENISATION_VIEW_FIELDS = [
  'exists',
  'proposer',
  'totalSqmu',
  'pricePerSqmu',
  'feeBps',
  'period',
];

const supportsViewPassPurchase = PLATFORM_ABI.some(
  (item) => item?.type === 'function' && item?.name === 'buyViewPass'
);

function formatUsdc(amount) {
  const value = typeof amount === 'bigint' ? amount : BigInt(amount || 0);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const units = abs / USDC_SCALAR;
  const fraction = (abs % USDC_SCALAR).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${units.toString()}${fraction ? '.' + fraction : ''}`;
}

function decodeBytes32ToString(value, precision) {
  const hex = typeof value === 'string' ? value : '';
  if (!hex || hex === '0x' || /^0x0+$/i.test(hex)) {
    return '';
  }
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (!Number.isFinite(code) || code <= 0) break;
    out += String.fromCharCode(code);
  }
  const limit = typeof precision === 'number' && Number.isFinite(precision) ? precision : undefined;
  if (limit && limit > 0 && out.length > limit) {
    return out.slice(0, limit);
  }
  return out;
}

function formatDuration(seconds) {
  const value = typeof seconds === 'bigint' ? seconds : BigInt(seconds || 0);
  if (value <= 0n) return 'None';
  const totalSeconds = Number(value);
  if (!Number.isFinite(totalSeconds)) return `${value} sec`;
  const days = Math.floor(totalSeconds / 86400);
  const remainder = totalSeconds % 86400;
  if (days > 0 && remainder === 0) {
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (days > 0) {
    const hours = Math.round(remainder / 3600);
    if (hours === 0) {
      return `${days} day${days === 1 ? '' : 's'}`;
    }
    return `${days} day${days === 1 ? '' : 's'} ${hours} h`;
  }
  const hoursOnly = Math.max(1, Math.round(totalSeconds / 3600));
  return `${hoursOnly} hour${hoursOnly === 1 ? '' : 's'}`;
}

function formatBps(value) {
  const bps = toBigInt(value, 0n);
  const numeric = Number(bps);
  if (!Number.isFinite(numeric)) {
    return `${bps.toString()} bps`;
  }
  const percent = (numeric / 100).toFixed(2).replace(/\.0+$/, '').replace(/\.([1-9])0$/, '.$1');
  return `${percent}% (${bps.toString()} bps)`;
}

function formatSqmu(value) {
  const amount = toBigInt(value, 0n);
  const numeric = Number(amount);
  if (Number.isFinite(numeric) && Math.abs(numeric) <= Number.MAX_SAFE_INTEGER) {
    return numeric.toLocaleString('en-US');
  }
  return amount.toString();
}

function formatTimestamp(seconds) {
  const value = typeof seconds === 'bigint' ? seconds : BigInt(seconds || 0);
  if (value <= 0n) return '';
  let asNumber;
  try {
    asNumber = Number(value);
  } catch {
    return `Unix ${value}`;
  }
  if (!Number.isFinite(asNumber) || Number.isNaN(asNumber)) {
    return `Unix ${value}`;
  }
  const date = new Date(asNumber * 1000);
  if (Number.isNaN(date.getTime())) {
    return `Unix ${value}`;
  }
  return date.toUTCString();
}

function extractErrorMessage(error) {
  let current = error;
  const seen = new Set();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const short = typeof current.shortMessage === 'string' ? current.shortMessage.trim() : '';
    if (short) return short;
    const message = typeof current.message === 'string' ? current.message.trim() : '';
    if (message) return message;
    current = current.cause;
  }
  return '';
}

function normaliseAddress(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function addressesEqual(a, b) {
  return normaliseAddress(a) === normaliseAddress(b);
}

function setConnectedAccount(addr) {
  const previous = normaliseAddress(connectedAccount);
  const next = normaliseAddress(addr);
  if (previous !== next) {
    bookingsRendered = false;
    lastBookingsAccount = '';
  }
  const original = typeof addr === 'string' ? addr : '';
  connectedAccount = original || null;
  if (activeTokenProposalKey) {
    const contextRecord = bookingRecords.get(activeTokenProposalKey);
    if (!contextRecord || !isTokenisationEligible(contextRecord, addr)) {
      closeTokenProposal();
    }
  }
  if (els.bookings?.refresh) {
    els.bookings.refresh.disabled = !next;
  }
  if (els.connect) {
    if (!els.connect.dataset.defaultLabel) {
      const initialLabel = (els.connect.textContent || '').trim();
      if (initialLabel) {
        els.connect.dataset.defaultLabel = initialLabel;
      }
    }
    els.connect.classList.toggle('is-connected', Boolean(next));
    if (next) {
      els.connect.textContent = `Connected ${short(original)}`;
    } else {
      const fallback = els.connect.dataset.defaultLabel || 'Connect Wallet';
      els.connect.textContent = fallback;
    }
  }
  if (els.addr) {
    if (next) {
      els.addr.textContent = `Connected: ${short(original)}`;
    } else {
      els.addr.textContent = 'Not connected';
    }
  }
}

function toBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isNaN(value)) return fallback;
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    try {
      return BigInt(trimmed);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function toUsdcNumber(value) {
  const amount = toBigInt(value, 0n);
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || Number.isNaN(numeric)) {
    return 0;
  }
  return numeric / 1_000_000;
}

function formatDateLabel(seconds) {
  const value = typeof seconds === 'bigint' ? seconds : BigInt(seconds || 0);
  if (value <= 0n) return '—';
  let numeric;
  try {
    numeric = Number(value);
  } catch {
    return `Unix ${value}`;
  }
  if (!Number.isFinite(numeric) || Number.isNaN(numeric)) {
    return `Unix ${value}`;
  }
  const date = new Date(numeric * 1000);
  if (Number.isNaN(date.getTime())) {
    return `Unix ${value}`;
  }
  return date.toISOString().slice(0, 10);
}

function parseUsdcInput(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const normalised = cleaned.replace(/,/g, '');
  if (!/^\d*(\.\d{0,6})?$/.test(normalised)) {
    return null;
  }
  if (normalised === '.' || normalised === '') {
    return null;
  }
  const [wholePart = '0', fractionalPart = ''] = normalised.split('.');
  let whole;
  try {
    whole = BigInt(wholePart || '0');
  } catch {
    return null;
  }
  const fracPadded = (fractionalPart || '').padEnd(6, '0').slice(0, 6);
  let fraction;
  try {
    fraction = BigInt(fracPadded || '0');
  } catch {
    return null;
  }
  return whole * USDC_SCALAR + fraction;
}

function parseSqmuInput(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/,/g, '');
  if (!cleaned) return null;
  if (!/^\d+$/.test(cleaned)) {
    return null;
  }
  try {
    return BigInt(cleaned);
  } catch {
    return null;
  }
}

function parseBpsInput(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;
  if (!/^\d+$/.test(cleaned)) {
    return null;
  }
  const value = Number.parseInt(cleaned, 10);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

function normaliseBookingStruct(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const result = {};
  for (let i = 0; i < BOOKING_INFO_FIELDS.length; i += 1) {
    const key = BOOKING_INFO_FIELDS[i];
    if (key in raw) {
      result[key] = raw[key];
    } else if (Array.isArray(raw)) {
      result[key] = raw[i];
    }
  }
  return result;
}

function normaliseTokenisationView(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const result = {};
  for (let i = 0; i < TOKENISATION_VIEW_FIELDS.length; i += 1) {
    const key = TOKENISATION_VIEW_FIELDS[i];
    if (key in raw) {
      result[key] = raw[key];
    } else if (Array.isArray(raw)) {
      result[key] = raw[i];
    }
  }
  return result;
}

function calculateRent(baseDailyRate, startTs, endTs) {
  const rate = typeof baseDailyRate === 'bigint' ? baseDailyRate : BigInt(baseDailyRate || 0);
  const start = typeof startTs === 'bigint' ? startTs : BigInt(startTs || 0);
  const end = typeof endTs === 'bigint' ? endTs : BigInt(endTs || 0);
  if (end <= start) return 0n;
  let duration = end - start;
  let days = (duration + SECONDS_PER_DAY - 1n) / SECONDS_PER_DAY;
  if (days === 0n) days = 1n;
  return rate * days;
}

function calculateInstallmentCap(totalRent, startTs, endTs, periodDays) {
  const rent = typeof totalRent === 'bigint' ? totalRent : BigInt(totalRent || 0);
  const start = typeof startTs === 'bigint' ? startTs : BigInt(startTs || 0);
  const end = typeof endTs === 'bigint' ? endTs : BigInt(endTs || 0);
  const cadenceDays = typeof periodDays === 'bigint' ? periodDays : BigInt(periodDays || 0);
  if (rent <= 0n) return 0n;
  if (cadenceDays <= 0n) return rent;
  if (end <= start) return rent;

  let duration = end - start;
  let days = (duration + SECONDS_PER_DAY - 1n) / SECONDS_PER_DAY;
  if (days <= 0n) days = 1n;

  let dailyRate = rent / days;
  if (dailyRate * days < rent) {
    dailyRate += 1n;
  }

  let installment = dailyRate * cadenceDays;
  if (installment > rent) {
    installment = rent;
  }
  return installment;
}

let inHost = false; try { inHost = await sdk.isInMiniApp(); } catch {}
els.status.textContent = inHost ? 'Tap Connect to continue.' : 'Viewing only. Open from a Farcaster Mini App embed.';

async function hostSupportsWallet(){ try { const caps = await sdk.getCapabilities?.(); return !caps || caps.includes('wallet.getEthereumProvider'); } catch { return true; } }

let provider; async function getProvider(){ if (!provider) provider = await sdk.wallet.getEthereumProvider(); return provider; }

async function ensureArbitrum(p){ const id = await p.request({ method:'eth_chainId' }); if (id !== ARBITRUM_HEX) { try { await p.request({ method:'wallet_switchEthereumChain', params:[{ chainId: ARBITRUM_HEX }] }); } catch { try { await p.request({ method:'wallet_addEthereumChain', params:[{ chainId: ARBITRUM_HEX, chainName:'Arbitrum One', nativeCurrency:{ name:'Ether', symbol:'ETH', decimals:18 }, rpcUrls:['https://arb1.arbitrum.io/rpc'], blockExplorerUrls:['https://arbiscan.io'] }] }); } catch {} } } }

function short(a){ return a ? `${a.slice(0,6)}…${a.slice(-4)}` : ''; }

function getListingTitle(info) {
  if (info && typeof info.title === 'string') {
    const trimmed = info.title.trim();
    if (trimmed) return trimmed;
  }
  if (info && typeof info.address === 'string') {
    return `Listing ${short(info.address)}`;
  }
  return 'Listing';
}

function getListingSubtitle(info) {
  if (!info) {
    return 'Select a property to preview totals.';
  }
  const daily = formatUsdc(info.baseDailyRate);
  const deposit = formatUsdc(info.depositAmount);
  return `Base ${daily} USDC/day · Deposit ${deposit} USDC`;
}

function setText(node, value) {
  if (node) {
    node.textContent = value;
  }
}

function updateSummary() {
  const summary = els.summary || {};
  const listing = selectedListing;
  const depositAmount = listing
    ? (typeof listing.depositAmount === 'bigint' ? listing.depositAmount : BigInt(listing.depositAmount || 0))
    : 0n;

  const title = listing ? selectedListingTitle || getListingTitle(listing) : 'No listing selected';
  setText(summary.title, title);
  setText(summary.subtitle, listing ? getListingSubtitle(listing) : 'Select a property to preview totals.');
  setText(summary.nights, '—');
  setText(summary.deposit, listing ? (depositAmount > 0n ? `${formatUsdc(depositAmount)} USDC` : 'No deposit') : '—');
  setText(summary.rent, listing ? '0 USDC' : '—');
  setText(summary.installment, listing ? 'Select how often to pay rent' : '—');
  setText(summary.total, listing ? (depositAmount > 0n ? `${formatUsdc(depositAmount)} USDC` : '0 USDC') : '—');
  setText(summary.notice, listing ? 'Select stay dates to continue.' : 'Pick a property to enable booking.');

  const requiresPass = viewPassRequired && !hasActiveViewPass;
  if (requiresPass) {
    setText(summary.notice, 'Purchase a view pass to unlock bookings.');
  }

  if (els.confirmBooking) {
    els.confirmBooking.disabled = true;
    els.confirmBooking.textContent = depositAmount > 0n
      ? `Book with ${formatUsdc(depositAmount)} USDC deposit`
      : 'Book stay';
  }

  if (!listing) {
    return;
  }

  const startValue = els.start?.value || '';
  const endValue = els.end?.value || '';
  if (!startValue || !endValue) {
    return;
  }

  const startMs = Date.parse(`${startValue}T00:00:00Z`);
  const endMs = Date.parse(`${endValue}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    setText(summary.notice, 'Dates look invalid — choose again.');
    return;
  }
  if (endMs <= startMs) {
    setText(summary.notice, 'Check-out must be after check-in.');
    return;
  }

  const periodKey = els.period?.value || '';
  const selectedPeriod = PERIOD_OPTIONS[periodKey];
  if (!selectedPeriod) {
    setText(summary.notice, "Pick how often you'll pay rent.");
    return;
  }

  const startTs = BigInt(Math.floor(startMs / 1000));
  const endTs = BigInt(Math.floor(endMs / 1000));
  let nightsBig = endTs - startTs;
  nightsBig = (nightsBig + SECONDS_PER_DAY - 1n) / SECONDS_PER_DAY;
  if (nightsBig <= 0n) {
    nightsBig = 1n;
  }
  const nights = Number(nightsBig);
  setText(summary.nights, `${nights} night${nights === 1 ? '' : 's'}`);

  const rent = calculateRent(listing.baseDailyRate, startTs, endTs);
  setText(summary.rent, rent > 0n ? `${formatUsdc(rent)} USDC` : '0 USDC');

  const installmentCap = calculateInstallmentCap(rent, startTs, endTs, selectedPeriod.days);
  setText(
    summary.installment,
    installmentCap > 0n
      ? `${selectedPeriod.label} up to ${formatUsdc(installmentCap)} USDC`
      : `${selectedPeriod.label} payments`
  );

  setText(summary.total, depositAmount > 0n ? `${formatUsdc(depositAmount)} USDC` : '0 USDC');

  if (requiresPass) {
    setText(summary.notice, 'Purchase a view pass to unlock bookings.');
    if (els.confirmBooking) {
      els.confirmBooking.disabled = true;
      els.confirmBooking.textContent = depositAmount > 0n
        ? `Book with ${formatUsdc(depositAmount)} USDC deposit`
        : 'Book stay';
    }
    return;
  }

  setText(summary.notice, 'Ready to book — confirm when you’re happy with the details.');

  if (els.confirmBooking) {
    els.confirmBooking.disabled = false;
    els.confirmBooking.textContent = depositAmount > 0n
      ? `Book with ${formatUsdc(depositAmount)} USDC deposit`
      : 'Book stay';
  }
}

function clearSelection(options = {}) {
  if (selectedCard) {
    selectedCard.classList.remove('selected');
  }
  selectedCard = null;
  selectedListing = null;
  selectedListingTitle = '';
  updateSummary();
  if (!options.fromBack && selectionBackEntry) {
    selectionBackEntry = null;
    backController.reset({ skipHandlers: true });
  }
  backController.update();
}

function setSelectedListing(info, card) {
  if (!info) {
    clearSelection();
    return;
  }
  const alreadySelected = selectedListing && addressesEqual(selectedListing.address, info.address);
  if (selectedCard && selectedCard !== card) {
    selectedCard.classList.remove('selected');
  }
  selectedListing = info;
  selectedCard = card || (info?.id ? els.listings?.querySelector(`[data-id="${info.id}"]`) : null);
  selectedListingTitle = info?.displayTitle || getListingTitle(info);
  if (selectedCard) {
    selectedCard.classList.add('selected');
  }
  setText(els.summary?.title, selectedListingTitle);
  setText(els.summary?.subtitle, getListingSubtitle(info));
  updateSummary();
  if (!alreadySelected) {
    notify({ message: `Planning stay at ${selectedListingTitle}`, variant: 'info', role: 'tenant', timeout: 4200 });
  }
  if (!selectionBackEntry) {
    selectionBackEntry = backController.push({
      onPop: () => {
        selectionBackEntry = null;
        clearSelection({ fromBack: true });
      },
    });
  }
  backController.update();
}

function selectListing(listing) {
  if (!listing) {
    clearSelection();
    return;
  }
  const record = listingRecords.get(listing.id) || listingRecords.get(listing.address) || listing;
  const card = record?.id && els.listings
    ? els.listings.querySelector(`[data-id="${record.id}"]`)
    : null;
  setSelectedListing(record, card);
}

function openBookingFlow(listing) {
  selectListing(listing);
  if (els.summary?.container) {
    try {
      els.summary.container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {}
  }
  if (els.confirmBooking) {
    els.confirmBooking.focus();
  }
}

function updateBuyLabel() {
  const parts = [];
  if (typeof viewPassPrice === 'bigint') {
    parts.push(`${formatUsdc(viewPassPrice)} USDC`);
  }
  if (typeof viewPassDuration === 'bigint' && viewPassDuration > 0n) {
    parts.push(formatDuration(viewPassDuration));
  }
  els.buy.textContent = parts.length ? `Buy View Pass (${parts.join(' / ')})` : 'Buy View Pass';
}

async function loadConfig(){
  if (configLoading) {
    await configLoading;
    return;
  }
  configLoading = (async () => {
    if (!pub) {
      pub = createPublicClient({ chain: arbitrum, transport: http(RPC_URL || 'https://arb1.arbitrum.io/rpc') });
    }
    try {
      const [price, duration] = await Promise.all([
        pub
          .readContract({ address: PLATFORM_ADDRESS, abi: PLATFORM_ABI, functionName: 'viewPassPrice' })
          .catch((err) => {
            console.error('Failed to load view pass price', err);
            return undefined;
          }),
        pub
          .readContract({ address: PLATFORM_ADDRESS, abi: PLATFORM_ABI, functionName: 'viewPassDuration' })
          .catch((err) => {
            console.error('Failed to load view pass duration', err);
            return undefined;
          }),
      ]);
      if (typeof price === 'bigint') {
        viewPassPrice = price;
      }
      if (typeof duration === 'bigint') {
        viewPassDuration = duration;
      }
    } catch (err) {
      console.error('Configuration load failed', err);
    }
    updateBuyLabel();
  })();
  try {
    await configLoading;
  } finally {
    configLoading = null;
  }
}

async function openCast(fid, hash32, fallbackUrl){
  const cast20 = bytes32ToCastHash(hash32);
  try {
    await sdk.actions.viewCast({ hash: cast20 });
  } catch {
    // fallback: open in Warpcast via the generated profile-aware URL
    window.open(fallbackUrl, '_blank');
  }
}

const IPFS_PREFIX = 'ipfs://';
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

function normaliseMetadataUrl(uri){
  if (!uri || typeof uri !== 'string') return '';
  if (uri.startsWith(IPFS_PREFIX)) {
    const path = uri.slice(IPFS_PREFIX.length);
    return `${IPFS_GATEWAY}${path.replace(/^\//, '')}`;
  }
  return uri;
}

function decodeDataUri(uri){
  const match = /^data:([^;,]*)(;charset=[^;,]*)?(;base64)?,([\s\S]*)$/i.exec(uri || '');
  if (!match) return null;
  const isBase64 = Boolean(match[3]);
  const payload = match[4] || '';
  try {
    if (isBase64) {
      const cleaned = payload.replace(/\s/g, '');
      return atob(cleaned);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

async function fetchListingMetadataDetails(uri, fallbackAddress){
  const fallbackText = typeof fallbackAddress === 'string' ? fallbackAddress : '';
  const result = { title: fallbackText, description: fallbackText };
  if (!uri || typeof uri !== 'string') {
    return result;
  }
  let raw;
  try {
    if (uri.startsWith('data:')) {
      raw = decodeDataUri(uri);
    } else {
      const normalised = normaliseMetadataUrl(uri);
      if (!normalised) {
        return result;
      }
      const response = await fetch(normalised, { method: 'GET' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      raw = await response.text();
    }
  } catch (err) {
    console.warn('Failed to retrieve listing metadata', uri, err);
    return result;
  }
  if (!raw) {
    return result;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        result.title = parsed.name.trim();
      }
      if (typeof parsed.description === 'string' && parsed.description.trim()) {
        result.description = parsed.description.trim();
      }
    }
  } catch (err) {
    console.warn('Failed to parse listing metadata JSON', uri, err);
  }
  return result;
}

async function fetchListingInfo(listingAddr){
  if (!listingAddr || typeof listingAddr !== 'string') {
    return null;
  }
  const cacheKey = normaliseAddress(listingAddr);
  if (listingInfoCache.has(cacheKey)) {
    return listingInfoCache.get(cacheKey);
  }
  if (!pub) {
    await loadConfig();
  }
  try {
    const responses = await pub.multicall({
      contracts: [
        { address: listingAddr, abi: LISTING_ABI, functionName: 'fid' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'castHash' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'baseDailyRate' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'depositAmount' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'areaSqm' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'metadataURI' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'minBookingNotice' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'maxBookingWindow' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'geohash' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'geohashPrecision' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'landlord' },
      ],
      allowFailure: true,
    });
    const getBig = (idx, fallback = 0n) => {
      const entry = responses[idx];
      if (!entry || entry.status !== 'success') return fallback;
      const res = entry.result;
      try { return typeof res === 'bigint' ? res : BigInt(res || 0); } catch { return fallback; }
    };
    const getString = (idx, fallback = '') => {
      const entry = responses[idx];
      if (!entry || entry.status !== 'success') return fallback;
      return entry.result ?? fallback;
    };
    const fid = getBig(0);
    const castHash = getString(1, '0x0000000000000000000000000000000000000000000000000000000000000000');
    const baseDailyRate = getBig(2);
    const depositAmount = getBig(3);
    const areaSqm = Number(getBig(4));
    const metadataURI = getString(5, '') || '';
    const minBookingNotice = getBig(6);
    const maxBookingWindow = getBig(7);
    const geohashHex = getString(8, '0x');
    const geohashPrecision = Number(getBig(9));
    const landlord = getString(10, '0x0000000000000000000000000000000000000000');
    const metadataDetails = await fetchListingMetadataDetails(metadataURI, listingAddr);
    const geohash = decodeBytes32ToString(
      geohashHex,
      Number.isFinite(geohashPrecision) ? geohashPrecision : undefined
    );
    let lat = null;
    let lon = null;
    if (geohash) {
      try {
        const coords = geohashToLatLon(geohash);
        if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)) {
          lat = coords.lat;
          lon = coords.lon;
        }
      } catch (err) {
        console.warn('Unable to decode geohash for listing', listingAddr, geohash, err);
      }
    }
    const info = {
      address: listingAddr,
      fid,
      castHash,
      baseDailyRate,
      depositAmount,
      areaSqm,
      metadataURI,
      title: metadataDetails.title,
      description: metadataDetails.description,
      minBookingNotice,
      maxBookingWindow,
      geohash,
      geohashPrecision,
      lat,
      lon,
      landlord,
    };
    listingInfoCache.set(cacheKey, info);
    return info;
  } catch (err) {
    console.error('Failed to load listing info', listingAddr, err);
    return null;
  }
}

function getListingLocationPill(info) {
  if (info && Number.isFinite(info.lat) && Number.isFinite(info.lon)) {
    return `${info.lat.toFixed(2)}°, ${info.lon.toFixed(2)}°`;
  }
  if (info && typeof info.geohash === 'string' && info.geohash.trim()) {
    return `Geohash ${info.geohash.trim()}`;
  }
  return 'Location pending';
}

function buildListingRecord(info) {
  if (!info) return null;
  const id = normaliseAddress(info.address) || info.address || '';
  const displayTitle = getListingTitle(info);
  return {
    ...info,
    id,
    displayTitle,
    locationPill: getListingLocationPill(info),
    deposit: info.depositAmount,
    active: true,
  };
}

function renderListings(listings) {
  const container = document.getElementById('listings');
  if (!container) return;
  container.innerHTML = '';
  listings.forEach((L) => {
    const record = listingRecords.get(L.id) || L;
    const card = ListingCard({
      id: record.id,
      title: record.displayTitle || record.title || getListingTitle(record),
      location: record.locationPill || getListingLocationPill(record),
      pricePerDayUSDC: toUsdcNumber(record.baseDailyRate),
      areaSqm: Number.isFinite(record.areaSqm) ? record.areaSqm : undefined,
      depositUSDC: toUsdcNumber(record.deposit ?? record.depositAmount),
      status: record.active ? 'Active' : 'Inactive',
      actions: [
        { label: 'Preview totals', onClick: () => selectListing(record) },
        { label: 'Book', onClick: () => openBookingFlow(record), visible: record.active },
      ],
    });
    card.dataset.address = record.address || '';
    card.dataset.displayTitle = record.displayTitle || '';

    if (record && typeof record.description === 'string') {
      const trimmed = record.description.trim();
      if (trimmed && trimmed !== record.displayTitle && trimmed !== record.address) {
        card.append(el('div', { class: 'card-footnote listing-summary' }, trimmed));
      }
    }

    const minNoticeText = formatDuration(record.minBookingNotice);
    const maxWindowText = record.maxBookingWindow > 0n ? formatDuration(record.maxBookingWindow) : 'Unlimited';
    card.append(el('div', { class: 'card-footnote' }, `Min notice: ${minNoticeText} · Booking window: ${maxWindowText}`));

    if (record.geohash || (Number.isFinite(record.lat) && Number.isFinite(record.lon))) {
      const geoLine = el('div', { class: 'card-footnote listing-geo' }, []);
      let preciseCoords = null;
      if (Number.isFinite(record.lat) && Number.isFinite(record.lon)) {
        const latText = record.lat.toFixed(5);
        const lonText = record.lon.toFixed(5);
        geoLine.append(el('span', {}, `Location: ${latText}°, ${lonText}°`));
        preciseCoords = `${record.lat.toFixed(6)},${record.lon.toFixed(6)}`;
      } else {
        geoLine.append(el('span', {}, 'Location: —'));
      }
      if (preciseCoords) {
        const copyBtn = el('button', { type: 'button', class: 'inline-button geo-copy-button' }, 'Copy');
        if (navigator?.clipboard?.writeText) {
          copyBtn.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(preciseCoords);
              notify({ message: 'Coordinates copied to clipboard.', variant: 'success', role: 'tenant', timeout: 4000 });
            } catch (err) {
              console.error('Failed to copy coordinates', err);
              notify({ message: 'Unable to copy coordinates.', variant: 'error', role: 'tenant', timeout: 5000 });
            }
          });
        } else {
          copyBtn.disabled = true;
          copyBtn.title = 'Clipboard unavailable';
        }
        geoLine.append(copyBtn);
        geoLine.append(
          el('a', {
            href: `https://www.google.com/maps/search/?api=1&query=${preciseCoords}`,
            target: '_blank',
            rel: 'noopener',
            class: 'geo-map-link',
          }, 'Open map'),
        );
      }
      card.append(geoLine);
    }

    if (record.metadataURI) {
      card.append(
        el('a', {
          href: record.metadataURI,
          target: '_blank',
          rel: 'noopener',
          class: 'listing-link',
        }, 'Metadata'),
      );
    }

    const farcasterUrl = buildFarcasterCastUrl(record.fid, record.castHash);
    card.append(
      el('a', {
        href: farcasterUrl,
        target: '_blank',
        rel: 'noopener',
        class: 'listing-link',
        onClick: (ev) => {
          ev.preventDefault();
          openCast(record.fid, record.castHash, farcasterUrl);
        },
      }, 'View full details on Farcaster'),
    );

    if (selectedListing && selectedListing.address && addressesEqual(selectedListing.address, record.address)) {
      card.classList.add('selected');
      selectedCard = card;
    }

    container.append(card);
  });
}

function buildBookingRecord(meta, data, pending, listingInfo) {
  const bookingId = typeof meta.bookingId === 'bigint' ? meta.bookingId : toBigInt(meta.bookingId, 0n);
  const listingAddress = meta.listing;
  const statusValue = Number(toBigInt(data.status, 0n));
  const statusMeta = BOOKING_STATUS_META[statusValue] || { label: `Status ${statusValue}`, className: 'unknown' };
  const grossRent = toBigInt(data.grossRent, 0n);
  const rentPaid = toBigInt(data.rentPaid, 0n);
  const deposit = toBigInt(data.deposit, 0n);
  const periodValue = Number(toBigInt(data.period, 0n));
  const periodLabel = BOOKING_PERIOD_LABELS[periodValue] || 'Custom';
  const totalSqmu = toBigInt(data.totalSqmu, 0n);
  const soldSqmu = toBigInt(data.soldSqmu, 0n);
  const pricePerSqmu = toBigInt(data.pricePerSqmu, 0n);
  const feeBps = toBigInt(data.feeBps, 0n);
  const tenant = typeof data.tenant === 'string' ? data.tenant : '0x0000000000000000000000000000000000000000';
  const rentDue = grossRent > rentPaid ? grossRent - rentPaid : 0n;
  const listingTitle = listingInfo ? getListingTitle(listingInfo) : `Listing ${short(listingAddress)}`;
  const landlord = listingInfo && typeof listingInfo.landlord === 'string'
    ? listingInfo.landlord
    : '0x0000000000000000000000000000000000000000';
  const landlordLower = normaliseAddress(landlord);
  const start = toBigInt(data.start, 0n);
  const end = toBigInt(data.end, 0n);
  const expectedNetRent = toBigInt(data.expectedNetRent, 0n);
  const depositReleased = Boolean(data.depositReleased);
  const tokenised = Boolean(data.tokenised);
  const pendingInfoRaw = pending ? normaliseTokenisationView(pending) : null;
  const pendingExists = Boolean(pendingInfoRaw?.exists);
  const pendingTotalSqmu = toBigInt(pendingInfoRaw?.totalSqmu, 0n);
  const pendingPricePerSqmu = toBigInt(pendingInfoRaw?.pricePerSqmu, 0n);
  const pendingFeeBps = toBigInt(pendingInfoRaw?.feeBps, 0n);
  const pendingPeriodValue = Number(toBigInt(pendingInfoRaw?.period, 0n));
  const pendingPeriodLabel = BOOKING_PERIOD_LABELS[pendingPeriodValue] || 'Custom';
  const pendingProposer = typeof pendingInfoRaw?.proposer === 'string'
    ? pendingInfoRaw.proposer
    : '0x0000000000000000000000000000000000000000';
  const now = BigInt(Math.floor(Date.now() / 1000));
  const isActive = statusValue === 1;
  const isUpcoming = start > now;
  let canCancel = false;
  let cancelDisabledReason = '';
  if (!isActive) {
    cancelDisabledReason = 'Only active bookings can be cancelled.';
  } else if (!isUpcoming) {
    cancelDisabledReason = 'Cancellation is unavailable once the stay has started.';
  } else if (depositReleased) {
    cancelDisabledReason = 'Security deposit already handled — contact the landlord for help.';
  } else if (rentPaid > 0n) {
    cancelDisabledReason = 'Bookings with rent payments cannot be cancelled automatically.';
  } else {
    canCancel = true;
  }
  return {
    key: `${normaliseAddress(listingAddress)}-${bookingId.toString()}`,
    listingAddress,
    listingTitle,
    bookingId,
    bookingIdText: bookingId.toString(),
    statusValue,
    statusLabel: statusMeta.label,
    statusClass: statusMeta.className,
    start,
    end,
    startLabel: formatDateLabel(start),
    endLabel: formatDateLabel(end),
    grossRent,
    rentPaid,
    rentDue,
    deposit,
    depositReleased,
    expectedNetRent,
    periodValue,
    periodLabel,
    totalSqmu,
    soldSqmu,
    pricePerSqmu,
    feeBps,
    tokenised,
    tenant,
    tenantLower: normaliseAddress(tenant),
    landlord,
    landlordLower,
    listingInfo: listingInfo || null,
    canPayRent: statusValue === 1 && rentDue > 0n,
    isActive,
    canCancel,
    cancelDisabledReason,
    pendingTokenisationExists: pendingExists && !tokenised,
    pendingTokenisation: pendingExists
      ? {
          exists: pendingExists,
          proposer: pendingProposer,
          totalSqmu: pendingTotalSqmu,
          pricePerSqmu: pendingPricePerSqmu,
          feeBps: pendingFeeBps,
          periodValue: pendingPeriodValue,
          periodLabel: pendingPeriodLabel,
        }
      : null,
  };
}

function isTokenisationEligible(record, account = connectedAccount) {
  if (!record || record.tokenised || record.pendingTokenisationExists) return false;
  const candidate = normaliseAddress(account);
  if (!candidate) return false;
  return candidate === record.tenantLower || candidate === record.landlordLower;
}

function closeTokenProposal() {
  activeTokenProposalKey = null;
  if (tokenProposalHost) {
    tokenProposalHost.innerHTML = '';
    tokenProposalHost.hidden = true;
  }
}

function openTokenProposal(booking) {
  const record = booking && booking.key ? bookingRecords.get(booking.key) || booking : booking;
  if (!record) {
    notify({ message: 'Unable to find booking details for tokenisation.', variant: 'error', role: 'tenant', timeout: 5000 });
    return;
  }
  if (record.tokenised) {
    notify({ message: 'This booking is already tokenised.', variant: 'info', role: 'tenant', timeout: 4500 });
    return;
  }
  if (record.pendingTokenisationExists) {
    notify({ message: 'Tokenisation proposal pending platform approval.', variant: 'info', role: 'tenant', timeout: 5000 });
    return;
  }
  if (!isTokenisationEligible(record)) {
    notify({ message: 'Tokenisation requires the tenant or landlord wallet.', variant: 'warning', role: 'tenant', timeout: 5000 });
    return;
  }

  activeTokenProposalKey = record.key;
  if (tokenProposalHost) {
    tokenProposalHost.hidden = false;
    tokenProposalHost.innerHTML = '';

    const summary = el('div', { class: 'card-footnote' }, `Stay: ${record.startLabel} → ${record.endLabel} · Rent ${formatUsdc(record.grossRent)} USDC`);

    let form;
    form = TokenisationCard({
      bookingId: record.bookingIdText || record.bookingId.toString(),
      mode: 'propose',
      onSubmit: async (values) => {
        const controls = Array.from(form.querySelectorAll('input, select, button'));
        controls.forEach((node) => { node.disabled = true; });
        try {
          const success = await submitTokenisationProposalForTenant(record, values);
          if (success) {
            closeTokenProposal();
            try {
              await loadTenantBookings(connectedAccount, { force: true, showBusyLabel: true });
            } catch (err) {
              console.warn('Failed to refresh bookings after tokenisation proposal', err);
            }
          }
        } finally {
          controls.forEach((node) => { node.disabled = false; });
        }
      },
    });

    const periodSelect = form.querySelector('select[name="period"]');
    const requiredKey = getPeriodKeyFromValue(record.periodValue);
    if (periodSelect && requiredKey && periodSelect.querySelector(`option[value="${requiredKey}"]`)) {
      periodSelect.value = requiredKey;
    }

    tokenProposalHost.append(form);
    tokenProposalHost.append(summary);

    try {
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {}
  }
}

async function submitTokenisationProposalForTenant(record, { amount, totalSqmu, price, pricePerSqmu, fee, feeBps, period }) {
  const target = record && record.key ? bookingRecords.get(record.key) || record : record;
  if (!target) {
    notify({ message: 'Booking details unavailable. Refresh and try again.', variant: 'error', role: 'tenant', timeout: 6000 });
    return false;
  }
  if (target.tokenised) {
    notify({ message: 'This booking is already tokenised.', variant: 'info', role: 'tenant', timeout: 4500 });
    return false;
  }
  if (target.pendingTokenisationExists) {
    notify({ message: 'Tokenisation proposal pending platform approval.', variant: 'info', role: 'tenant', timeout: 5000 });
    return false;
  }

  const totalSqmuValue = parseSqmuInput(amount ?? totalSqmu ?? '');
  if (totalSqmuValue === null || totalSqmuValue <= 0n) {
    notify({ message: 'Enter the total SQMU supply (whole number greater than 0).', variant: 'warning', role: 'tenant', timeout: 5000 });
    return false;
  }
  const priceValue = parseUsdcInput(price ?? pricePerSqmu ?? '');
  if (priceValue === null || priceValue <= 0n) {
    notify({ message: 'Price per SQMU must be greater than 0 USDC.', variant: 'warning', role: 'tenant', timeout: 5000 });
    return false;
  }
  const feeValue = parseBpsInput(fee ?? feeBps ?? '');
  if (feeValue === null) {
    notify({ message: 'Enter the platform fee in basis points.', variant: 'warning', role: 'tenant', timeout: 5000 });
    return false;
  }
  if (feeValue < 0 || feeValue > 10_000) {
    notify({ message: 'Platform fee must be between 0 and 10000 basis points.', variant: 'warning', role: 'tenant', timeout: 5000 });
    return false;
  }

  const periodKey = typeof period === 'string' ? period : '';
  const periodInfo = PERIOD_OPTIONS[periodKey];
  if (!periodInfo) {
    notify({ message: 'Select a distribution period.', variant: 'warning', role: 'tenant', timeout: 5000 });
    return false;
  }
  const requiredKey = getPeriodKeyFromValue(target.periodValue);
  if (requiredKey && requiredKey !== periodKey) {
    notify({ message: `Booking cadence is fixed to ${target.periodLabel.toLowerCase()}.`, variant: 'warning', role: 'tenant', timeout: 5000 });
    return false;
  }

  try {
    const p = await getProvider();
    const accounts = (await p.request({ method: 'eth_accounts' })) || [];
    const [from] = accounts;
    if (!from) {
      throw new Error('No wallet account connected.');
    }
    if (!isTokenisationEligible(target, from)) {
      notify({ message: 'Connected wallet does not match the tenant or landlord for this booking.', variant: 'error', role: 'tenant', timeout: 6000 });
      return false;
    }

    setConnectedAccount(from);
    await ensureArbitrum(p);
    await loadConfig();

    const args = [
      target.bookingId,
      totalSqmuValue,
      priceValue,
      BigInt(feeValue),
      periodInfo.value,
    ];

    try {
      await pub.simulateContract({
        address: target.listingAddress,
        abi: LISTING_ABI,
        functionName: 'proposeTokenisation',
        args,
        account: from,
      });
    } catch (err) {
      const detail = extractErrorMessage(err) || 'Tokenisation proposal not available right now.';
      notify({ message: `Unable to submit tokenisation proposal: ${detail}`, variant: 'error', role: 'tenant', timeout: 6500 });
      return false;
    }

    const data = encodeFunctionData({
      abi: LISTING_ABI,
      functionName: 'proposeTokenisation',
      args,
    });

    els.status.textContent = 'Submitting tokenisation proposal…';
    notify({ message: 'Submitting tokenisation proposal…', variant: 'info', role: 'tenant', timeout: 4500 });

    let walletSendUnsupported = false;
    let batchedSuccess = false;
    try {
      const { unsupported } = await requestWalletSendCalls(p, {
        calls: [{ to: target.listingAddress, data }],
        from,
        chainId: ARBITRUM_HEX,
      });
      walletSendUnsupported = unsupported;
      batchedSuccess = !unsupported;
    } catch (err) {
      if (isUserRejectedRequestError(err)) {
        els.status.textContent = 'Tokenisation proposal cancelled by user.';
        notify({ message: 'Tokenisation proposal cancelled.', variant: 'warning', role: 'tenant', timeout: 5000 });
        return false;
      }
      throw err;
    }

    if (!batchedSuccess && walletSendUnsupported) {
      await p.request({ method: 'eth_sendTransaction', params: [{ from, to: target.listingAddress, data }] });
    }

    els.status.textContent = `Tokenisation proposal submitted for booking #${target.bookingIdText}.`;
    notify({
      message: `Tokenisation proposal submitted for booking #${target.bookingIdText}.`,
      variant: 'success',
      role: 'tenant',
      timeout: 6000,
    });
    return true;
  } catch (err) {
    console.error('Tokenisation proposal failed', err);
    if (!isUserRejectedRequestError(err)) {
      const message = extractErrorMessage(err) || err?.message || 'Tokenisation proposal failed.';
      els.status.textContent = `Tokenisation proposal failed: ${message}`;
      notify({ message: `Tokenisation proposal failed: ${message}`, variant: 'error', role: 'tenant', timeout: 6500 });
    }
    return false;
  }
}

async function cancelBookingForTenant(recordKeyOrRecord, button) {
  const key = typeof recordKeyOrRecord === 'object' ? recordKeyOrRecord?.key : recordKeyOrRecord;
  const record = typeof recordKeyOrRecord === 'object' ? recordKeyOrRecord : bookingRecords.get(key);
  if (!record) {
    notify({ message: 'Unable to find booking details for cancellation.', variant: 'error', role: 'tenant', timeout: 5000 });
    return;
  }
  if (!button) {
    notify({ message: 'Cancellation controls unavailable for this booking.', variant: 'error', role: 'tenant', timeout: 5000 });
    return;
  }
  const tenantConnected = addressesEqual(connectedAccount, record.tenantLower);
  if (!tenantConnected) {
    const message = 'Connect with the tenant wallet to cancel this booking.';
    els.status.textContent = message;
    notify({ message, variant: 'warning', role: 'tenant', timeout: 5000 });
    return;
  }
  if (!record.isActive) {
    const message = record.cancelDisabledReason || 'This booking is not active anymore.';
    els.status.textContent = message;
    notify({ message, variant: 'warning', role: 'tenant', timeout: 5000 });
    return;
  }
  if (!record.canCancel) {
    const message = record.cancelDisabledReason || 'This booking cannot be cancelled right now.';
    els.status.textContent = message;
    notify({ message, variant: 'warning', role: 'tenant', timeout: 5000 });
    return;
  }

  const nowTs = BigInt(Math.floor(Date.now() / 1000));
  if (record.start <= nowTs) {
    const message = 'Cancellation window has passed because the stay has started.';
    els.status.textContent = message;
    notify({ message, variant: 'warning', role: 'tenant', timeout: 5000 });
    return;
  }
  if (record.depositReleased) {
    const message = 'Deposit already released — contact the landlord for assistance.';
    els.status.textContent = message;
    notify({ message, variant: 'warning', role: 'tenant', timeout: 5000 });
    return;
  }
  if (record.rentPaid > 0n) {
    const message = 'Bookings with rent payments cannot be cancelled automatically.';
    els.status.textContent = message;
    notify({ message, variant: 'warning', role: 'tenant', timeout: 5000 });
    return;
  }

    const confirmationMessage = record.deposit > 0n
      ? `Cancel booking #${record.bookingIdText}? Your ${formatUsdc(record.deposit)} USDC deposit will be refunded automatically.`
      : `Cancel booking #${record.bookingIdText}? This frees up the stay for other tenants.`;
  const confirmed = window.confirm(confirmationMessage);
  if (!confirmed) {
    els.status.textContent = 'Cancellation dismissed.';
    notify({ message: 'Cancellation dismissed.', variant: 'info', role: 'tenant', timeout: 4000 });
    return;
  }

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Cancelling…';

  try {
    const p = await getProvider();
    const accounts = (await p.request({ method: 'eth_accounts' })) || [];
    const [from] = accounts;
    if (!from) {
      throw new Error('No wallet account connected.');
    }
    if (!addressesEqual(from, record.tenantLower)) {
      const message = 'Connected wallet does not match the booking tenant.';
      els.status.textContent = message;
      notify({ message, variant: 'error', role: 'tenant', timeout: 6000 });
      return;
    }
    setConnectedAccount(from);
    await ensureArbitrum(p);
    await loadConfig();

    try {
      await pub.simulateContract({
        address: record.listingAddress,
        abi: LISTING_ABI,
        functionName: 'cancelBooking',
        args: [record.bookingId],
        account: from,
      });
    } catch (err) {
      console.error('Cancellation simulation failed', err);
      const detail = extractErrorMessage(err) || 'Cancellation not available right now.';
      const message = detail.toLowerCase().includes('not authorised')
        ? 'Cancellation currently requires landlord or platform approval.'
        : detail;
      els.status.textContent = message;
      notify({
        message: message ? `Unable to cancel booking: ${message}` : 'Unable to cancel booking.',
        variant: 'error',
        role: 'tenant',
        timeout: 6000,
      });
      return;
    }

    const cancelData = encodeFunctionData({
      abi: LISTING_ABI,
      functionName: 'cancelBooking',
      args: [record.bookingId],
    });

    els.status.textContent = 'Submitting cancellation…';

    let walletSendUnsupported = false;
    let batchedSuccess = false;
    try {
      const { unsupported } = await requestWalletSendCalls(p, {
        calls: [{ to: record.listingAddress, data: cancelData }],
        from,
        chainId: ARBITRUM_HEX,
      });
      walletSendUnsupported = unsupported;
      batchedSuccess = !unsupported;
    } catch (err) {
      if (isUserRejectedRequestError(err)) {
        els.status.textContent = 'Cancellation cancelled by user.';
        notify({ message: 'Cancellation request cancelled.', variant: 'warning', role: 'tenant', timeout: 5000 });
        return;
      }
      throw err;
    }

    if (!batchedSuccess && walletSendUnsupported) {
      await p.request({ method: 'eth_sendTransaction', params: [{ from, to: record.listingAddress, data: cancelData }] });
      batchedSuccess = true;
    }

    els.status.textContent = 'Cancellation submitted.';
    const successMessage = record.deposit > 0n
      ? `Booking cancelled. Your ${formatUsdc(record.deposit)} USDC deposit will be returned.`
      : 'Booking cancelled. No deposit was held.';
    notify({
      message: successMessage,
      variant: 'success',
      role: 'tenant',
      timeout: 6000,
    });
    await loadTenantBookings(connectedAccount, { force: true });
  } catch (err) {
    console.error('Cancel booking failed', err);
    if (isUserRejectedRequestError(err)) {
      els.status.textContent = 'Cancellation cancelled by user.';
      notify({ message: 'Cancellation request cancelled.', variant: 'warning', role: 'tenant', timeout: 5000 });
    } else {
      const message = extractErrorMessage(err) || err?.message || err;
      els.status.textContent = `Cancellation failed: ${message}`;
      notify({
        message: message ? `Cancellation failed: ${message}` : 'Cancellation failed.',
        variant: 'error',
        role: 'tenant',
        timeout: 6000,
      });
    }
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function multicallChunks(contracts, chunkSize = MULTICALL_CHUNK) {
  const results = [];
  if (!Array.isArray(contracts) || contracts.length === 0) {
    return results;
  }
  const size = Math.max(1, Number.isInteger(chunkSize) ? chunkSize : MULTICALL_CHUNK);
  for (let i = 0; i < contracts.length; i += size) {
    const chunk = contracts.slice(i, i + size);
    try {
      const response = await pub.multicall({ contracts: chunk, allowFailure: true });
      results.push(...response);
    } catch (err) {
      console.error('Multicall chunk failed', err);
      for (let j = 0; j < chunk.length; j += 1) {
        results.push({ status: 'failure', result: null });
      }
    }
  }
  return results;
}

function renderBookings(records, emptyMessage = 'No bookings found for this wallet yet.') {
  const listEl = els.bookings?.list;
  const statusEl = els.bookings?.status;
  if (!listEl) {
    return;
  }
  bookingRecords.clear();
  listEl.innerHTML = '';
  if (!records || records.length === 0) {
    if (statusEl) {
      statusEl.textContent = emptyMessage;
    }
    closeTokenProposal();
    return;
  }
  const sorted = [...records];
  sorted.sort((a, b) => {
    if (a.start === b.start) {
      if (a.bookingId === b.bookingId) return 0;
      return a.bookingId > b.bookingId ? -1 : 1;
    }
    return a.start > b.start ? -1 : 1;
  });
  for (const record of sorted) {
    bookingRecords.set(record.key, record);
    const actions = [
      { label: 'Pay rent', onClick: () => payRent(record), visible: record.canPayRent },
      {
        label: 'Propose tokenisation',
        onClick: () => openTokenProposal(record),
        visible: !record.tokenised && !record.pendingTokenisationExists && isTokenisationEligible(record),
      },
    ];
    const tenantConnected = addressesEqual(connectedAccount, record.tenantLower);
    if (tenantConnected && record.canCancel) {
      actions.push({
        label: 'Cancel booking',
        onClick: (event) => cancelBookingForTenant(record, event?.currentTarget || null),
        visible: true,
      });
    }
    const card = BookingCard({
      bookingId: record.bookingIdText || record.bookingId.toString(),
      listingId: record.listingTitle || short(record.listingAddress),
      dates: `${record.startLabel} → ${record.endLabel}`,
      period: record.periodLabel,
      depositUSDC: toUsdcNumber(record.deposit),
      rentUSDC: toUsdcNumber(record.grossRent),
      status: record.statusLabel,
      actions,
    });
    card.dataset.bookingKey = record.key;
    card.append(el('div', { class: 'card-footnote' }, record.listingTitle));
    const rentFootnote = record.rentDue > 0n
      ? `Outstanding rent: ${formatUsdc(record.rentDue)} USDC`
      : 'All rent settled.';
    card.append(el('div', { class: 'card-footnote' }, rentFootnote));
    if (record.tokenised) {
      card.append(
        el('div', { class: 'card-footnote' }, `Tokenised · ${formatSqmu(record.totalSqmu)} SQMU · ${formatUsdc(record.pricePerSqmu)} USDC`),
      );
    } else if (record.pendingTokenisationExists && record.pendingTokenisation) {
      card.append(
        el(
          'div',
          { class: 'card-footnote' },
          `Pending tokenisation · ${formatSqmu(record.pendingTokenisation.totalSqmu)} SQMU @ ${formatUsdc(record.pendingTokenisation.pricePerSqmu)} USDC (${formatBps(record.pendingTokenisation.feeBps)})`,
        ),
      );
    } else if (!isTokenisationEligible(record)) {
      card.append(
        el('div', { class: 'card-footnote' }, 'Tokenisation proposals require the tenant or landlord wallet.'),
      );
    }
    if (!tenantConnected && record.canCancel) {
      card.append(
        el('div', { class: 'card-footnote' }, 'Connect with your tenant wallet to cancel this booking.'),
      );
    } else if (!record.canCancel && record.cancelDisabledReason) {
      card.append(el('div', { class: 'card-footnote' }, record.cancelDisabledReason));
    }
    listEl.append(card);
  }
  if (statusEl) {
    statusEl.textContent = `Showing ${sorted.length} booking${sorted.length === 1 ? '' : 's'}.`;
  }

  if (activeTokenProposalKey) {
    const contextRecord = bookingRecords.get(activeTokenProposalKey);
    if (!contextRecord || contextRecord.tokenised || contextRecord.pendingTokenisationExists || !isTokenisationEligible(contextRecord)) {
      closeTokenProposal();
    }
  }
}

async function loadTenantBookings(account, options = {}) {
  const listEl = els.bookings?.list;
  const statusEl = els.bookings?.status;
  const refreshBtn = els.bookings?.refresh;
  const normalized = normaliseAddress(account);

  if (!listEl || !statusEl) {
    return [];
  }

  if (!normalized) {
    bookingRecords.clear();
    listEl.innerHTML = '';
    statusEl.textContent = 'Connect wallet to view bookings.';
    if (refreshBtn) {
      refreshBtn.disabled = true;
    }
    bookingsRendered = false;
    lastBookingsAccount = '';
    return [];
  }

  if (bookingsLoading) {
    try {
      await bookingsLoading;
    } catch {}
  }

  if (!options.force && bookingsRendered && lastBookingsAccount === normalized) {
    return [];
  }

  statusEl.textContent = 'Loading your bookings…';
  if (options.clear !== false) {
    listEl.innerHTML = '';
  }

  let refreshOriginalLabel;
  if (refreshBtn) {
    refreshOriginalLabel = refreshBtn.textContent;
    refreshBtn.disabled = true;
    if (options.showBusyLabel) {
      refreshBtn.textContent = 'Refreshing…';
    }
  }

  const loaderPromise = (async () => {
    await loadConfig();
    let addresses;
    try {
      const result = await pub.readContract({ address: PLATFORM_ADDRESS, abi: PLATFORM_ABI, functionName: 'allListings' });
      addresses = Array.isArray(result) ? result : [];
    } catch (err) {
      throw new Error('Unable to load listing addresses.');
    }
    const cleaned = addresses.filter((addr) => typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr) && !/^0x0+$/.test(addr));
    if (!cleaned.length) {
      return { records: [], message: 'No listings available right now.' };
    }

    const nextCalls = cleaned.map((addr) => ({ address: addr, abi: LISTING_ABI, functionName: 'nextBookingId' }));
    const nextResults = await multicallChunks(nextCalls);
    const bookingMetas = [];
    for (let i = 0; i < cleaned.length; i += 1) {
      const entry = nextResults[i];
      if (!entry || entry.status !== 'success') continue;
      const nextId = toBigInt(entry.result, 0n);
      if (nextId === 0n) continue;
      for (let id = 1n; id <= nextId; id += 1n) {
        bookingMetas.push({ listing: cleaned[i], bookingId: id });
      }
    }

    if (!bookingMetas.length) {
      return { records: [], message: 'No bookings found for this wallet yet.' };
    }

    const bookingCalls = bookingMetas.map((meta) => ({
      address: meta.listing,
      abi: LISTING_ABI,
      functionName: 'bookingInfo',
      args: [meta.bookingId],
    }));
    const bookingResults = await multicallChunks(bookingCalls);
    const pendingCalls = bookingMetas.map((meta) => ({
      address: meta.listing,
      abi: LISTING_ABI,
      functionName: 'pendingTokenisation',
      args: [meta.bookingId],
    }));
    const pendingResults = await multicallChunks(pendingCalls);

    const relevant = [];
    const listingLookup = new Map();

    for (let i = 0; i < bookingResults.length; i += 1) {
      const entry = bookingResults[i];
      if (!entry || entry.status !== 'success') continue;
      const data = normaliseBookingStruct(entry.result);
      if (!data) continue;
      if (!addressesEqual(data.tenant, normalized)) continue;
      const meta = bookingMetas[i];
      const lower = normaliseAddress(meta.listing);
      if (!listingLookup.has(lower)) {
        listingLookup.set(lower, meta.listing);
      }
      const pendingEntry = pendingResults[i];
      const pendingData = pendingEntry && pendingEntry.status === 'success' ? pendingEntry.result : null;
      relevant.push({ meta, data, pending: pendingData });
    }

    if (!relevant.length) {
      return { records: [], message: 'No bookings found for this wallet yet.' };
    }

    const listingAddresses = Array.from(listingLookup.values());
    await Promise.all(listingAddresses.map((addr) => fetchListingInfo(addr).catch(() => null)));

    const records = [];
    for (const item of relevant) {
      const lower = normaliseAddress(item.meta.listing);
      const info = listingInfoCache.get(lower) || null;
      records.push(buildBookingRecord(item.meta, item.data, item.pending, info));
    }
    return { records, message: '' };
  })();

  bookingsLoading = loaderPromise;
  try {
    const { records, message } = await loaderPromise;
    renderBookings(records, message || 'No bookings found for this wallet yet.');
    lastBookingsAccount = normalized;
    bookingsRendered = true;
    return records;
  } catch (err) {
    console.error('Failed to load tenant bookings', err);
    bookingRecords.clear();
    listEl.innerHTML = '';
    statusEl.textContent = 'Unable to load bookings. Please try again.';
    notify({ message: 'Unable to load bookings. Please try again.', variant: 'error', role: 'tenant', timeout: 6000 });
    throw err;
  } finally {
    bookingsLoading = null;
    if (refreshBtn) {
      refreshBtn.disabled = !normalized;
      if (options.showBusyLabel && refreshOriginalLabel !== undefined) {
        refreshBtn.textContent = refreshOriginalLabel;
      }
    }
  }
}

async function loadListings(){
  await loadConfig();
  els.listings.textContent = 'Loading listings…';
  clearSelection();
  listingRecords.clear();
  let addresses;
  try {
    const result = await pub.readContract({ address: PLATFORM_ADDRESS, abi: PLATFORM_ABI, functionName: 'allListings' });
    addresses = Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('Failed to load listing addresses', err);
    els.listings.textContent = 'Unable to load listings.';
    notify({ message: 'Unable to load listings.', variant: 'error', role: 'tenant', timeout: 6000 });
    return;
  }
  const cleaned = addresses.filter((addr) => typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr) && !/^0x0+$/.test(addr));
  if (!cleaned.length) {
    els.listings.textContent = 'No active listings.';
    return;
  }
  const infos = await Promise.all(cleaned.map((addr) => fetchListingInfo(addr)));
  const valid = infos.filter(Boolean);
  if (!valid.length) {
    els.listings.innerHTML = '';
    els.listings.textContent = 'No active listings.';
    notify({ message: 'No active listings right now.', variant: 'warning', role: 'tenant', timeout: 5000 });
    return;
  }
  const entries = valid.map((info) => {
    const record = buildListingRecord(info);
    listingRecords.set(record.id, record);
    if (record.address) {
      listingRecords.set(normaliseAddress(record.address), record);
      listingRecords.set(record.address, record);
    }
    return record;
  });
  renderListings(entries);
  notify({
    message: `Loaded ${entries.length} listing${entries.length === 1 ? '' : 's'}.`,
    variant: 'success',
    role: 'tenant',
    timeout: 4500,
  });
}

async function bookListing(listing = selectedListing){
  try {
    if (!listing) {
      els.status.textContent = 'Select a listing first.';
      notify({ message: 'Select a listing before booking.', variant: 'warning', role: 'tenant', timeout: 4200 });
      return;
    }
    const p = await getProvider();
    const [from] = (await p.request({ method: 'eth_accounts' })) || [];
    if (!from) throw new Error('No wallet account connected.');
    setConnectedAccount(from);
    await ensureArbitrum(p);
    await loadConfig();

    if (supportsViewPassPurchase) {
      let active;
      try {
        active = await pub.readContract({
          address: PLATFORM_ADDRESS,
          abi: PLATFORM_ABI,
          functionName: 'hasActiveViewPass',
          args: [from],
        });
      } catch (err) {
        console.error('Failed to verify view pass before booking', err);
        els.status.textContent = 'Unable to verify view pass status. Please try again.';
        notify({ message: 'Unable to verify view pass status. Try again.', variant: 'error', role: 'tenant', timeout: 5500 });
        return;
      }

      hasActiveViewPass = Boolean(active);
      if (!hasActiveViewPass) {
        viewPassRequired = true;
        updateSummary();
        els.status.textContent = 'Purchase a view pass before booking.';
        notify({ message: 'View pass required before booking.', variant: 'warning', role: 'tenant', timeout: 5000 });
        return;
      }
    }

    const startValue = els.start?.value || '';
    const endValue = els.end?.value || '';
    if (!startValue || !endValue) throw new Error('Select start and end dates.');
    const startMs = Date.parse(`${startValue}T00:00:00Z`);
    const endMs = Date.parse(`${endValue}T00:00:00Z`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error('Invalid dates selected.');
    const startTs = BigInt(Math.floor(startMs / 1000));
    const endTs = BigInt(Math.floor(endMs / 1000));
    if (endTs <= startTs) throw new Error('End date must be after start.');
    const periodKey = els.period ? els.period.value : '';
    const selectedPeriod = PERIOD_OPTIONS[periodKey];
    if (!selectedPeriod) throw new Error("Select how often you'll pay rent.");
    const nowTs = BigInt(Math.floor(Date.now() / 1000));
    if (listing.minBookingNotice > 0n && startTs < nowTs + listing.minBookingNotice) {
      throw new Error(`Start must respect the ${formatDuration(listing.minBookingNotice)} minimum notice.`);
    }
    if (listing.maxBookingWindow > 0n && startTs > nowTs + listing.maxBookingWindow) {
      throw new Error(`Start beyond allowed booking window (${formatDuration(listing.maxBookingWindow)}).`);
    }

    const available = await pub.readContract({
      address: REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: 'isAvailable',
      args: [listing.address, startTs, endTs],
    });
    if (!available) {
      els.status.textContent = 'Selected dates not available.';
      notify({ message: 'Those dates are already booked.', variant: 'warning', role: 'tenant', timeout: 4500 });
      return;
    }

    const rent = calculateRent(listing.baseDailyRate, startTs, endTs);
    const deposit = typeof listing.depositAmount === 'bigint' ? listing.depositAmount : BigInt(listing.depositAmount || 0);
    const installmentCap = calculateInstallmentCap(rent, startTs, endTs, selectedPeriod.days);

    let approveData;
    let needsApproval = false;
    if (deposit > 0n) {
      try {
        const allowanceRaw = await pub.readContract({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [from, listing.address],
        });
        const allowance = typeof allowanceRaw === 'bigint' ? allowanceRaw : BigInt(allowanceRaw || 0);
        needsApproval = allowance < deposit;
      } catch (err) {
        console.warn('Failed to check USDC allowance before booking', err);
        needsApproval = true;
      }
      if (needsApproval) {
        approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [listing.address, deposit] });
      }
    }

    const bookData = encodeFunctionData({
      abi: LISTING_ABI,
      functionName: 'book',
      args: [startTs, endTs, selectedPeriod.value],
    });
    const calls = [];
    if (needsApproval && approveData) {
      calls.push({ to: USDC_ADDRESS, data: approveData });
    }
    calls.push({ to: listing.address, data: bookData });

    const submitSequential = async () => {
      if (needsApproval && approveData) {
        els.status.textContent = 'Wallet does not support batched calls. Approve the deposit, then confirm the booking.';
        await p.request({ method: 'eth_sendTransaction', params: [{ from, to: USDC_ADDRESS, data: approveData }] });
      } else {
        els.status.textContent = 'Wallet does not support batched calls. Confirm the booking transaction.';
      }
      await p.request({ method: 'eth_sendTransaction', params: [{ from, to: listing.address, data: bookData }] });
    };

    const depositMsg = deposit > 0n ? `${formatUsdc(deposit)} USDC deposit` : 'no deposit';
    const rentMsg = rent > 0n ? `${formatUsdc(rent)} USDC rent` : '0 USDC rent';
    const cadenceMsg = installmentCap > 0n
      ? `${selectedPeriod.label} payments up to ${formatUsdc(installmentCap)} USDC`
      : `${selectedPeriod.label} payments`;
    const approvalNotice = needsApproval
      ? ' Confirm the approval and booking when prompted.'
      : '';
    els.status.textContent = `Booking stay (${depositMsg}; rent due later: ${rentMsg}; ${cadenceMsg}).${approvalNotice}`;

    let walletSendUnsupported = false;
    let batchedSuccess = false;
    try {
      const { unsupported } = await requestWalletSendCalls(p, {
        calls,
        from,
        chainId: ARBITRUM_HEX,
      });
      if (!unsupported) {
        batchedSuccess = true;
      } else {
        walletSendUnsupported = true;
      }
    } catch (err) {
      if (isUserRejectedRequestError(err)) {
        const message = 'Booking cancelled by user.';
        els.status.textContent = message;
        notify({ message, variant: 'warning', role: 'tenant', timeout: 5000 });
        return;
      }
      throw err;
    }

    if (!batchedSuccess && walletSendUnsupported) {
      await submitSequential();
      batchedSuccess = true;
    }

    els.status.textContent = 'Booking submitted.';
    notify({ message: 'Booking transaction sent.', variant: 'success', role: 'tenant', timeout: 6000 });
    updateSummary();
    if (connectedAccount) {
      try {
        await loadTenantBookings(connectedAccount, { force: true });
      } catch (err) {
        console.warn('Failed to refresh bookings after booking', err);
      }
    }
  } catch (e) {
    console.error(e);
    if (isUserRejectedRequestError(e)) {
      const message = 'Booking cancelled by user.';
      els.status.textContent = message;
      notify({ message, variant: 'warning', role: 'tenant', timeout: 5000 });
      return;
    }
    const message = e?.message || e;
    els.status.textContent = `Error: ${message}`;
    notify({ message: message ? `Booking failed: ${message}` : 'Booking failed.', variant: 'error', role: 'tenant', timeout: 6000 });
  }
}

async function checkViewPass(){
  try {
    await loadConfig();
    viewPassRequired = false;
    hasActiveViewPass = false;

    if (!supportsViewPassPurchase) {
      els.buy.disabled = true;
      els.status.textContent = 'View pass purchase is not supported in this deployment.';
      hasActiveViewPass = true;
      updateSummary();
      await loadListings();
      return;
    }

    const hasDurationValue = typeof viewPassDuration === 'bigint';
    const duration = hasDurationValue ? viewPassDuration : null;
    if (hasDurationValue && duration === 0n) {
      els.buy.disabled = true;
      els.status.textContent = 'View pass not required.';
      hasActiveViewPass = true;
      updateSummary();
      await loadListings();
      return;
    }

    els.buy.disabled = false;
    viewPassRequired = true;
    if (!hasDurationValue) {
      console.warn('View pass duration unavailable; assuming view pass required.');
    }

    const p = await getProvider();
    const [addr] = (await p.request({ method: 'eth_accounts' })) || [];
    if (!addr) {
      setConnectedAccount(null);
      els.status.textContent = 'Connect wallet to verify your view pass status.';
      hasActiveViewPass = false;
      updateSummary();
      await loadListings();
      await loadTenantBookings(null);
      return;
    }
    setConnectedAccount(addr);

    const [expiryRaw, activeRaw] = await Promise.all([
      pub
        .readContract({ address: PLATFORM_ADDRESS, abi: PLATFORM_ABI, functionName: 'viewPassExpiry', args: [addr] })
        .catch((err) => {
          console.error('Failed to load view pass expiry', err);
          return 0n;
        }),
      pub
        .readContract({ address: PLATFORM_ADDRESS, abi: PLATFORM_ABI, functionName: 'hasActiveViewPass', args: [addr] })
        .then((value) => Boolean(value))
        .catch((err) => {
          console.error('Failed to load view pass status', err);
          return null;
        }),
    ]);

    if (activeRaw === null) {
      els.status.textContent = 'Unable to verify view pass status. Please try again.';
      hasActiveViewPass = false;
      updateSummary();
      await loadListings();
      return;
    }

    const expiry = typeof expiryRaw === 'bigint' ? expiryRaw : BigInt(expiryRaw || 0);
    const active = Boolean(activeRaw);
    const now = BigInt(Math.floor(Date.now() / 1000));
    hasActiveViewPass = active;

    if (active) {
      const remaining = expiry > now ? expiry - now : 0n;
      const remainingLabel = remaining > 0n ? formatDuration(remaining) : 'Expiring soon';
      const expiresAt = formatTimestamp(expiry);
      if (hasDurationValue) {
        els.status.textContent = `View pass active (${remainingLabel}${expiresAt ? `, expires ${expiresAt}` : ''}).`;
      } else {
        els.status.textContent = 'View pass active.';
      }
    } else {
      const expiredAt = expiry > 0n ? formatTimestamp(expiry) : '';
      let requirement;
      if (typeof viewPassPrice === 'bigint' && viewPassPrice > 0n) {
        requirement = ` Purchase required (${formatUsdc(viewPassPrice)} USDC).`;
      } else if (!hasDurationValue) {
        requirement = ' Unable to load pass details — assume purchase required.';
      } else {
        requirement = ' Purchase required.';
      }
      els.status.textContent = `No active view pass.${expiredAt ? ` Expired ${expiredAt}.` : ''}${requirement}`;
    }

    updateSummary();
    await loadListings();
  } catch (e) {
    console.error(e);
    els.status.textContent = 'Unable to verify view pass status.';
    updateSummary();
  }
}

// ——— Connect ———
if (els.confirmBooking) {
  els.confirmBooking.onclick = () => bookListing();
}

if (els.bookings?.refresh) {
  els.bookings.refresh.onclick = () => {
    if (!connectedAccount) {
      notify({ message: 'Connect your wallet to refresh bookings.', variant: 'warning', role: 'tenant', timeout: 4200 });
      return;
    }
    loadTenantBookings(connectedAccount, { force: true, showBusyLabel: true }).catch((err) => {
      console.warn('Failed to refresh bookings', err);
    });
  };
}

els.connect.onclick = async () => {
  try {
    if (!inHost) { els.status.textContent = 'Open in Farcaster app to connect wallet.'; return; }
    if (!(await hostSupportsWallet())) { els.status.textContent = 'This client does not support wallets for Mini Apps.'; return; }
    const p = await getProvider();
    await p.request({ method: 'eth_requestAccounts' });
    const [addr] = await p.request({ method: 'eth_accounts' });
    if (!addr) throw new Error('No account found.');
    await ensureArbitrum(p);
    setConnectedAccount(addr);
    els.buy.disabled = true;
    els.status.textContent = 'Ready.';
    await checkViewPass();
    if (connectedAccount) {
      try {
        await loadTenantBookings(connectedAccount, { force: true });
      } catch (err) {
        console.warn('Failed to load bookings after connecting', err);
      }
    }
  } catch (e) { console.error(e); els.status.textContent = e?.message || 'Wallet connection failed.'; }
};

// ——— Buy pass ———
els.buy.onclick = async () => {
  try {
    if (!supportsViewPassPurchase) {
      els.status.textContent = 'View pass purchase is not supported in this deployment.';
      return;
    }
    const p = await getProvider();
    const [from] = await p.request({ method: 'eth_accounts' }) || [];
    if (!from) throw new Error('No wallet account connected.');
    setConnectedAccount(from);
    await ensureArbitrum(p);
    await loadConfig();
    const hasDurationValue = typeof viewPassDuration === 'bigint';
    const duration = hasDurationValue ? viewPassDuration : 0n;
    if (hasDurationValue && duration === 0n) {
      els.status.textContent = 'View pass not required right now.';
      return;
    }
    if (!hasDurationValue) {
      console.warn('View pass duration unavailable while purchasing; proceeding with best effort.');
    }
    const price = typeof viewPassPrice === 'bigint' ? viewPassPrice : 0n;
    if (typeof viewPassPrice !== 'bigint') {
      console.warn('View pass price unavailable, defaulting to 0.');
    }
    let approveData;
    const calls = [];
    if (price > 0n) {
      approveData = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PLATFORM_ADDRESS, price] });
      calls.push({ to: USDC_ADDRESS, data: approveData });
    }
    const buyData = encodeFunctionData({ abi: PLATFORM_ABI, functionName: 'buyViewPass', args: [] });
    calls.push({ to: PLATFORM_ADDRESS, data: buyData });
    els.status.textContent = price > 0n ? 'Approving & purchasing…' : 'Purchasing view pass…';
    let walletSendUnsupported = false;
    try {
      const { unsupported } = await requestWalletSendCalls(p, {
        calls,
        from,
        chainId: ARBITRUM_HEX,
      });
      walletSendUnsupported = unsupported;
    } catch (err) {
      if (isUserRejectedRequestError(err)) {
        els.status.textContent = 'Purchase cancelled by user.';
        return;
      }
      throw err;
    }

    if (walletSendUnsupported) {
      if (price > 0n && approveData) {
        await p.request({ method: 'eth_sendTransaction', params: [{ from, to: USDC_ADDRESS, data: approveData }] });
      }
      await p.request({ method: 'eth_sendTransaction', params: [{ from, to: PLATFORM_ADDRESS, data: buyData }] });
    }

    els.status.textContent = 'Success. View pass purchased.';
    alert('View pass purchased!');
    await checkViewPass();
    if (connectedAccount) {
      try {
        await loadTenantBookings(connectedAccount, { force: true });
      } catch (err) {
        console.warn('Failed to refresh bookings after purchasing view pass', err);
      }
    }
  } catch (err) {
    console.error(err);
    if (isUserRejectedRequestError(err)) {
      els.status.textContent = 'Purchase cancelled by user.';
      return;
    }
    els.status.textContent = `Error: ${err?.message || err}`;
  }
};

loadConfig().catch((err) => console.error('Initial config load failed', err));

async function payRent(record, options = {}) {
  const target = record && record.key ? bookingRecords.get(record.key) || record : record;
  if (!target) {
    notify({ message: 'Unable to find booking details for payment.', variant: 'error', role: 'tenant', timeout: 5000 });
    return;
  }
  if (!target.canPayRent) {
    notify({ message: 'This booking is not accepting rent payments right now.', variant: 'warning', role: 'tenant', timeout: 5000 });
    return;
  }

  const defaultAmount = target.rentDue > 0n ? formatUsdc(target.rentDue) : '';
  const promptValue = options.amount ?? window.prompt('Enter rent amount in USDC', defaultAmount);
  if (promptValue === null || promptValue === undefined) {
    return;
  }
  const parsedAmount = parseUsdcInput(String(promptValue));
  if (parsedAmount === null) {
    notify({ message: 'Enter a valid USDC amount (up to 6 decimals).', variant: 'warning', role: 'tenant', timeout: 4500 });
    return;
  }
  if (parsedAmount <= 0n) {
    notify({ message: 'Rent payments must be greater than 0 USDC.', variant: 'warning', role: 'tenant', timeout: 4500 });
    return;
  }
  if (target.rentDue > 0n && parsedAmount > target.rentDue) {
    notify({
      message: `You can pay at most ${formatUsdc(target.rentDue)} USDC right now.`,
      variant: 'warning',
      role: 'tenant',
      timeout: 5000,
    });
    return;
  }

  try {
    const p = await getProvider();
    const accounts = (await p.request({ method: 'eth_accounts' })) || [];
    const [from] = accounts;
    if (!from) {
      throw new Error('No wallet account connected.');
    }
    if (!addressesEqual(from, target.tenantLower)) {
      const message = 'Connected wallet does not match the booking tenant.';
      els.status.textContent = message;
      notify({ message, variant: 'error', role: 'tenant', timeout: 6000 });
      return;
    }
    setConnectedAccount(from);
    await ensureArbitrum(p);
    await loadConfig();

    let allowance = 0n;
    try {
      const allowanceRaw = await pub.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [from, target.listingAddress],
      });
      allowance = toBigInt(allowanceRaw, 0n);
    } catch (err) {
      console.warn('Failed to read USDC allowance before rent payment', err);
      allowance = 0n;
    }

    const needsApproval = allowance < parsedAmount;
    let approveData;
    const calls = [];
    if (needsApproval) {
      approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [target.listingAddress, parsedAmount],
      });
      calls.push({ to: USDC_ADDRESS, data: approveData });
    }
    const payData = encodeFunctionData({
      abi: LISTING_ABI,
      functionName: 'payRent',
      args: [target.bookingId, parsedAmount],
    });
    calls.push({ to: target.listingAddress, data: payData });

    els.status.textContent = `Submitting rent payment (${formatUsdc(parsedAmount)} USDC)…`;

    let walletSendUnsupported = false;
    let batchedSuccess = false;
    try {
      const { unsupported } = await requestWalletSendCalls(p, {
        calls,
        from,
        chainId: ARBITRUM_HEX,
      });
      batchedSuccess = !unsupported;
      walletSendUnsupported = unsupported;
    } catch (err) {
      if (isUserRejectedRequestError(err)) {
        els.status.textContent = 'Rent payment cancelled by user.';
        notify({ message: 'Rent payment cancelled.', variant: 'warning', role: 'tenant', timeout: 5000 });
        return;
      }
      throw err;
    }

    if (!batchedSuccess && walletSendUnsupported) {
      if (needsApproval && approveData) {
        els.status.textContent = `Approve USDC, then confirm rent payment (${formatUsdc(parsedAmount)} USDC).`;
        await p.request({ method: 'eth_sendTransaction', params: [{ from, to: USDC_ADDRESS, data: approveData }] });
      } else {
        els.status.textContent = `Confirm rent payment (${formatUsdc(parsedAmount)} USDC).`;
      }
      await p.request({ method: 'eth_sendTransaction', params: [{ from, to: target.listingAddress, data: payData }] });
    }

    els.status.textContent = 'Rent payment submitted.';
    notify({
      message: `Rent payment of ${formatUsdc(parsedAmount)} USDC submitted.`,
      variant: 'success',
      role: 'tenant',
      timeout: 6000,
    });

    try {
      await loadTenantBookings(connectedAccount, { force: true, showBusyLabel: true });
    } catch (err) {
      console.warn('Failed to refresh bookings after rent payment', err);
    }
  } catch (err) {
    console.error('Rent payment failed', err);
    if (isUserRejectedRequestError(err)) {
      els.status.textContent = 'Rent payment cancelled by user.';
      notify({ message: 'Rent payment cancelled.', variant: 'warning', role: 'tenant', timeout: 5000 });
    } else {
      const message = extractErrorMessage(err) || err?.message || 'Rent payment failed.';
      els.status.textContent = `Rent payment failed: ${message}`;
      notify({ message: `Rent payment failed: ${message}`, variant: 'error', role: 'tenant', timeout: 6500 });
    }
  }
}

