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
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const USDC_SCALAR = 1_000_000n;
const IPFS_PREFIX = 'ipfs://';
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const listingDescriptorCache = new Map();
const PERIOD_LABELS = {
  0: 'Unspecified',
  1: 'Daily',
  2: 'Weekly',
  3: 'Monthly',
};

const els = {
  connect: document.getElementById('connect'),
  walletAddress: document.getElementById('walletAddress'),
  status: document.getElementById('status'),
  holdingsList: document.getElementById('holdingsList'),
  tokenisationDashboard: document.getElementById('tokenisationDashboard'),
  rentDashboard: document.getElementById('rentDashboard'),
  investCard: document.getElementById('investCard'),
  investDetails: document.getElementById('investDetails'),
  investProperty: document.getElementById('investProperty'),
  investListingAddress: document.getElementById('investListingAddress'),
  investBooking: document.getElementById('investBooking'),
  investDescription: document.getElementById('investDescription'),
  investPrice: document.getElementById('investPrice'),
  investRemaining: document.getElementById('investRemaining'),
  investFeeBps: document.getElementById('investFeeBps'),
  investPeriod: document.getElementById('investPeriod'),
  investForm: document.getElementById('investForm'),
  investSqmuInput: document.getElementById('investSqmuInput'),
  investInputHint: document.getElementById('investInputHint'),
  investTotal: document.getElementById('investTotal'),
  investFee: document.getElementById('investFee'),
  investNet: document.getElementById('investNet'),
  investSubmit: document.getElementById('investSubmit'),
  investCancel: document.getElementById('investCancel'),
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
const state = { account: null, holdings: [], selectedBooking: null };
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
  if (uri.startsWith(IPFS_PREFIX)) {
    const path = uri.slice(IPFS_PREFIX.length);
    return `${IPFS_GATEWAY}${path.replace(/^\//, '')}`;
  }
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
  if (!value) {
    clearInvestSelection({ silent: true });
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

function evaluateInvestmentInput() {
  const selection = state.selectedBooking;
  const input = els.investSqmuInput;
  const raw = input ? (input.value || '').trim() : '';
  const hasValue = raw.length > 0;
  let isNumeric = false;
  let amount = 0n;
  let message = '';

  if (hasValue && /^\d+$/.test(raw)) {
    amount = BigInt(raw);
    isNumeric = true;
  } else if (hasValue) {
    message = 'Enter a whole number of SQMU.';
  }

  if (!selection) {
    return { amount, valid: false, hasValue, isNumeric, message: message || 'Select a tokenised booking.' };
  }

  if (!isNumeric) {
    return { amount, valid: false, hasValue, isNumeric, message };
  }

  if (selection.remainingSqmu <= 0n) {
    return { amount, valid: false, hasValue, isNumeric, message: 'This booking is fully subscribed.' };
  }

  if (amount <= 0n) {
    return { amount, valid: false, hasValue, isNumeric, message: 'Enter at least 1 SQMU.' };
  }

  if (amount > selection.remainingSqmu) {
    return {
      amount,
      valid: false,
      hasValue,
      isNumeric,
      message: `Only ${selection.remainingSqmu.toString()} SQMU remaining.`,
    };
  }

  return { amount, valid: true, hasValue, isNumeric, message: '' };
}

function updateInvestmentTotals() {
  const selection = state.selectedBooking;
  const totalEl = els.investTotal;
  const feeEl = els.investFee;
  const netEl = els.investNet;
  const submitBtn = els.investSubmit;
  const hint = els.investInputHint;
  const sqmuInput = els.investSqmuInput;

  if (!selection) {
    if (totalEl) totalEl.textContent = '0 USDC';
    if (feeEl) feeEl.textContent = '0 USDC';
    if (netEl) netEl.textContent = '0 USDC';
    if (submitBtn) submitBtn.disabled = true;
    if (hint) hint.textContent = '';
    if (sqmuInput) {
      sqmuInput.disabled = true;
      sqmuInput.setCustomValidity('');
    }
    return;
  }

  if (sqmuInput) {
    sqmuInput.disabled = selection.remainingSqmu <= 0n;
  }

  const evaluation = evaluateInvestmentInput();
  const { amount, valid, hasValue, isNumeric, message } = evaluation;
  const pricePerSqmu = selection.pricePerSqmu;
  const total = isNumeric ? pricePerSqmu * amount : 0n;
  const fee = total > 0n ? (total * BigInt(selection.feeBps || 0)) / 10000n : 0n;
  const net = total - fee;

  if (totalEl) totalEl.textContent = `${formatUsdc(total)} USDC`;
  if (feeEl) feeEl.textContent = `${formatUsdc(fee)} USDC`;
  if (netEl) netEl.textContent = `${formatUsdc(net)} USDC`;

  if (submitBtn) {
    submitBtn.disabled = !valid;
  }

  if (sqmuInput) {
    if (selection.remainingSqmu <= 0n) {
      sqmuInput.setCustomValidity('This booking is fully subscribed.');
    } else if (!hasValue || valid) {
      sqmuInput.setCustomValidity('');
    } else if (message) {
      sqmuInput.setCustomValidity(message);
    } else {
      sqmuInput.setCustomValidity('Enter a valid SQMU amount.');
    }
  }

  if (hint) {
    if (message) {
      hint.textContent = message;
    } else if (!hasValue) {
      hint.textContent = 'Enter the number of SQMU tokens to purchase.';
    } else {
      hint.textContent = '';
    }
  }
}

function updateInvestSelectionUI(options = {}) {
  const { preserveInput = false } = options;
  const selection = state.selectedBooking;
  const card = els.investCard;
  const details = els.investDetails;
  const sqmuInput = els.investSqmuInput;
  const savedValue = preserveInput && sqmuInput ? sqmuInput.value : '';

  if (!selection) {
    if (card) card.hidden = true;
    if (details) details.hidden = true;
    if (els.investBooking) els.investBooking.innerHTML = '';
    if (els.investProperty) els.investProperty.textContent = '';
    if (els.investListingAddress) els.investListingAddress.textContent = '';
    if (els.investDescription) {
      els.investDescription.textContent = '';
      els.investDescription.hidden = true;
    }
    if (els.investPrice) els.investPrice.textContent = '0 USDC';
    if (els.investRemaining) els.investRemaining.textContent = '0 SQMU-R';
    if (els.investFeeBps) els.investFeeBps.textContent = '0 bps';
    if (els.investPeriod) els.investPeriod.textContent = '—';
    if (sqmuInput) {
      if (!preserveInput) {
        sqmuInput.value = '';
      } else {
        sqmuInput.value = savedValue;
      }
      sqmuInput.disabled = true;
    }
    updateInvestmentTotals();
    return;
  }

  if (card) card.hidden = false;
  if (details) details.hidden = false;

  const propertyTitle = (selection.propertyTitle || '').trim() || shortAddress(selection.listingAddress);
  if (els.investProperty) {
    els.investProperty.textContent = propertyTitle;
  }
  if (els.investListingAddress) {
    els.investListingAddress.textContent = shortAddress(selection.listingAddress);
  }
  if (els.investBooking) {
    els.investBooking.innerHTML = '';
    const badge = createBookingBadge(selection.bookingId);
    if (badge) {
      els.investBooking.appendChild(badge);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'badge';
      fallback.textContent = `Booking #${selection.bookingId}`;
      els.investBooking.appendChild(fallback);
    }
  }
  if (els.investDescription) {
    const desc = (selection.propertyDescription || '').trim();
    if (desc && desc !== propertyTitle) {
      els.investDescription.textContent = desc;
      els.investDescription.hidden = false;
    } else {
      els.investDescription.textContent = '';
      els.investDescription.hidden = true;
    }
  }
  if (els.investPrice) {
    els.investPrice.textContent = `${formatUsdc(selection.pricePerSqmu)} USDC`;
  }
  if (els.investRemaining) {
    els.investRemaining.textContent = `${selection.remainingSqmu.toString()} of ${selection.totalSqmu.toString()} SQMU-R remaining`;
  }
  if (els.investFeeBps) {
    const percent = (Number(selection.feeBps || 0) / 100).toFixed(2);
    els.investFeeBps.textContent = `${selection.feeBps} bps (${percent}%)`;
  }
  if (els.investPeriod) {
    els.investPeriod.textContent = selection.periodLabel || 'Unspecified';
  }

  if (sqmuInput) {
    if (preserveInput) {
      sqmuInput.value = savedValue;
    } else {
      sqmuInput.value = '';
    }
    sqmuInput.disabled = false;
  }

  updateInvestmentTotals();

  if (sqmuInput && !preserveInput) {
    try {
      sqmuInput.focus();
      sqmuInput.select();
    } catch {}
  }
}

function selectBooking(entry) {
  const selection = createSelectionFromEntry(entry);
  if (!selection) {
    return;
  }
  if (selection.remainingSqmu <= 0n) {
    state.selectedBooking = null;
    updateInvestSelectionUI();
    setStatus('This booking is fully subscribed.');
    return;
  }
  const currentKey = state.selectedBooking?.key;
  const preserveInput = currentKey === selection.key;
  state.selectedBooking = selection;
  updateInvestSelectionUI({ preserveInput });
  renderDashboards(state.holdings);
  if (!preserveInput) {
    setStatus(`Investment form ready for booking #${selection.bookingId}.`);
  }
}

function clearInvestSelection(options = {}) {
  const { silent = false } = options;
  if (!state.selectedBooking) {
    updateInvestSelectionUI();
    return;
  }
  state.selectedBooking = null;
  updateInvestSelectionUI();
  renderDashboards(state.holdings);
  if (!silent) {
    setStatus('Investment form closed.');
  }
}

function syncSelectedBooking(entries) {
  if (!state.selectedBooking) {
    updateInvestSelectionUI();
    return;
  }
  const currentKey = state.selectedBooking.key;
  const match = entries.find((entry) => makeBookingKey(entry.listingAddress, entry.bookingId) === currentKey);
  if (!match) {
    state.selectedBooking = null;
    updateInvestSelectionUI();
    return;
  }
  const updated = createSelectionFromEntry(match);
  if (!updated || updated.remainingSqmu <= 0n) {
    state.selectedBooking = null;
    updateInvestSelectionUI();
    return;
  }
  state.selectedBooking = updated;
  updateInvestSelectionUI({ preserveInput: true });
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
    const card = document.createElement('div');
    card.className = 'data-card';

    const header = document.createElement('div');
    header.className = 'data-card-header';
    const title = document.createElement('strong');
    title.textContent = shortAddress(entry.listingAddress);
    header.appendChild(title);
    header.appendChild(createBookingBadge(entry.bookingId));
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
    empty.textContent = 'No in-progress tokenisation raises right now.';
    container.appendChild(empty);
    return;
  }
  const selectedKey = state.selectedBooking?.key ?? null;
  for (const entry of entries) {
    const selectionDetails = createSelectionFromEntry(entry);
    const bookingKey = selectionDetails?.key ?? makeBookingKey(entry.listingAddress, entry.bookingId);
    const hasRemaining = selectionDetails ? selectionDetails.remainingSqmu > 0n : true;
    const isSelected = Boolean(selectedKey && bookingKey && selectedKey === bookingKey);

    const card = document.createElement('div');
    card.className = hasRemaining ? 'data-card selectable' : 'data-card';
    if (bookingKey) {
      card.dataset.bookingKey = bookingKey;
    }
    if (isSelected) {
      card.classList.add('is-selected');
    }
    if (hasRemaining) {
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      card.setAttribute('aria-label', `Open invest form for booking #${entry.bookingId}`);
      card.addEventListener('click', (event) => {
        if (event.target?.closest('button')) {
          return;
        }
        selectBooking(entry);
      });
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectBooking(entry);
        }
      });
    } else {
      card.setAttribute('aria-disabled', 'true');
    }

    const header = document.createElement('div');
    header.className = 'data-card-header';
    const propertyTitle = (entry.propertyTitle || '').trim() || shortAddress(entry.listingAddress);
    const title = document.createElement('div');
    title.className = 'listing-title';
    title.textContent = propertyTitle;
    header.appendChild(title);
    header.appendChild(createBookingBadge(entry.bookingId));
    card.appendChild(header);

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
      card.appendChild(description);
    }

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

    const cadenceMetric = document.createElement('div');
    cadenceMetric.className = 'metric';
    cadenceMetric.innerHTML = '<label>Rent cadence</label>';
    const cadenceValue = document.createElement('span');
    const cadenceLabel = (entry.periodLabel || '').trim() || formatPeriodLabel(entry.period);
    cadenceValue.textContent = cadenceLabel;
    cadenceMetric.appendChild(cadenceValue);
    metrics.appendChild(cadenceMetric);

    card.appendChild(metrics);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const investBtn = document.createElement('button');
    investBtn.type = 'button';
    if (hasRemaining) {
      investBtn.textContent = isSelected ? 'Invest form open' : 'Invest';
      if (isSelected) {
        investBtn.classList.add('secondary');
      }
    } else {
      investBtn.textContent = 'No SQMU available';
      investBtn.disabled = true;
      investBtn.classList.add('secondary');
    }
    investBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!hasRemaining) {
        setStatus('No SQMU available for this booking right now.');
        return;
      }
      selectBooking(entry);
    });
    actions.appendChild(investBtn);
    card.appendChild(actions);

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
      clearInvestSelection({ silent: true });
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
    syncSelectedBooking(allEntries);
    renderDashboards(allEntries);
    if (!silent) {
      setStatus(`Loaded ${allEntries.length} booking${allEntries.length === 1 ? '' : 's'}.`);
      notify({ message: 'Investor data refreshed.', variant: 'success', role: 'investor', timeout: 5000 });
    }
    return true;
  } catch (err) {
    console.error('Failed to load investor data', err);
    setStatus('Unable to load investor data.');
    notify({ message: err?.message || 'Unable to load investor data.', variant: 'error', role: 'investor', timeout: 6000 });
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

async function submitInvestment(event) {
  event.preventDefault();
  const selection = state.selectedBooking;
  const evaluation = evaluateInvestmentInput();
  if (!selection) {
    updateInvestmentTotals();
    const message = evaluation.message || 'Select a tokenised booking to invest.';
    setStatus(message);
    notify({ message, variant: 'warning', role: 'investor', timeout: 5000 });
    return;
  }
  if (!evaluation.valid) {
    updateInvestmentTotals();
    const message = evaluation.message || 'Enter a valid SQMU amount before investing.';
    setStatus(message);
    notify({ message, variant: 'warning', role: 'investor', timeout: 5000 });
    return;
  }
  try {
    if (!state.account) {
      const message = 'Connect your wallet before investing.';
      setStatus(message);
      notify({ message, variant: 'warning', role: 'investor', timeout: 5000 });
      return;
    }
    const p = provider || (provider = await sdk.wallet.getEthereumProvider());
    const [from] = (await p.request({ method: 'eth_accounts' })) || [];
    if (!from) throw new Error('No wallet account connected.');
    await ensureArbitrum(p);

    const bookingId = selection.bookingIdRaw ?? BigInt(selection.bookingId || 0);
    const sqmuAmount = evaluation.amount;
    const data = encodeFunctionData({
      abi: LISTING_ABI,
      functionName: 'invest',
      args: [bookingId, sqmuAmount, ZERO_ADDRESS],
    });
    const call = { to: selection.listingAddress, data };
    const submitBtn = els.investSubmit;
    if (submitBtn) submitBtn.disabled = true;
    setStatus('Submitting investment transaction…');

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
        setStatus('Investment cancelled by user.');
        notify({ message: 'Investment cancelled by user.', variant: 'warning', role: 'investor', timeout: 5000 });
        return;
      }
      throw err;
    }

    if (walletSendUnsupported) {
      try {
        await p.request({ method: 'eth_sendTransaction', params: [{ from, to: selection.listingAddress, data }] });
      } catch (err) {
        if (isUserRejectedRequestError(err)) {
          setStatus('Investment cancelled by user.');
          notify({ message: 'Investment cancelled by user.', variant: 'warning', role: 'investor', timeout: 5000 });
          return;
        }
        throw err;
      }
    }

    setStatus('Investment transaction sent.');
    notify({ message: 'Investment transaction sent.', variant: 'success', role: 'investor', timeout: 6000 });

    if (els.investSqmuInput) {
      els.investSqmuInput.value = '';
    }
    updateInvestmentTotals();
    await loadInvestorData(state.account);
  } catch (err) {
    console.error('Investment failed', err);
    if (isUserRejectedRequestError(err)) {
      setStatus('Investment cancelled by user.');
      notify({ message: 'Investment cancelled by user.', variant: 'warning', role: 'investor', timeout: 5000 });
      return;
    }
    const message = err?.message || 'Investment failed.';
    setStatus(message);
    notify({ message, variant: 'error', role: 'investor', timeout: 6000 });
  } finally {
    if (els.investSubmit) {
      els.investSubmit.disabled = false;
    }
    updateInvestmentTotals();
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

els.investSqmuInput?.addEventListener('input', updateInvestmentTotals);
els.investForm?.addEventListener('submit', submitInvestment);
els.investCancel?.addEventListener('click', () => clearInvestSelection());

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
