import { sdk } from 'https://esm.sh/@farcaster/miniapp-sdk';
import { createPublicClient, http, encodeFunctionData, erc20Abi } from 'https://esm.sh/viem@2.9.32';
import { arbitrum } from 'https://esm.sh/viem/chains';
import { notify, mountNotificationCenter } from './notifications.js';
import { requestWalletSendCalls, isUserRejectedRequestError, extractErrorMessage } from './wallet.js';
import {
  RPC_URL,
  PLATFORM_ADDRESS,
  PLATFORM_ABI,
  LISTING_ABI,
  R3NT_ADDRESS,
  R3NT_ABI,
  APP_VERSION,
  USDC_ADDRESS,
} from './config.js';
import createBackController from './back-navigation.js';
import { BookingCard, TokenisationCard } from './ui/cards.js';
import { actionsFor } from './ui/actions.js';

const ARBITRUM_HEX = '0xa4b1';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const USDC_SCALAR = 1_000_000n;
const listingDescriptorCache = new Map();
const PERIOD_LABELS = {
  0: 'Unspecified',
  1: 'Daily',
  2: 'Weekly',
  3: 'Monthly',
};
const BOOKING_STATUS = {
  ACTIVE: 1,
};

const els = {
  connect: document.getElementById('connect'),
  walletAddress: document.getElementById('walletAddress'),
  status: document.getElementById('status'),
  holdingsList: document.getElementById('holdingsList'),
  tokenisationDashboard: document.getElementById('tokenisationDashboard'),
  rentDashboard: document.getElementById('rentDashboard'),
};

if (els.connect && !els.connect.dataset.defaultLabel) {
  const initialLabel = (els.connect.textContent || '').trim();
  if (initialLabel) {
    els.connect.dataset.defaultLabel = initialLabel;
  }
}

mountNotificationCenter(document.getElementById('notificationTray'), { role: 'investor' });

const pub = createPublicClient({ chain: arbitrum, transport: http(RPC_URL || 'https://arb1.arbitrum.io/rpc') });
let provider;
const state = { account: null, holdings: [] };
let investorDataLoading = false;
const investorListingEventWatchers = new Map();
const investorEventRefreshState = { timer: null, messages: new Set(), running: false };
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

function normaliseAddress(addr) {
  if (typeof addr !== 'string') {
    return '';
  }
  return addr.trim().toLowerCase();
}

function toBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') {
    return value;
  }
  try {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return BigInt(value);
    }
    if (typeof value === 'string' && value.trim()) {
      return BigInt(value.trim());
    }
    if (value === null || value === undefined) {
      return fallback;
    }
    return BigInt(value);
  } catch {
    return fallback;
  }
}

function toNonNegativeInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const truncated = Math.trunc(value);
    return truncated >= 0 ? truncated : null;
  }
  if (typeof value === 'bigint') {
    return value >= 0n ? Number(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || /[^0-9]/.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return parsed >= 0 ? parsed : null;
  }
  if (value && typeof value === 'object' && 'index' in value) {
    return toNonNegativeInteger(value.index);
  }
  return null;
}

function extractSuccessfulIndexes(partial) {
  if (!Array.isArray(partial)) {
    return [];
  }
  const indexes = [];
  for (const entry of partial) {
    const index = toNonNegativeInteger(entry);
    if (index == null) {
      continue;
    }
    const success = entry && typeof entry === 'object' && 'success' in entry ? Boolean(entry.success) : true;
    if (!success) {
      continue;
    }
    indexes.push(index);
  }
  return indexes;
}

function isDevConsoleOpen(settings) {
  if (settings && typeof settings.devConsoleOpen === 'boolean') {
    return Boolean(settings.devConsoleOpen);
  }
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const widthDiff = Math.abs(window.outerWidth - window.innerWidth);
    const heightDiff = Math.abs(window.outerHeight - window.innerHeight);
    return widthDiff > 160 || heightDiff > 160;
  } catch {
    return false;
  }
}

if (typeof window !== 'undefined' && typeof window.__R3NT_TRACE_LOG__ !== 'function') {
  window.__R3NT_TRACE_LOG__ = () => {};
}

function traceInvestmentStep(step, details) {
  if (typeof window === 'undefined') {
    return;
  }
  const settings = window.__R3NT_DEV_SETTINGS__ || {};
  const enabled = settings.traceInvest ?? isDevConsoleOpen(settings);
  if (!enabled) {
    return;
  }
  if (details !== undefined) {
    console.info('[invest][%s]', step, details);
  } else {
    console.info('[invest][%s]', step);
  }
  const tracer = window.__R3NT_TRACE_LOG__;
  if (typeof tracer === 'function') {
    try {
      tracer('investInSale', { step, details, timestamp: Date.now() });
    } catch {}
  }
}

function makeBookingKey(listingAddress, bookingId) {
  const addr = typeof listingAddress === 'string' ? listingAddress.toLowerCase() : '';
  let idPart = '';
  if (typeof bookingId === 'bigint') {
    idPart = bookingId.toString();
  } else if (typeof bookingId === 'number') {
    idPart = Number.isFinite(bookingId) ? bookingId.toString() : '';
  } else if (typeof bookingId === 'string') {
    idPart = bookingId.trim();
  } else {
    try {
      idPart = BigInt(bookingId || 0).toString();
    } catch {
      idPart = String(bookingId ?? '');
    }
  }
  return `${addr}::${idPart}`;
}

function normaliseMetadataUrl(uri) {
  if (!uri || typeof uri !== 'string') return '';
  return uri;
}

function decodeDataUri(uri) {
  const match = /^data:([^;,]*)(;charset=[^;,]*)?(;base64)?,([\s\S]*)$/i.exec(uri || '');
  if (!match) return null;
  const isBase64 = Boolean(match[3]);
  const payload = match[4] || '';
  try {
    if (isBase64) {
      const cleaned = payload.replace(/\s/g, '');
      const atobFn = typeof globalThis !== 'undefined' && typeof globalThis.atob === 'function'
        ? (value) => globalThis.atob(value)
        : null;
      if (!atobFn) return null;
      return atobFn(cleaned);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

async function fetchListingMetadataDetails(uri, fallbackAddress) {
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

async function loadListingDescriptor(listingAddress) {
  const fallbackTitle = shortAddress(listingAddress);
  const fallbackResult = { metadataURI: '', title: fallbackTitle, description: '' };
  if (!listingAddress || typeof listingAddress !== 'string') {
    return fallbackResult;
  }
  const cacheKey = listingAddress.toLowerCase();
  if (listingDescriptorCache.has(cacheKey)) {
    return listingDescriptorCache.get(cacheKey);
  }
  let metadataURI = '';
  try {
    const raw = await pub.readContract({ address: listingAddress, abi: LISTING_ABI, functionName: 'metadataURI' });
    if (typeof raw === 'string') {
      metadataURI = raw;
    }
  } catch (err) {
    console.warn('Failed to load listing metadataURI', listingAddress, err);
  }
  const details = await fetchListingMetadataDetails(metadataURI, fallbackTitle);
  const descriptor = {
    metadataURI,
    title: details.title && details.title.trim() ? details.title.trim() : fallbackTitle,
    description: details.description && details.description.trim() ? details.description.trim() : '',
  };
  if (descriptor.description === descriptor.title) {
    descriptor.description = '';
  }
  listingDescriptorCache.set(cacheKey, descriptor);
  return descriptor;
}

function formatPeriodLabel(periodValue) {
  let numeric = 0;
  if (typeof periodValue === 'bigint') {
    numeric = Number(periodValue);
  } else if (typeof periodValue === 'number') {
    numeric = periodValue;
  } else if (typeof periodValue === 'string' && periodValue.trim()) {
    const parsed = Number.parseInt(periodValue, 10);
    if (Number.isFinite(parsed)) {
      numeric = parsed;
    }
  }
  if (!Number.isFinite(numeric) || numeric < 0) {
    numeric = 0;
  }
  if (Object.prototype.hasOwnProperty.call(PERIOD_LABELS, numeric)) {
    return PERIOD_LABELS[numeric];
  }
  return numeric > 0 ? 'Custom cadence' : PERIOD_LABELS[0];
}

function percentOf(numerator, denominator) {
  const num = typeof numerator === 'bigint' ? numerator : BigInt(numerator || 0);
  const den = typeof denominator === 'bigint' ? denominator : BigInt(denominator || 0);
  if (den <= 0n) return null;
  const scaled = (num * 10000n) / den;
  return Number(scaled) / 100;
}

function createCopyButton(text, { label = 'Copy', successMessage = 'Copied to clipboard.', errorMessage = 'Unable to copy.' } = {}) {
  const trimmed = typeof text === 'string' ? text.trim() : String(text ?? '').trim();
  if (!trimmed || !navigator?.clipboard?.writeText) {
    return null;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-button';
  button.textContent = '⧉';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(trimmed);
      notify({ message: successMessage, variant: 'success', role: 'investor', timeout: 4000 });
    } catch (err) {
      console.error('Failed to copy value', err);
      notify({ message: errorMessage, variant: 'error', role: 'investor', timeout: 5000 });
    }
  });
  return button;
}

function createBookingBadge(bookingId) {
  const wrapper = document.createElement('div');
  wrapper.className = 'badge-with-copy';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = `Booking #${bookingId}`;
  wrapper.appendChild(badge);
  const copyBtn = createCopyButton(bookingId, {
    label: 'Copy booking ID',
    successMessage: 'Booking ID copied to clipboard.',
    errorMessage: 'Unable to copy booking ID.',
  });
  if (copyBtn) {
    wrapper.appendChild(copyBtn);
  }
  return wrapper;
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

function updateConnectedAccount(addr) {
  const previousAccount = state.account;
  const previousNormalised = normaliseAddress(previousAccount);
  const value = typeof addr === 'string' ? addr : null;
  const nextNormalised = normaliseAddress(value);
  state.account = value;
  if (!value || (previousNormalised && nextNormalised && previousNormalised !== nextNormalised)) {
    resetInvestorRefreshQueue();
    clearInvestorEventWatchers();
  }
  if (els.connect) {
    if (!els.connect.dataset.defaultLabel) {
      const initialLabel = (els.connect.textContent || '').trim();
      if (initialLabel) {
        els.connect.dataset.defaultLabel = initialLabel;
      }
    }
    els.connect.classList.toggle('is-connected', Boolean(value));
    if (value) {
      els.connect.textContent = 'Wallet Connected';
    } else {
      const fallback = els.connect.dataset.defaultLabel || 'Connect wallet';
      els.connect.textContent = fallback;
    }
  }
  if (els.walletAddress) {
    if (value) {
      els.walletAddress.textContent = `Connected: ${shortAddress(value)}`;
    } else {
      els.walletAddress.textContent = 'Not connected';
    }
  }
}

function createSelectionFromEntry(entry) {
  if (!entry) return null;
  const listingAddress = typeof entry.listingAddress === 'string' ? entry.listingAddress : '';
  let bookingIdRaw = 0n;
  try {
    bookingIdRaw = typeof entry.bookingId === 'bigint' ? entry.bookingId : BigInt(entry.bookingId ?? 0);
  } catch {
    bookingIdRaw = 0n;
  }
  const bookingId = Number(bookingIdRaw);
  const totalSqmu = typeof entry.totalSqmu === 'bigint' ? entry.totalSqmu : BigInt(entry.totalSqmu ?? 0);
  const soldSqmu = typeof entry.soldSqmu === 'bigint' ? entry.soldSqmu : BigInt(entry.soldSqmu ?? 0);
  const remainingSqmu = totalSqmu > soldSqmu ? totalSqmu - soldSqmu : 0n;
  const pricePerSqmu = typeof entry.pricePerSqmu === 'bigint' ? entry.pricePerSqmu : BigInt(entry.pricePerSqmu ?? 0);
  const feeBps = Number(entry.feeBps ?? 0);
  const propertyTitle = entry.propertyTitle || '';
  const propertyDescription = entry.propertyDescription || '';
  const periodLabel = (entry.periodLabel || '').trim() || formatPeriodLabel(entry.period);
  return {
    key: makeBookingKey(listingAddress, bookingIdRaw),
    listingAddress,
    listingAddressLower: listingAddress.toLowerCase(),
    bookingId,
    bookingIdRaw,
    totalSqmu,
    soldSqmu,
    remainingSqmu,
    pricePerSqmu,
    feeBps,
    propertyTitle,
    propertyDescription,
    periodLabel,
  };
}

const BOOKING_STATUS_LABELS = {
  0: 'Pending',
  1: 'Active',
  2: 'Completed',
  3: 'Cancelled',
  4: 'Defaulted',
};

const BOOKING_STATUS_CLASS_MAP = {
  0: 'pending',
  1: 'active',
  2: 'completed',
  3: 'cancelled',
  4: 'defaulted',
};

function normaliseStatusValue(statusValue) {
  if (typeof statusValue === 'bigint') {
    const numeric = Number(statusValue);
    return Number.isFinite(numeric) ? numeric : 0;
  }
  if (typeof statusValue === 'number' && Number.isFinite(statusValue)) {
    return statusValue;
  }
  if (typeof statusValue === 'string' && statusValue.trim()) {
    const parsed = Number.parseInt(statusValue, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function formatBookingStatus(statusValue) {
  const numeric = normaliseStatusValue(statusValue);
  return BOOKING_STATUS_LABELS[numeric] || BOOKING_STATUS_LABELS[0];
}

function getBookingStatusClass(statusValue) {
  const numeric = normaliseStatusValue(statusValue);
  return BOOKING_STATUS_CLASS_MAP[numeric] || '';
}

function formatBookingDates(startSeconds, endSeconds) {
  const start = typeof startSeconds === 'bigint' ? Number(startSeconds) : Number(startSeconds ?? 0);
  const end = typeof endSeconds === 'bigint' ? Number(endSeconds) : Number(endSeconds ?? 0);
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end) || end <= 0) {
    return '—';
  }
  const startDate = new Date(start * 1000);
  const endDate = new Date(end * 1000);
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  const startLabel = startDate.toLocaleDateString(undefined, opts);
  const endLabel = endDate.toLocaleDateString(undefined, opts);
  return `${startLabel} → ${endLabel}`;
}

function resetInvestorRefreshQueue() {
  if (investorEventRefreshState.timer) {
    clearTimeout(investorEventRefreshState.timer);
    investorEventRefreshState.timer = null;
  }
  investorEventRefreshState.messages.clear();
  investorEventRefreshState.running = false;
}

function clearInvestorEventWatchers() {
  for (const unwatchers of investorListingEventWatchers.values()) {
    for (const stop of unwatchers) {
      try {
        if (typeof stop === 'function') {
          stop();
        }
      } catch (err) {
        console.warn('Failed to remove investor event watcher', err);
      }
    }
  }
  investorListingEventWatchers.clear();
}

function queueInvestorDataRefresh(message) {
  if (!state.account) {
    return;
  }
  if (message) {
    investorEventRefreshState.messages.add(message);
  }
  if (investorEventRefreshState.timer) {
    return;
  }
  investorEventRefreshState.timer = setTimeout(processInvestorEventRefresh, 1200);
}

async function processInvestorEventRefresh() {
  investorEventRefreshState.timer = null;
  if (!state.account) {
    investorEventRefreshState.messages.clear();
    investorEventRefreshState.running = false;
    return;
  }
  if (investorDataLoading || investorEventRefreshState.running) {
    investorEventRefreshState.timer = setTimeout(processInvestorEventRefresh, 1200);
    return;
  }
  const messages = Array.from(investorEventRefreshState.messages);
  investorEventRefreshState.messages.clear();
  investorEventRefreshState.running = true;
  const summary = messages.length ? messages.join(' • ') : 'On-chain update detected';
  setStatus(`${summary}. Refreshing dashboards…`);
  let success = false;
  try {
    success = await loadInvestorData(state.account, { silent: true });
  } catch (err) {
    console.error('Investor dashboard refresh failed', err);
  }
  if (success) {
    setStatus(`${summary}. Dashboards updated.`);
  }
  investorEventRefreshState.running = false;
  if (investorEventRefreshState.messages.size > 0) {
    investorEventRefreshState.timer = setTimeout(processInvestorEventRefresh, 1200);
  }
}

function createInvestorListingWatchers(listingAddress) {
  const watchers = [];
  const register = (eventName, handler) => {
    try {
      const unwatch = pub.watchContractEvent({
        address: listingAddress,
        abi: LISTING_ABI,
        eventName,
        pollingInterval: 8000,
        onLogs: (logs) => {
          if (!Array.isArray(logs) || logs.length === 0) {
            return;
          }
          for (const log of logs) {
            try {
              handler(log);
            } catch (err) {
              console.error(`Investor event handler error (${eventName})`, err);
            }
          }
        },
        onError: (err) => {
          console.error(`Investor event watcher error (${eventName})`, err);
        },
      });
      if (typeof unwatch === 'function') {
        watchers.push(unwatch);
      }
    } catch (err) {
      console.error('Failed to watch investor event', eventName, listingAddress, err);
    }
  };

  const shortListing = shortAddress(listingAddress);

  register('TokenisationProposed', (log) => {
    const bookingId = toBigInt(log?.args?.bookingId);
    const proposer = typeof log?.args?.proposer === 'string' ? log.args.proposer : '';
    const bookingLabel = bookingId > 0n ? bookingId.toString() : '?';
    const proposerLabel = proposer ? shortAddress(proposer) : 'unknown';
    const message = `Tokenisation proposed for booking #${bookingLabel} on ${shortListing} by ${proposerLabel}.`;
    notify({ message, variant: 'info', role: 'investor', timeout: 6000 });
    queueInvestorDataRefresh(`Tokenisation proposal update for booking #${bookingLabel}`);
  });

  register('TokenisationApproved', (log) => {
    const bookingId = toBigInt(log?.args?.bookingId);
    const bookingLabel = bookingId > 0n ? bookingId.toString() : '?';
    const message = `Tokenisation approved for booking #${bookingLabel} on ${shortListing}.`;
    notify({ message, variant: 'success', role: 'investor', timeout: 6000 });
    queueInvestorDataRefresh(`Tokenisation approved for booking #${bookingLabel}`);
  });

  register('SQMUTokensMinted', (log) => {
    const bookingId = toBigInt(log?.args?.bookingId);
    const bookingLabel = bookingId > 0n ? bookingId.toString() : '?';
    const investorAddr = typeof log?.args?.investor === 'string' ? log.args.investor : '';
    const sqmuAmount = toBigInt(log?.args?.sqmuAmount);
    const investorLabel = investorAddr ? shortAddress(investorAddr) : 'unknown';
    const message = `${investorLabel} purchased ${sqmuAmount.toString()} SQMU for booking #${bookingLabel} on ${shortListing}.`;
    notify({ message, variant: 'success', role: 'investor', timeout: 6000 });
    queueInvestorDataRefresh(`SQMU sale update for booking #${bookingLabel}`);
  });

  register('RentPaid', (log) => {
    const bookingId = toBigInt(log?.args?.bookingId);
    const bookingLabel = bookingId > 0n ? bookingId.toString() : '?';
    const payer = typeof log?.args?.payer === 'string' ? log.args.payer : '';
    const netAmount = toBigInt(log?.args?.netAmount);
    const message = `Rent paid for booking #${bookingLabel} on ${shortListing}: ${formatUsdc(netAmount)} USDC net (payer ${shortAddress(payer) || 'unknown'}).`;
    notify({ message, variant: 'success', role: 'investor', timeout: 6000 });
    queueInvestorDataRefresh(`Rent payment for booking #${bookingLabel}`);
  });

  register('Claimed', (log) => {
    const bookingId = toBigInt(log?.args?.bookingId);
    const bookingLabel = bookingId > 0n ? bookingId.toString() : '?';
    const account = typeof log?.args?.account === 'string' ? log.args.account : '';
    const amount = toBigInt(log?.args?.amount);
    const accountLabel = account ? shortAddress(account) : 'unknown';
    const message = `${accountLabel} claimed ${formatUsdc(amount)} USDC from booking #${bookingLabel} on ${shortListing}.`;
    notify({ message, variant: 'info', role: 'investor', timeout: 6000 });
    queueInvestorDataRefresh(`Claim update for booking #${bookingLabel}`);
  });

  return watchers;
}

function syncInvestorListingEventWatchers(addresses) {
  if (!state.account) {
    return;
  }
  const desired = new Set();
  if (Array.isArray(addresses)) {
    for (const address of addresses) {
      const normalised = normaliseAddress(address);
      if (!normalised) {
        continue;
      }
      desired.add(normalised);
      if (investorListingEventWatchers.has(normalised)) {
        continue;
      }
      const watchers = createInvestorListingWatchers(address);
      if (watchers.length) {
        investorListingEventWatchers.set(normalised, watchers);
      }
    }
  }
  for (const [address, unwatchers] of investorListingEventWatchers) {
    if (desired.has(address)) {
      continue;
    }
    for (const stop of unwatchers) {
      try {
        if (typeof stop === 'function') {
          stop();
        }
      } catch (err) {
        console.warn('Failed to remove stale investor watcher', err);
      }
    }
    investorListingEventWatchers.delete(address);
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
  const descriptor = await loadListingDescriptor(listingAddress);
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
    let period = 0n;
    try {
      period = typeof info.period === 'bigint' ? info.period : BigInt(info.period ?? 0);
    } catch {
      period = 0n;
    }
    const periodLabel = formatPeriodLabel(period);
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
    if (totalSqmu > 0n && soldSqmu >= totalSqmu && balance === 0n) {
      continue;
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
      period,
      periodLabel,
      start: info.start,
      end: info.end,
      deposit: BigInt(info.deposit ?? 0),
      expectedNetRent: BigInt(info.expectedNetRent ?? 0),
      status: info.status,
      metadataURI: descriptor.metadataURI,
      propertyTitle: descriptor.title,
      propertyDescription: descriptor.description,
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
    const statusLabel = formatBookingStatus(entry.status);
    const statusClass = getBookingStatusClass(entry.status);
    const periodLabel = (entry.periodLabel || '').trim() || formatPeriodLabel(entry.period);
    const actions = actionsFor({
      role: 'investor',
      entity: 'booking',
      perms: {
        onClaim: (event) => claimRent(entry, event?.currentTarget),
        canClaim: true,
      },
    }).map((action) => {
      if (action.label === 'Claim rent' && entry.claimable > 0n) {
        return { ...action, label: `Claim ${formatUsdc(entry.claimable)} USDC` };
      }
      return action;
    });

    const card = BookingCard({
      bookingId: entry.bookingId,
      listingId: shortAddress(entry.listingAddress),
      dates: formatBookingDates(entry.start, entry.end),
      period: periodLabel,
      depositUSDC: null,
      rentUSDC: null,
      status: statusLabel,
      statusClass,
      actions,
    });

    if (statusClass) {
      card.classList.add(`booking-status-${statusClass}`);
    }

    const header = card.querySelector('.card-header');
    if (header) {
      const listingLabel = document.createElement('div');
      listingLabel.className = 'muted mono';
      listingLabel.textContent = shortAddress(entry.listingAddress);
      header.appendChild(listingLabel);
    }

    const actionsContainer = card.querySelector('.card-actions');
    const claimButton = actionsContainer?.querySelector('button');
    if (claimButton) {
      claimButton.disabled = entry.claimable <= 0n;
      if (entry.claimable <= 0n) {
        claimButton.classList.add('secondary');
      }
    }

    const metrics = document.createElement('div');
    metrics.className = 'metric-row';

    const balanceMetric = document.createElement('div');
    balanceMetric.className = 'metric';
    balanceMetric.innerHTML = '<label>Balance</label>';
    const balanceValue = document.createElement('span');
    balanceValue.textContent = `${entry.balance.toString()} SQMU-R`;
    balanceMetric.appendChild(balanceValue);
    metrics.appendChild(balanceMetric);

    const claimMetric = document.createElement('div');
    claimMetric.className = 'metric';
    claimMetric.innerHTML = '<label>Claimable rent</label>';
    const claimValue = document.createElement('span');
    claimValue.textContent = `${formatUsdc(entry.claimable)} USDC`;
    if (entry.claimable > 0n) {
      claimValue.classList.add('highlight');
    }
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

    if (actionsContainer) {
      card.insertBefore(metrics, actionsContainer);
    } else {
      card.appendChild(metrics);
    }

    const progress = document.createElement('div');
    progress.className = 'token-progress';
    const soldPct = percentOf(entry.soldSqmu, entry.totalSqmu);
    if (soldPct != null) {
      progress.textContent = `Sold ${entry.soldSqmu.toString()} of ${entry.totalSqmu.toString()} SQMU-R (${soldPct.toFixed(2)}%)`;
    } else {
      progress.textContent = 'Not tokenised yet.';
    }
    if (actionsContainer) {
      card.insertBefore(progress, actionsContainer);
    } else {
      card.appendChild(progress);
    }

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
    empty.textContent = 'No in-progress tokenisation raises right now.';
    container.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const sale = createSelectionFromEntry(entry);
    if (!sale) {
      continue;
    }

    const isActive = normaliseStatusValue(entry.status) === BOOKING_STATUS.ACTIVE;
    const statusLabel = formatBookingStatus(entry.status);
    const statusClass = getBookingStatusClass(entry.status);

    const priceDisplay = Number(sale.pricePerSqmu ?? 0n) / Number(USDC_SCALAR);
    const card = TokenisationCard({
      bookingId: entry.bookingId,
      totalSqmu: sale.totalSqmu?.toString(),
      soldSqmu: sale.soldSqmu?.toString(),
      pricePerSqmu: Number.isFinite(priceDisplay) ? priceDisplay : 0,
      feeBps: sale.feeBps,
      period: sale.periodLabel,
      mode: 'invest',
      onSubmit: ({ amount }) => {
        if (!isActive) {
          setStatus('Investments are disabled for inactive bookings.');
          notify({
            message: 'This booking is not active. Investments are disabled.',
            variant: 'warning',
            role: 'investor',
            timeout: 5000,
          });
          return;
        }
        return investInSale(entry, amount, card);
      },
    });

    card.classList.add('tokenisation-invest-card');
    card.dataset.listingAddress = entry.listingAddress;

    const sqmuInput = card.querySelector('input[name="amount"]');
    const totalDisplay = card.querySelector('[data-role="total-usdc"]');
    const price = sale.pricePerSqmu;
    if (sqmuInput && totalDisplay && typeof price === 'bigint') {
      const updateTotal = () => {
        const raw = sqmuInput.value != null ? sqmuInput.value.trim() : '';
        if (!raw) {
          totalDisplay.textContent = '0 USDC';
          return;
        }
        try {
          const amount = BigInt(raw);
          const total = amount * price;
          totalDisplay.textContent = `${formatUsdc(total)} USDC`;
        } catch {
          totalDisplay.textContent = '0 USDC';
        }
      };
      sqmuInput.addEventListener('input', updateTotal, { once: false });
      updateTotal();
    }

    const propertyTitle = (entry.propertyTitle || '').trim() || shortAddress(entry.listingAddress);
    const header = document.createElement('div');
    header.className = 'data-card-header';
    const title = document.createElement('div');
    title.className = 'listing-title';
    title.textContent = propertyTitle;
    header.appendChild(title);
    header.appendChild(createBookingBadge(entry.bookingId));
    if (!isActive) {
      const statusBadge = document.createElement('span');
      statusBadge.className = 'booking-status-badge';
      if (statusClass) {
        statusBadge.classList.add(`booking-status-${statusClass}`);
      }
      statusBadge.textContent = statusLabel;
      header.appendChild(statusBadge);
    }
    card.insertBefore(header, card.firstChild);

    const descriptionText = (() => {
      const trimmed = (entry.propertyDescription || '').trim();
      if (trimmed && trimmed !== propertyTitle) {
        return trimmed;
      }
      const fallback = shortAddress(entry.listingAddress);
      if (fallback && fallback !== propertyTitle) {
        return fallback;
      }
      return '';
    })();
    if (descriptionText) {
      const description = document.createElement('div');
      description.className = 'listing-summary';
      description.textContent = descriptionText;
      card.insertBefore(description, header.nextSibling);
    }

    const remaining = sale.remainingSqmu ?? 0n;
    const supplyNote = document.createElement('div');
    supplyNote.className = 'token-progress';
    const soldPct = percentOf(sale.soldSqmu, sale.totalSqmu);
    if (soldPct != null) {
      supplyNote.textContent = `Sold ${sale.soldSqmu.toString()} of ${sale.totalSqmu.toString()} SQMU-R (${soldPct.toFixed(2)}%)`;
    } else {
      supplyNote.textContent = 'Not tokenised yet.';
    }
    card.appendChild(supplyNote);

    const submitBtn = card.querySelector('button[type="submit"]');
    const amountInput = card.querySelector('input[name="amount"]');
    if (!isActive) {
      if (submitBtn) {
        submitBtn.textContent = statusLabel;
        submitBtn.disabled = true;
        submitBtn.classList.add('secondary');
      }
      if (amountInput) {
        amountInput.disabled = true;
        amountInput.value = '';
      }
      const inactiveNotice = document.createElement('div');
      inactiveNotice.className = 'muted';
      inactiveNotice.textContent = `${statusLabel} — investments are disabled.`;
      card.appendChild(inactiveNotice);
    } else if (remaining <= 0n) {
      if (submitBtn) {
        submitBtn.textContent = 'Sold out';
        submitBtn.disabled = true;
        submitBtn.classList.add('secondary');
      }
      if (amountInput) {
        amountInput.disabled = true;
      }
    } else if (amountInput) {
      amountInput.max = sale.remainingSqmu.toString();
      amountInput.placeholder = `Max ${sale.remainingSqmu.toString()} SQMU`;
    }

    const listingLabel = document.createElement('div');
    listingLabel.className = 'muted mono';
    listingLabel.textContent = shortAddress(entry.listingAddress);
    card.appendChild(listingLabel);

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
    header.appendChild(createBookingBadge(entry.bookingId));
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
  const tokenised = results.filter((entry) => {
    if (!entry.tokenised) return false;
    if (normaliseStatusValue(entry.status) !== BOOKING_STATUS.ACTIVE) return false;
    const total = typeof entry.totalSqmu === 'bigint' ? entry.totalSqmu : BigInt(entry.totalSqmu || 0);
    const sold = typeof entry.soldSqmu === 'bigint' ? entry.soldSqmu : BigInt(entry.soldSqmu || 0);
    return total <= 0n || sold < total;
  });
  const rentClaims = holdings.filter((entry) => entry.claimable > 0n);

  renderHoldings(holdings);
  renderTokenisation(tokenised);
  renderRent(rentClaims);
}

async function loadInvestorData(account, options = {}) {
  const { silent = false } = options;
  if (!silent) {
    setStatus('Loading investor data…');
  }
  investorDataLoading = true;
  try {
    const cleaned = await fetchPlatformListings();
    syncInvestorListingEventWatchers(cleaned);
    if (!cleaned.length) {
      renderDashboards([]);
      if (!silent) {
        setStatus('No listings available yet.');
        notify({ message: 'No listings available yet.', variant: 'info', role: 'investor', timeout: 5000 });
      }
      return true;
    }
    const allEntries = [];
    for (const listing of cleaned) {
      const bookings = await loadListingBookings(listing, account);
      allEntries.push(...bookings);
    }
    state.holdings = allEntries;
    renderDashboards(allEntries);
    if (!silent) {
      setStatus(`Loaded ${allEntries.length} booking${allEntries.length === 1 ? '' : 's'}.`);
      notify({ message: 'Investor data refreshed.', variant: 'success', role: 'investor', timeout: 5000 });
    }
    return true;
  } catch (err) {
    console.error('Failed to load investor data', err);
    setStatus('Unable to load investor data.');
    const message = extractErrorMessage(err, 'Unable to load investor data.');
    notify({ message, variant: 'error', role: 'investor', timeout: 6000 });
    return false;
  } finally {
    investorDataLoading = false;
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

async function investInSale(entry, amountValue, form) {
  traceInvestmentStep('start', { amountValue });
  try {
    traceInvestmentStep('normalize-entry:start', { entry });
    const sale = createSelectionFromEntry(entry);
    if (!sale) {
      traceInvestmentStep('normalize-entry:missing', { entry });
      setStatus('Selected sale is no longer available.');
      notify({ message: 'Selected sale is no longer available.', variant: 'warning', role: 'investor', timeout: 5000 });
      return;
    }
    traceInvestmentStep('normalize-entry:success', {
      bookingId: sale.bookingId,
      listingAddress: sale.listingAddress,
      remainingSqmu: sale.remainingSqmu?.toString?.() ?? String(sale.remainingSqmu ?? '')
    });

    traceInvestmentStep('parse-amount:start', { amountValue });
    const raw = typeof amountValue === 'string' ? amountValue.trim() : String(amountValue ?? '').trim();
    if (!raw) {
      traceInvestmentStep('parse-amount:missing');
      setStatus('Enter the SQMU amount you wish to purchase.');
      notify({ message: 'Enter the SQMU amount you wish to purchase.', variant: 'warning', role: 'investor', timeout: 5000 });
      return;
    }
    if (!/^\d+$/.test(raw)) {
      traceInvestmentStep('parse-amount:invalid', { raw });
      setStatus('Enter a whole number of SQMU.');
      notify({ message: 'Enter a whole number of SQMU.', variant: 'warning', role: 'investor', timeout: 5000 });
      return;
    }

    const amount = BigInt(raw);
    if (amount <= 0n) {
      traceInvestmentStep('parse-amount:too-small', { amount: amount.toString() });
      setStatus('Enter at least 1 SQMU.');
      notify({ message: 'Enter at least 1 SQMU.', variant: 'warning', role: 'investor', timeout: 5000 });
      return;
    }
    if (sale.remainingSqmu <= 0n || amount > sale.remainingSqmu) {
      traceInvestmentStep('parse-amount:oversubscribed', {
        amount: amount.toString(),
        remainingSqmu: sale.remainingSqmu?.toString?.() ?? String(sale.remainingSqmu ?? '')
      });
      setStatus('This sale is fully subscribed.');
      notify({ message: 'This sale is fully subscribed.', variant: 'warning', role: 'investor', timeout: 5000 });
      return;
    }
    traceInvestmentStep('parse-amount:success', { amount: amount.toString() });

    if (!state.account) {
      traceInvestmentStep('provider:missing-account');
      setStatus('Connect your wallet before investing.');
      notify({ message: 'Connect your wallet before investing.', variant: 'warning', role: 'investor', timeout: 5000 });
      return;
    }

    traceInvestmentStep('provider:start');
    const p = provider || (provider = await sdk.wallet.getEthereumProvider());
    const [from] = (await p.request({ method: 'eth_accounts' })) || [];
    if (!from) throw new Error('No wallet account connected.');
    traceInvestmentStep('provider:success', { account: shortAddress(from) });
    traceInvestmentStep('arbitrum:check:start');
    await ensureArbitrum(p);
    traceInvestmentStep('arbitrum:check:success');

    const bookingId = sale.bookingIdRaw ?? BigInt(sale.bookingId || 0);
    traceInvestmentStep('cost:compute:start', {
      pricePerSqmu: sale.pricePerSqmu?.toString?.() ?? String(sale.pricePerSqmu ?? ''),
      amount: amount.toString()
    });
    const totalCost = sale.pricePerSqmu * amount;
    if (totalCost <= 0n) {
      traceInvestmentStep('cost:compute:invalid', { totalCost: totalCost.toString() });
      setStatus('Investment amount must be greater than 0 USDC.');
      notify({ message: 'Investment amount must be greater than 0 USDC.', variant: 'warning', role: 'investor', timeout: 5000 });
      return;
    }
    const formattedCost = formatUsdc(totalCost);
    traceInvestmentStep('cost:compute:success', { totalCost: totalCost.toString(), formattedCost });

    traceInvestmentStep('assemble:invest-call', {
      bookingId: bookingId?.toString?.() ?? String(bookingId ?? ''),
      amount: amount.toString(),
    });
    const investData = encodeFunctionData({
      abi: LISTING_ABI,
      functionName: 'invest',
      args: [bookingId, amount, ZERO_ADDRESS],
    });
    const investCall = { to: sale.listingAddress, data: investData };

    let allowance = 0n;
    try {
      traceInvestmentStep('allowance:read:start', { owner: shortAddress(from), spender: shortAddress(sale.listingAddress) });
      const allowanceRaw = await pub.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [from, sale.listingAddress],
      });
      allowance = toBigInt(allowanceRaw, 0n);
    } catch (err) {
      traceInvestmentStep('error', { stage: 'allowance:read', error: err });
      console.warn('Failed to read USDC allowance before investing', err);
      allowance = 0n;
    }

    let needsApproval = allowance < totalCost;
    traceInvestmentStep('allowance:read:complete', {
      allowance: allowance.toString(),
      needsApproval,
    });
    let approveData;
    const calls = [];
    if (needsApproval) {
      approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [sale.listingAddress, totalCost],
      });
      calls.push({ to: USDC_ADDRESS, data: approveData });
    }
    const investCallIndex = calls.length;
    calls.push(investCall);
    const approvalCallIndex = needsApproval ? 0 : null;
    traceInvestmentStep('assemble:calls:complete', {
      calls: calls.length,
      includesApproval: needsApproval,
      approvalCallIndex: approvalCallIndex ?? undefined,
      investCallIndex,
    });

    const submitBtn = form?.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    setStatus(
      needsApproval
        ? `Submitting USDC approval and investment (${formattedCost} USDC)…`
        : `Submitting investment (${formattedCost} USDC)…`
    );

    let walletSendUnsupported = false;
    let walletSendUnsupportedReason = null;
    let batchedSuccess = false;
    let partialExecution = null;
    try {
      traceInvestmentStep('wallet-send:start', {
        callCount: calls.length,
        includesApproval: needsApproval,
      });
      const { unsupported, reason: sendCallsReason, partial } = await requestWalletSendCalls(p, {
        calls,
        from,
        chainId: ARBITRUM_HEX,
      });
      batchedSuccess = !unsupported;
      walletSendUnsupported = unsupported;
      walletSendUnsupportedReason = sendCallsReason || null;
      if (Array.isArray(partial) && partial.length > 0) {
        partialExecution = partial;
        traceInvestmentStep('wallet-send:partial', {
          executedIndexes: extractSuccessfulIndexes(partial),
          raw: partial,
        });
      }
      traceInvestmentStep('wallet-send:complete', {
        unsupported,
        batchedSuccess,
        reason: sendCallsReason || undefined,
      });
    } catch (err) {
      traceInvestmentStep('error', { stage: 'wallet-send', error: err });
      if (err && typeof err === 'object' && err.unsupported) {
        walletSendUnsupported = true;
        walletSendUnsupportedReason = err.reason || err.unsupportedReason || null;
        batchedSuccess = false;
        if (Array.isArray(err.partial) && err.partial.length > 0) {
          partialExecution = err.partial;
          traceInvestmentStep('wallet-send:error-partial', {
            executedIndexes: extractSuccessfulIndexes(err.partial),
            raw: err.partial,
          });
        }
      } else if (isUserRejectedRequestError(err)) {
        setStatus('Investment cancelled by user.');
        notify({ message: 'Investment cancelled by user.', variant: 'warning', role: 'investor', timeout: 5000 });
        return;
      } else {
        throw err;
      }
    }

    if (!batchedSuccess && walletSendUnsupported) {
      const executedIndexes = new Set();
      for (const index of extractSuccessfulIndexes(partialExecution)) {
        executedIndexes.add(index);
      }
      const previousNeedsApproval = needsApproval;
      try {
        traceInvestmentStep('allowance:recheck:start', {
          previousNeedsApproval,
          executedIndexes: Array.from(executedIndexes),
        });
        const refreshedAllowanceRaw = await pub.readContract({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [from, sale.listingAddress],
        });
        const refreshedAllowance = toBigInt(refreshedAllowanceRaw, allowance);
        allowance = refreshedAllowance;
        const refreshedNeedsApproval = refreshedAllowance < totalCost;
        traceInvestmentStep('allowance:recheck:complete', {
          refreshedAllowance: refreshedAllowance.toString(),
          refreshedNeedsApproval,
        });
        if (previousNeedsApproval && !refreshedNeedsApproval) {
          traceInvestmentStep('allowance:recheck:skip-approval', {
            reason: 'allowance-updated',
            previousNeedsApproval,
            refreshedNeedsApproval,
          });
        }
        needsApproval = refreshedNeedsApproval;
      } catch (err) {
        traceInvestmentStep('error', { stage: 'allowance:recheck', error: err });
      }
      try {
        traceInvestmentStep('fallback:sequential:start', {
          needsApproval,
          formattedCost,
          reason: walletSendUnsupportedReason || undefined,
          executedIndexes: Array.from(executedIndexes),
        });
        const fallbackStatus = executedIndexes.size > 0
          ? 'Wallet only completed part of the batch. Finalising remaining transactions…'
          : needsApproval
            ? 'Wallet does not support batched approval + invest. Retrying sequentially…'
            : 'Wallet does not support batched invest calls. Retrying sequentially…';
        setStatus(fallbackStatus);
        notify({ message: fallbackStatus, variant: 'info', role: 'investor', timeout: 5000 });
        const replayed = [];
        const approvalIndex = approvalCallIndex;
        const investIndex = investCallIndex;
        if (needsApproval && approveData && approvalIndex !== null && !executedIndexes.has(approvalIndex)) {
          traceInvestmentStep('fallback:sequential:approval', { action: 'send' });
          setStatus(`Approve USDC (${formattedCost} USDC).`);
          await p.request({ method: 'eth_sendTransaction', params: [{ from, to: USDC_ADDRESS, data: approveData }] });
          replayed.push('approval');
        } else if (needsApproval && approvalIndex !== null && executedIndexes.has(approvalIndex)) {
          traceInvestmentStep('fallback:sequential:approval', { action: 'skip', reason: 'already-executed' });
        }
        if (!executedIndexes.has(investIndex)) {
          traceInvestmentStep('fallback:sequential:invest', { action: 'send' });
          setStatus(`Confirm investment (${formattedCost} USDC).`);
          await p.request({ method: 'eth_sendTransaction', params: [{ from, to: sale.listingAddress, data: investData }] });
          replayed.push('invest');
        } else {
          traceInvestmentStep('fallback:sequential:invest', { action: 'skip', reason: 'already-executed' });
        }
        batchedSuccess = true;
        traceInvestmentStep('fallback:sequential:success', {
          batchedSuccess,
          replayed,
          skippedIndexes: Array.from(executedIndexes),
        });
      } catch (err) {
        traceInvestmentStep('error', { stage: 'fallback:sequential', error: err });
        if (isUserRejectedRequestError(err)) {
          setStatus('Investment cancelled by user.');
          notify({ message: 'Investment cancelled by user.', variant: 'warning', role: 'investor', timeout: 5000 });
          return;
        }
        throw err;
      }
    }

    traceInvestmentStep('post-submit:notify', {
      formattedCost,
      batchedSuccess,
      walletSendUnsupported,
      walletSendUnsupportedReason: walletSendUnsupportedReason || undefined,
    });
    setStatus(`Investment submitted (${formattedCost} USDC).`);
    notify({
      message: `Investment submitted (${formattedCost} USDC).`,
      variant: 'success',
      role: 'investor',
      timeout: 6000,
    });

    if (form) {
      const input = form.querySelector('input[name="amount"]');
      if (input) input.value = '';
    }
    traceInvestmentStep('post-submit:refresh:start', { account: shortAddress(state.account) });
    await loadInvestorData(state.account);
    traceInvestmentStep('post-submit:refresh:complete');
  } catch (err) {
    traceInvestmentStep('error', { stage: 'investInSale', error: err });
    console.error('Investment failed', err);
    if (isUserRejectedRequestError(err)) {
      setStatus('Investment cancelled by user.');
      notify({ message: 'Investment cancelled by user.', variant: 'warning', role: 'investor', timeout: 5000 });
      return;
    }
    const message = extractErrorMessage(err, 'Investment failed.');
    setStatus(message);
    notify({ message, variant: 'error', role: 'investor', timeout: 6000 });
  } finally {
    const submitBtn = form?.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = false;
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
    const message = extractErrorMessage(err, 'Claim failed.');
    setStatus(message);
    notify({ message, variant: 'error', role: 'investor', timeout: 6000 });
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
    updateConnectedAccount(addr);
    notify({ message: 'Wallet connected.', variant: 'success', role: 'investor', timeout: 5000 });
    await loadInvestorData(addr);
  } catch (err) {
    console.error('Wallet connection failed', err);
    updateConnectedAccount(null);
    const message = extractErrorMessage(err, 'Wallet connection failed.');
    setStatus(message);
    notify({ message, variant: 'error', role: 'investor', timeout: 6000 });
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
