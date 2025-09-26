import { sdk } from 'https://esm.sh/@farcaster/miniapp-sdk';
import { createPublicClient, http, encodeFunctionData, parseUnits, getAddress, erc20Abi } from 'https://esm.sh/viem@2.9.32';
import { arbitrum } from 'https://esm.sh/viem/chains';
import { assertLatLon, geohashToLatLon, latLonToGeohash, isHex20or32, toBytes32FromCastHash } from './tools.js';
import {
  applyListingFilters,
  DEFAULT_LISTING_SORT_MODE,
  LISTING_LOCATION_FILTER_PRECISION,
  parseLatLonStrict as parseLatLon,
} from './listing-filters.js';
import { requestWalletSendCalls, isUserRejectedRequestError } from './wallet.js';
import { notify, mountNotificationCenter } from './notifications.js';
import { BookingCard, TokenisationCard } from './ui/cards.js';
import { createCollapsibleSection, mountCollapsibles } from './ui/accordion.js';
import { el, fmt } from './ui/dom.js';
import {
  PLATFORM_ADDRESS,
  PLATFORM_ABI,
  RPC_URL,
  REGISTRY_ADDRESS,
  REGISTRY_ABI,
  LISTING_ABI,
  APP_VERSION,
  USDC_ADDRESS,
} from './config.js';
import createBackController from './back-navigation.js';

// -------------------- Config --------------------
const ARBITRUM_HEX = '0xa4b1';
const USDC_DECIMALS = 6;
const USDC_SCALAR = 1_000_000n;
const GEOHASH_PRECISION = 7;
const MANUAL_COORDS_HINT = 'Right-click → “What’s here?” in Google Maps to copy coordinates.';
const LOCATION_FILTER_PRECISION = LISTING_LOCATION_FILTER_PRECISION;
const DEFAULT_SORT_MODE = DEFAULT_LISTING_SORT_MODE;
const BOOKING_STATUS_LABELS = ['None', 'Active', 'Completed', 'Cancelled', 'Defaulted'];
const BOOKING_STATUS_CLASS_MAP = {
  1: 'active',
  2: 'completed',
  3: 'cancelled',
  4: 'defaulted',
};
const BOOKING_PERIOD_LABELS = ['Unspecified', 'Daily', 'Weekly', 'Monthly'];
const PERIOD_OPTIONS = {
  day: { label: 'Daily', value: 1n },
  week: { label: 'Weekly', value: 2n },
  month: { label: 'Monthly', value: 3n },
};
const UINT64_MAX = (1n << 64n) - 1n;
const utf8Encoder = new TextEncoder();
let platformAbi = Array.isArray(PLATFORM_ABI) && PLATFORM_ABI.length ? PLATFORM_ABI : null;
let listingPriceCache;
let listingPriceLoading;

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

function normaliseAddress(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

function addressesEqual(a, b) {
  return normaliseAddress(a) === normaliseAddress(b);
}

function isUnknownBookingError(err) {
  if (!err) return false;

  const reason = typeof err?.reason === 'string' ? err.reason.toLowerCase() : '';
  if (reason === 'unknown booking') {
    return true;
  }

  const errorArgs = Array.isArray(err?.errorArgs) ? err.errorArgs : [];
  if (errorArgs.some((value) => typeof value === 'string' && value.toLowerCase() === 'unknown booking')) {
    return true;
  }

  const message = typeof err?.message === 'string' ? err.message.toLowerCase() : '';
  if (message.includes('unknown booking')) {
    return true;
  }

  const dataReason = typeof err?.data?.message === 'string' ? err.data.message.toLowerCase() : '';
  if (dataReason.includes('unknown booking')) {
    return true;
  }

  return false;
}

// -------------------- UI handles --------------------
const els = {
  contextBar: document.getElementById('contextBar'),
  feeInfo: document.getElementById('feeInfo'),
  connect: document.getElementById('connect'),
  create: document.getElementById('create'),
  status: document.getElementById('status'),
  lat: document.getElementById('lat'),
  lon: document.getElementById('lon'),
  useLocation: document.getElementById('useLocation'),
  title: document.getElementById('title'),
  shortDesc: document.getElementById('shortDesc'),
  deposit: document.getElementById('deposit'),
  areaSqm: document.getElementById('areaSqm'),
  rateDaily: document.getElementById('rateDaily'),
  minNotice: document.getElementById('minNotice'),
  maxWindow: document.getElementById('maxWindow'),
  metadataUrl: document.getElementById('metadataUrl'),
  landlordListings: document.getElementById('landlordListings'),
  listingControls: document.getElementById('listingControls'),
  listingSort: document.getElementById('listingSort'),
  listingLocationFilter: document.getElementById('listingLocationFilter'),
  listingLocationClear: document.getElementById('listingLocationClear'),
};

if (els.connect && !els.connect.dataset.defaultLabel) {
  const initialLabel = (els.connect.textContent || '').trim();
  if (initialLabel) {
    els.connect.dataset.defaultLabel = initialLabel;
  }
}
const info = (t) => (els.status.textContent = t);

mountNotificationCenter(document.getElementById('notificationTray'), { role: 'landlord' });
mountCollapsibles();

const listingUiControllers = new Map();
let quickAuthReady = false;

function getListingControllerKey(listing) {
  if (!listing) return '';
  if (typeof listing === 'string') {
    return normaliseAddress(listing);
  }
  const addr = normaliseAddress(listing.address);
  if (addr) {
    return addr;
  }
  if (listing.listingIdText) {
    return `id:${listing.listingIdText}`;
  }
  if (listing.listingId) {
    try {
      const id = typeof listing.listingId === 'bigint' ? listing.listingId : BigInt(listing.listingId || 0);
      if (id > 0n) {
        return `id:${id.toString()}`;
      }
    } catch {}
  }
  if (Number.isFinite(listing.order)) {
    return `order:${listing.order}`;
  }
  return '';
}

function getListingController(listing) {
  const key = getListingControllerKey(listing);
  if (!key) return null;
  return listingUiControllers.get(key) || null;
}

function forEachListingController(handler) {
  for (const controller of listingUiControllers.values()) {
    try {
      handler(controller);
    } catch (err) {
      console.warn('Listing controller handler failed', err);
    }
  }
}

function handleDeactivateListing(listing) {
  notify({
    message: 'Listing deactivation is not available yet. Contact the platform team to disable listings.',
    variant: 'warning',
    role: 'landlord',
    timeout: 5000,
  });
  console.info('Deactivate listing requested', listing?.address || listing);
}

const backButton = document.querySelector('[data-back-button]');
const backController = createBackController({ sdk, button: backButton });
backController.update();

const checkpointLabels = {
  basics: 'Basics',
  location: 'Location & size',
  pricing: 'Pricing',
  policies: 'Policies',
};

const checkpointState = {
  basics: false,
  location: false,
  pricing: false,
  policies: false,
};

let lastAllComplete = false;
let walletConnected = false;

let landlordListingRecords = [];
let listingSortMode = DEFAULT_SORT_MODE;
let listingLocationFilterValue = '';
let currentLandlordAddress = null;
const landlordListingEventWatchers = new Map();
const landlordEventRefreshState = { timer: null, messages: new Set(), running: false };

const onboardingFields = [
  'title',
  'shortDesc',
  'lat',
  'lon',
  'areaSqm',
  'deposit',
  'rateDaily',
  'minNotice',
  'maxWindow',
];

for (const key of onboardingFields) {
  const element = els[key];
  if (element) {
    element.addEventListener('input', updateOnboardingProgress);
  }
}

updateOnboardingProgress();
initGeolocationButton();

if (els.listingSort) {
  els.listingSort.value = listingSortMode;
  els.listingSort.addEventListener('change', () => {
    listingSortMode = els.listingSort.value || DEFAULT_SORT_MODE;
    renderLandlordListingView();
  });
}

if (els.listingLocationFilter) {
  els.listingLocationFilter.addEventListener('input', () => {
    listingLocationFilterValue = els.listingLocationFilter.value || '';
    renderLandlordListingView();
  });
}

if (els.listingLocationClear) {
  els.listingLocationClear.disabled = true;
  els.listingLocationClear.addEventListener('click', () => {
    listingLocationFilterValue = '';
    if (els.listingLocationFilter) {
      els.listingLocationFilter.value = '';
      els.listingLocationFilter.focus();
    }
    renderLandlordListingView();
  });
}


function formatSqmuProgress(soldValue, totalValue) {
  const sold = toBigIntOrZero(soldValue);
  const total = toBigIntOrZero(totalValue);
  const soldText = `${fmt.sqmu(sold)} SQMU`;
  if (total <= 0n) {
    return soldText;
  }
  let percentBasis = 0n;
  try {
    percentBasis = (sold * 10000n) / total;
  } catch {
    percentBasis = 0n;
  }
  const whole = percentBasis / 100n;
  const fraction = percentBasis % 100n;
  const percentText = `${whole.toString()}.${fraction.toString().padStart(2, '0')}%`;
  return `${fmt.sqmu(sold)} / ${fmt.sqmu(total)} SQMU (${percentText})`;
}

function createBookingDetailElement(label, value, options = {}) {
  const { tooltip } = options || {};
  const wrapper = document.createElement('div');
  const labelEl = document.createElement('div');
  labelEl.className = 'booking-detail-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('div');
  valueEl.className = 'booking-detail-value';
  if (value instanceof Node) {
    valueEl.appendChild(value);
  } else {
    valueEl.textContent = value;
  }
  if (tooltip) {
    valueEl.title = tooltip;
  }
  wrapper.appendChild(labelEl);
  wrapper.appendChild(valueEl);
  return wrapper;
}

function deriveTokenisationState(booking, pending) {
  const tokenised = Boolean(booking?.tokenised);
  const pendingExists = Boolean(pending?.exists);
  if (tokenised) {
    const total = toBigIntOrZero(booking?.totalSqmu);
    const sold = toBigIntOrZero(booking?.soldSqmu);
    const completed = total > 0n && sold >= total;
    return {
      state: completed ? 'completed' : 'approved',
      label: completed ? 'Tokenisation completed' : 'Tokenisation approved',
      progress: total > 0n ? { sold, total } : null,
      proposer: booking?.proposer,
    };
  }
  if (pendingExists) {
    const total = toBigIntOrZero(pending?.totalSqmu);
    return {
      state: 'proposed',
      label: 'Tokenisation proposed',
      progress: total > 0n ? { sold: 0n, total } : null,
      proposer: pending?.proposer,
    };
  }
  return { state: 'none', label: 'Not tokenised', progress: null, proposer: booking?.proposer };
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeBytes32ToString(value, precision) {
  const hex = typeof value === 'string' ? value : '';
  if (!hex || hex === '0x' || /^0x0+$/i.test(hex)) {
    return '';
  }
  let out = '';
  for (let i = 2; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (!Number.isFinite(byte) || byte <= 0) break;
    out += String.fromCharCode(byte);
  }
  const limit = typeof precision === 'number' && Number.isFinite(precision) ? precision : undefined;
  if (limit && limit > 0 && out.length > limit) {
    return out.slice(0, limit);
  }
  return out;
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
      const atobFn =
        typeof globalThis !== 'undefined' && typeof globalThis.atob === 'function'
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

const listingMetadataCache = new Map();

async function fetchListingMetadataDetails(uri, fallbackTitle) {
  const fallbackText = typeof fallbackTitle === 'string' && fallbackTitle.trim() ? fallbackTitle.trim() : '';
  if (!uri || typeof uri !== 'string') {
    return { title: fallbackText, description: '' };
  }

  let cacheKey = '';
  let fetchUrl = '';
  if (uri.startsWith('data:')) {
    cacheKey = uri;
  } else {
    fetchUrl = normaliseMetadataUrl(uri);
    cacheKey = fetchUrl || uri;
  }

  if (cacheKey) {
    const cached = listingMetadataCache.get(cacheKey);
    if (cached) {
      const cachedTitle = typeof cached.title === 'string' ? cached.title : '';
      const cachedDesc = typeof cached.description === 'string' ? cached.description : '';
      return {
        title: cachedTitle || fallbackText,
        description: cachedDesc,
      };
    }
  }

  let raw;
  try {
    if (uri.startsWith('data:')) {
      raw = decodeDataUri(uri);
    } else {
      const target = fetchUrl;
      if (!target) {
        return { title: fallbackText, description: '' };
      }
      const response = await fetch(target, { method: 'GET' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      raw = await response.text();
    }
  } catch (err) {
    console.warn('Failed to retrieve listing metadata', uri, err);
    return { title: fallbackText, description: '' };
  }

  if (!raw) {
    return { title: fallbackText, description: '' };
  }

  const details = { title: '', description: '' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        details.title = parsed.name.trim();
      }
      if (typeof parsed.description === 'string' && parsed.description.trim()) {
        details.description = parsed.description.trim();
      }
    }
  } catch (err) {
    console.warn('Failed to parse listing metadata JSON', uri, err);
  }

  if (details.description && details.title && details.description === details.title) {
    details.description = '';
  }

  if (cacheKey) {
    listingMetadataCache.set(cacheKey, { ...details });
  }

  return {
    title: details.title || fallbackText,
    description: details.description,
  };
}

function toIsoString(seconds) {
  const value = typeof seconds === 'bigint' ? seconds : BigInt(seconds || 0);
  if (value <= 0n) return '';
  let asNumber;
  try {
    asNumber = Number(value);
  } catch {
    return '';
  }
  if (!Number.isFinite(asNumber)) return '';
  const date = new Date(asNumber * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function shortAddress(addr) {
  if (typeof addr !== 'string') return '';
  if (!addr.startsWith('0x') || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const setVersionBadge = () => {
  const badge = document.querySelector('[data-version]');
  if (badge) badge.textContent = `Build ${APP_VERSION}`;
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setVersionBadge);
} else {
  setVersionBadge();
}

// helpers
function utf8BytesLen(str) {
  return new TextEncoder().encode(str).length;
}
function parseDec6(s) {
  const v = String(s ?? '').trim();
  if (v === '') throw new Error('Missing numeric value.');
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error('Use up to 6 decimals.');
  return parseUnits(v, USDC_DECIMALS);
}
function parseOptionalDec6(s) {
  const v = String(s ?? '').trim();
  if (v === '') return 0n;
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error('Use up to 6 decimals.');
  return parseUnits(v, USDC_DECIMALS);
}
function parseAreaSqm(input) {
  const v = String(input ?? '').trim();
  if (v === '') throw new Error('Square metre area is required.');
  if (!/^\d+$/.test(v)) throw new Error('Area must be a whole number.');
  const value = BigInt(v);
  if (value === 0n) throw new Error('Area must be greater than zero.');
  if (value > 4_294_967_295n) throw new Error('Area exceeds uint32 limit.');
  return value;
}
function geohashToBytes32(geohash) {
  const value = String(geohash ?? '').trim();
  if (!value) throw new Error('Geohash is required.');
  const bytes = utf8Encoder.encode(value);
  if (bytes.length > 32) throw new Error('Geohash exceeds 32 bytes.');
  const out = new Uint8Array(32);
  out.set(bytes);
  return '0x' + Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}
function parseHoursToSeconds(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') return 0n;
  if (!/^\d+$/.test(raw)) throw new Error('Minimum notice must be a whole number of hours.');
  const hours = BigInt(raw);
  const seconds = hours * 3_600n;
  if (seconds > UINT64_MAX) throw new Error('Minimum notice exceeds uint64 range.');
  return seconds;
}
function parseDaysToSeconds(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') return 0n;
  if (!/^\d+$/.test(raw)) throw new Error('Booking window must be a whole number of days.');
  const days = BigInt(raw);
  const seconds = days * 86_400n;
  if (seconds > UINT64_MAX) throw new Error('Booking window exceeds uint64 range.');
  return seconds;
}
function encodeJsonToDataUri(obj) {
  const json = JSON.stringify(obj);
  const bytes = utf8Encoder.encode(json);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:application/json;base64,${btoa(binary)}`;
}
function buildMetadataUri(params) {
  const {
    metadataUrl,
    title,
    shortDesc,
    embedUrl,
    geohash,
    geolen,
    areaSqm,
    deposit,
    rateDaily,
    fid,
    castHash,
    minBookingNotice,
    maxBookingWindow,
    listingPrice,
  } = params;
  const trimmed = String(metadataUrl || '').trim();
  if (trimmed) {
    const lower = trimmed.toLowerCase();
    if (!/^https?:\/\//.test(lower) && !lower.startsWith('data:')) {
      throw new Error('Metadata URL must start with https:// or data:');
    }
    return trimmed;
  }
  const metadata = {
    name: title,
    description: shortDesc,
    version: APP_VERSION,
    geohash: { value: geohash, precision: geolen },
    areaSqm: areaSqm.toString(),
    deposit: deposit.toString(),
    rates: {
      daily: rateDaily.toString(),
    },
    bookingWindow: {
      minNoticeSeconds: minBookingNotice.toString(),
      maxWindowSeconds: maxBookingWindow.toString(),
    },
    cast: {
      fid: fid.toString(),
      hash: castHash,
    },
    embedUrl,
    listingFee: listingPrice ? listingPrice.toString() : '0',
    createdAt: new Date().toISOString(),
  };
  return encodeJsonToDataUri(metadata);
}
function normalizeCastHash(h) {
  if (typeof h !== 'string') return null;
  const hex = h.startsWith('0x') ? h : '0x' + h;
  if (!isHex20or32(hex)) return null;
  return toBytes32FromCastHash(hex);
}

function disableWhile(el, fn) {
  return (async () => {
    el.disabled = true;
    try {
      return await fn();
    } finally {
      el.disabled = false;
    }
  })();
}

function initGeolocationButton() {
  const button = els.useLocation;
  if (!button) return;
  if (!navigator?.geolocation) {
    button.disabled = true;
    button.title = 'Geolocation is not supported in this browser.';
    return;
  }

  button.disabled = false;
  button.title = 'Detect your current location.';
  button.onclick = () =>
    disableWhile(button, async () => {
      info('Detecting your current location…');
      notify({
        message: 'Detecting your current location…',
        variant: 'info',
        role: 'landlord',
        timeout: 4000,
      });
      try {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10_000,
            maximumAge: 60_000,
          });
        });
        const { latitude, longitude } = position?.coords || {};
        const latNum = Number(latitude);
        const lonNum = Number(longitude);
        assertLatLon(latNum, lonNum);
        els.lat.value = latNum.toFixed(6);
        els.lon.value = lonNum.toFixed(6);
        updateOnboardingProgress();
        info('Location detected from your browser.');
        notify({
          message: 'Detected your current location — confirm before publishing.',
          variant: 'success',
          role: 'landlord',
          timeout: 5000,
        });
      } catch (err) {
        console.error('Geolocation lookup failed', err);
        const fallback = `Enter coordinates manually (tip: ${MANUAL_COORDS_HINT})`;
        info(`Unable to detect location. ${fallback}`);
        notify({
          message: `Unable to detect location. ${fallback}`,
          variant: 'warning',
          role: 'landlord',
          timeout: 6000,
        });
      }
    });
}

function evaluateOnboardingSteps() {
  const results = {
    basics: false,
    location: false,
    pricing: false,
    policies: false,
  };

  try {
    const title = els.title.value.trim();
    const shortDesc = els.shortDesc.value.trim();
    results.basics = Boolean(title) && Boolean(shortDesc) && utf8BytesLen(title) <= 64 && utf8BytesLen(shortDesc) <= 140;
  } catch {
    results.basics = false;
  }

  try {
    parseLatLon(els.lat.value, els.lon.value);
    parseAreaSqm(els.areaSqm.value);
    results.location = true;
  } catch {
    results.location = false;
  }

  try {
    const deposit = parseDec6(els.deposit.value);
    const daily = parseOptionalDec6(els.rateDaily.value);
    results.pricing = deposit > 0n && daily > 0n;
  } catch {
    results.pricing = false;
  }

  try {
    parseHoursToSeconds(els.minNotice.value);
    parseDaysToSeconds(els.maxWindow.value);
    results.policies = true;
  } catch {
    results.policies = false;
  }

  return results;
}

function updateOnboardingProgress() {
  const results = evaluateOnboardingSteps();

  for (const step of Object.keys(results)) {
    const complete = results[step];
    if (complete && !checkpointState[step]) {
      notify({
        message: `Requirement complete: ${checkpointLabels[step]}`,
        variant: 'success',
        role: 'landlord',
        timeout: 5000,
      });
    }
    checkpointState[step] = complete;
  }

  const allComplete = Object.values(results).every(Boolean);
  if (allComplete && !lastAllComplete) {
    notify({
      message: 'All listing requirements met. You can deploy your listing.',
      variant: 'success',
      role: 'landlord',
      timeout: 6000,
    });
  }
  lastAllComplete = allComplete;

  if (els.create) {
    els.create.disabled = !(walletConnected && allComplete);
  }
}

async function loadPlatformAbi() {
  if (Array.isArray(platformAbi) && platformAbi.length > 0) {
    return platformAbi;
  }
  try {
    const response = await fetch('./js/abi/Platform.json');
    if (response.ok) {
      const json = await response.json();
      if (Array.isArray(json?.abi) && json.abi.length > 0) {
        platformAbi = json.abi;
        return platformAbi;
      }
    }
  } catch (err) {
    console.error('Failed to load Platform ABI', err);
  }
  if (!Array.isArray(platformAbi) || platformAbi.length === 0) {
    platformAbi = Array.isArray(PLATFORM_ABI) && PLATFORM_ABI.length ? PLATFORM_ABI : [];
  }
  return platformAbi;
}

async function getListingPrice() {
  if (typeof listingPriceCache === 'bigint') {
    return listingPriceCache;
  }
  if (listingPriceLoading) {
    return listingPriceLoading;
  }
  listingPriceLoading = (async () => {
    const abi = await loadPlatformAbi();
    if (!Array.isArray(abi) || abi.length === 0) {
      throw new Error('Platform ABI unavailable');
    }
    const price = await pub.readContract({
      address: PLATFORM_ADDRESS,
      abi,
      functionName: 'listingCreationFee',
    });
    if (typeof price !== 'bigint') {
      throw new Error('Unexpected listing price response');
    }
    listingPriceCache = price;
    return price;
  })();
  try {
    return await listingPriceLoading;
  } finally {
    listingPriceLoading = null;
  }
}

async function refreshListingPriceDisplay() {
  try {
    const price = await getListingPrice();
    els.feeInfo.textContent = `Listing price: ${fmt.usdc(price)} USDC`;
  } catch (err) {
    console.error('Failed to load listing price', err);
    els.feeInfo.textContent = 'Listing price: (unavailable)';
  }
}

async function fetchListingInfo(listingAddr, orderIndex = 0) {
  try {
    const abi = await loadPlatformAbi();
    if (!Array.isArray(abi) || abi.length === 0) {
      throw new Error('Platform ABI unavailable.');
    }

    const responses = await pub.multicall({
      contracts: [
        { address: listingAddr, abi: LISTING_ABI, functionName: 'baseDailyRate' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'depositAmount' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'metadataURI' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'minBookingNotice' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'maxBookingWindow' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'areaSqm' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'landlord' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'geohash' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'geohashPrecision' },
        { address: PLATFORM_ADDRESS, abi, functionName: 'listingIds', args: [listingAddr] },
      ],
      allowFailure: true,
    });

    const getBig = (idx, fallback = 0n) => {
      const entry = responses[idx];
      if (!entry || entry.status !== 'success') return fallback;
      const res = entry.result;
      try {
        return typeof res === 'bigint' ? res : BigInt(res || 0);
      } catch {
        return fallback;
      }
    };
    const getString = (idx, fallback = '') => {
      const entry = responses[idx];
      if (!entry || entry.status !== 'success') return fallback;
      return typeof entry.result === 'string' ? entry.result : fallback;
    };

    const geohashHex = getString(7, '0x');
    const geohashPrecision = Number(getBig(8));
    const listingId = getBig(9);

    let createdAt = 0n;
    if (listingId > 0n) {
      try {
        const createdRaw = await pub.readContract({
          address: PLATFORM_ADDRESS,
          abi,
          functionName: 'listingCreated',
          args: [listingId],
        });
        if (typeof createdRaw === 'bigint') {
          createdAt = createdRaw;
        } else if (typeof createdRaw === 'number') {
          createdAt = BigInt(createdRaw);
        } else if (typeof createdRaw === 'string' && createdRaw) {
          createdAt = BigInt(createdRaw);
        }
      } catch (err) {
        console.warn('Unable to read listingCreated for listing', listingAddr, listingId.toString(), err);
      }
    }

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
        console.warn('Failed to decode geohash for listing', listingAddr, geohash, err);
      }
    }

    const createdAtIso = toIsoString(createdAt);
    const metadataURI = getString(2, '');
    const metadataDetails = await fetchListingMetadataDetails(metadataURI, shortAddress(listingAddr));
    const title = metadataDetails?.title?.trim?.() || '';
    const shortDescription = metadataDetails?.description?.trim?.() || '';

    return {
      address: listingAddr,
      baseDailyRate: getBig(0),
      depositAmount: getBig(1),
      metadataURI,
      minBookingNotice: getBig(3),
      maxBookingWindow: getBig(4),
      areaSqm: getBig(5),
      landlord: getString(6, '0x0000000000000000000000000000000000000000'),
      geohash: geohash ? geohash.toLowerCase() : '',
      geohashPrecision: Number.isFinite(geohashPrecision) ? geohashPrecision : null,
      lat,
      lon,
      listingId,
      listingIdText: listingId > 0n ? listingId.toString() : '',
      createdAt,
      createdAtIso,
      createdAtLabel: createdAtIso || (createdAt > 0n ? `Unix ${createdAt.toString()}` : ''),
      order: Number.isFinite(orderIndex) ? orderIndex : 0,
      title,
      shortDescription,
    };
  } catch (err) {
    console.error('Failed to load listing info', listingAddr, err);
    return null;
  }
}

function buildLandlordBookingRecord(listing, bookingId, booking, pending) {
  if (!booking) return null;
  let bookingIdValue;
  try {
    bookingIdValue = typeof bookingId === 'bigint' ? bookingId : BigInt(bookingId || 0);
  } catch {
    bookingIdValue = 0n;
  }
  const bookingIdText = bookingIdValue > 0n ? bookingIdValue.toString() : '';
  const statusIndex = Number(booking.status || 0n);
  const statusLabel = BOOKING_STATUS_LABELS[statusIndex] || `Unknown (${statusIndex})`;
  const statusClass = BOOKING_STATUS_CLASS_MAP[statusIndex] || '';
  const start = toBigIntOrZero(booking.start);
  const end = toBigIntOrZero(booking.end);
  const duration = end > start ? end - start : 0n;
  const periodIndex = Number(booking.period || 0n);
  const periodLabel = BOOKING_PERIOD_LABELS[periodIndex] || `Custom (${periodIndex})`;
  const pendingExists = Boolean(pending?.exists);
  const pendingPeriodIndex = Number(pending?.period || 0);
  const pendingPeriodLabel = BOOKING_PERIOD_LABELS[pendingPeriodIndex] || `Custom (${pendingPeriodIndex})`;
  const normalizedPending = pendingExists
    ? {
        totalSqmu: toBigIntOrZero(pending.totalSqmu),
        pricePerSqmu: toBigIntOrZero(pending.pricePerSqmu),
        feeBps: toBigIntOrZero(pending.feeBps),
        proposer: pending.proposer,
        period: pendingPeriodIndex,
        periodLabel: pendingPeriodLabel,
      }
    : null;
  const tokenState = deriveTokenisationState(booking, pending);
  const tokenActionLabel =
    tokenState.state === 'proposed'
      ? 'Review tokenisation proposal'
      : tokenState.state === 'approved' || tokenState.state === 'completed'
        ? 'View investment progress'
        : 'Propose tokenisation';
  return {
    listingId: listing?.listingId,
    listingIdText: listing?.listingIdText || (listing?.listingId ? listing.listingId.toString() : ''),
    listingAddress: listing?.address,
    bookingId: bookingIdValue,
    bookingIdText,
    statusIndex,
    statusLabel,
    statusClass,
    start,
    end,
    startLabel: fmt.timestamp(start),
    endLabel: fmt.timestamp(end),
    durationLabel: fmt.duration(duration),
    grossRent: toBigIntOrZero(booking.grossRent),
    expectedNetRent: toBigIntOrZero(booking.expectedNetRent),
    rentPaid: toBigIntOrZero(booking.rentPaid),
    deposit: toBigIntOrZero(booking.deposit),
    tenant: booking.tenant,
    tenantShort: shortAddress(booking.tenant || ''),
    periodIndex,
    periodLabel,
    tokenised: Boolean(booking.tokenised),
    totalSqmu: toBigIntOrZero(booking.totalSqmu),
    soldSqmu: toBigIntOrZero(booking.soldSqmu),
    pricePerSqmu: toBigIntOrZero(booking.pricePerSqmu),
    feeBps: toBigIntOrZero(booking.feeBps),
    tokenState,
    pending: normalizedPending,
    pendingExists,
    tokenActionLabel,
    pendingPeriodLabel,
    tokenProposer: booking.proposer,
    tokenProposerShort: shortAddress(booking.proposer || ''),
    pendingProposer: normalizedPending?.proposer,
    pendingProposerShort: normalizedPending?.proposer ? shortAddress(normalizedPending.proposer) : '',
  };
}

function renderLandlordBookingTokenSection(record) {
  const section = document.createElement('div');
  section.className = 'booking-tokenisation-section';
  section.classList.add('card-footnote');

  const heading = document.createElement('div');
  heading.className = 'booking-tokenisation-title';
  heading.textContent = 'Tokenisation';
  section.appendChild(heading);

  const state = record?.tokenState?.state || 'none';
  if (state === 'proposed') {
    const alert = document.createElement('div');
    alert.className = 'booking-tokenisation-alert';
    alert.textContent = 'Waiting for platform approval';
    section.appendChild(alert);

    const details = document.createElement('div');
    details.className = 'booking-details';
    details.appendChild(createBookingDetailElement('Proposed SQMU', fmt.sqmu(record.pending?.totalSqmu)));
    details.appendChild(
      createBookingDetailElement('Proposed price', `${fmt.usdc(record.pending?.pricePerSqmu)} USDC`)
    );
    details.appendChild(createBookingDetailElement('Proposed fee', fmt.bps(record.pending?.feeBps)));
    details.appendChild(createBookingDetailElement('Proposed cadence', record.pendingPeriodLabel || 'Custom'));
    const proposerText = record.pendingProposerShort || (record.pendingProposer || '—');
    details.appendChild(
      createBookingDetailElement('Proposer', proposerText, { tooltip: record.pendingProposer || undefined })
    );
    section.appendChild(details);

    const helper = document.createElement('div');
    helper.className = 'booking-helper-text';
    helper.textContent = 'Tokenisation proposal submitted. Awaiting platform decision.';
    section.appendChild(helper);
    return section;
  }

  if (state === 'approved' || state === 'completed') {
    const details = document.createElement('div');
    details.className = 'booking-details';
    details.appendChild(createBookingDetailElement('Total SQMU', fmt.sqmu(record.totalSqmu)));
    details.appendChild(createBookingDetailElement('Sold SQMU', fmt.sqmu(record.soldSqmu)));
    if (record.tokenState?.progress) {
      details.appendChild(createBookingDetailElement('Progress', formatSqmuProgress(record.soldSqmu, record.totalSqmu)));
    }
    details.appendChild(createBookingDetailElement('Price per SQMU', `${fmt.usdc(record.pricePerSqmu)} USDC`));
    details.appendChild(createBookingDetailElement('Token fee', fmt.bps(record.feeBps)));
    details.appendChild(createBookingDetailElement('Token period', record.periodLabel));
    const proposerText = record.tokenProposerShort || (record.tokenProposer || '—');
    details.appendChild(
      createBookingDetailElement('Approved proposer', proposerText, { tooltip: record.tokenProposer || undefined })
    );
    section.appendChild(details);

    const helper = document.createElement('div');
    helper.className = 'booking-helper-text';
    helper.textContent =
      state === 'completed'
        ? 'All SQMU sold. Continue tracking rent distributions from this panel.'
        : 'Fundraising active. Monitor SQMU sales below.';
    section.appendChild(helper);
    return section;
  }

  const empty = document.createElement('div');
  empty.className = 'booking-tokenisation-empty';
  empty.textContent = 'Not tokenised';
  section.appendChild(empty);
  return section;
}

function renderLandlordBookingEntry(listing, record) {
  const card = BookingCard({
    bookingId: record.bookingIdText || record.bookingId?.toString?.() || '—',
    listingId: record.listingIdText || shortAddress(listing?.address || ''),
    dates: `Stay: ${record.startLabel} → ${record.endLabel} (${record.durationLabel})`,
    period: record.periodLabel,
    depositUSDC: record.deposit,
    rentUSDC: record.grossRent,
    status: record.statusLabel,
    statusClass: record.statusClass,
    actions: [
      {
        label: record.tokenActionLabel,
        onClick: () => {
          openTokenToolsForBooking(listing, record.bookingId).catch((err) => {
            console.error('Failed to open token tools via quick action', err);
          });
        },
      },
    ],
  });

  if (record.statusClass) {
    card.classList.add(`booking-status-${record.statusClass}`);
  }

  card.append(
    el('div', { class: 'card-footnote' }, `Rent paid ${fmt.usdc(record.rentPaid)} USDC / Net ${fmt.usdc(record.expectedNetRent)} USDC`),
  );
  card.append(
    el('div', { class: 'card-footnote' }, `Deposit ${fmt.usdc(record.deposit)} USDC`),
  );
  if (record.tenantShort) {
    card.append(
      el('div', { class: 'card-footnote', title: record.tenant || '' }, `Tenant ${record.tenantShort}`),
    );
  }

  card.append(renderLandlordBookingTokenSection(record));
  return card;
}
function renderLandlordBookings(listing, container, records, statusEl) {
  if (!container) return;
  container.innerHTML = '';
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) {
    if (statusEl) {
      statusEl.textContent = 'No bookings found for this listing yet.';
    }
    return;
  }
  for (const record of list) {
    container.appendChild(renderLandlordBookingEntry(listing, record));
  }
  if (statusEl) {
    statusEl.textContent = `Showing ${list.length} booking${list.length === 1 ? '' : 's'}.`;
  }
}

async function fetchListingBookings(listing) {
  const listingAddr = listing?.address;
  if (!listingAddr) {
    throw new Error('Listing address unavailable.');
  }
  let nextId;
  try {
    nextId = await pub.readContract({ address: listingAddr, abi: LISTING_ABI, functionName: 'nextBookingId' });
  } catch (err) {
    console.error('Failed to load booking count for listing', listingAddr, err);
    throw new Error('Unable to load bookings for this listing.');
  }
  let maxId;
  try {
    maxId = typeof nextId === 'bigint' ? nextId : BigInt(nextId || 0);
  } catch {
    maxId = 0n;
  }
  // nextBookingId is incremented before assignments inside the Listing contract, meaning the
  // returned value reflects the highest booking id that has been created (not the next empty id).
  if (maxId <= 0n) {
    return [];
  }
  const records = [];
  let failures = 0;
  for (let bookingId = 1n; bookingId <= maxId; bookingId++) {
    try {
      const { booking, pending } = await fetchTokenBookingDetails(listingAddr, bookingId);
      const record = buildLandlordBookingRecord(listing, bookingId, booking, pending);
      if (record) {
        records.push(record);
      }
    } catch (err) {
      failures += 1;
      console.error('Failed to load booking for listing', listingAddr, bookingId.toString(), err);
    }
  }
  if (records.length === 0 && failures > 0) {
    throw new Error('Unable to load bookings for this listing.');
  }
  records.sort((a, b) => {
    const left = a?.bookingId || 0n;
    const right = b?.bookingId || 0n;
    if (left === right) return 0;
    return left > right ? -1 : 1;
  });
  return records;
}

async function openTokenToolsForBooking(listing, bookingId, options = {}) {
  const controller = getListingController(listing);
  if (!controller || !controller.token) {
    notify({ message: 'Token tools unavailable for this listing.', variant: 'error', role: 'landlord', timeout: 5000 });
    return;
  }
  const { focus = true } = options;
  try {
    controller.setSectionOpen?.(true);
    if (focus) {
      controller.focusSummary?.();
    }
    await controller.token.openForBooking(bookingId, { focus });
  } catch (err) {
    console.error('Failed to open token tools via quick action', err);
    notify({ message: err?.message || 'Unable to load booking details.', variant: 'error', role: 'landlord', timeout: 6000 });
  }
}

function renderLandlordListingCard(listing) {
  const listingIdText = listing?.listingIdText || (listing?.listingId ? listing.listingId.toString() : '');
  const areaValue = Number(listing.areaSqm ?? 0n);
  const locationLabel =
    Number.isFinite(listing?.lat) && Number.isFinite(listing?.lon)
      ? `${Number(listing.lat).toFixed(5)}, ${Number(listing.lon).toFixed(5)}`
      : '';
  const fallbackId = listingIdText || shortAddress(listing?.address || '') || `listing-${listing?.order ?? 0}`;
  const summaryFallbackLabel = listingIdText
    ? `Listing #${listingIdText}`
    : shortAddress(listing?.address || '') ||
      (Number.isFinite(listing?.order) ? `Listing #${Number(listing.order) + 1}` : 'Listing');

  const titleText = (listing?.title || '').trim();
  const shortDescText = (listing?.shortDescription || '').trim();
  const summaryTitleParts = [];
  if (listingIdText) {
    summaryTitleParts.push(`Listing #${listingIdText}`);
  }
  if (titleText) {
    summaryTitleParts.push(titleText);
  }
  if (shortDescText) {
    summaryTitleParts.push(shortDescText);
  }
  const summaryTitle = summaryTitleParts.filter(Boolean).join(' — ') || titleText || summaryFallbackLabel || 'Listing';

  const summaryMetaTexts = [];
  if (locationLabel) {
    summaryMetaTexts.push(locationLabel);
  }
  if (listing.baseDailyRate != null) {
    summaryMetaTexts.push(`Daily ${fmt.usdc(listing.baseDailyRate)} USDC`);
  }
  if (Number.isFinite(areaValue) && areaValue > 0) {
    summaryMetaTexts.push(fmt.sqm(areaValue));
  }
  if (listing.depositAmount != null) {
    summaryMetaTexts.push(`Deposit ${fmt.usdc(listing.depositAmount)} USDC`);
  }
  const statusText = listing?.active === false ? 'Inactive' : 'Active';
  if (statusText) {
    summaryMetaTexts.push(statusText);
  }

  const summaryMeta = summaryMetaTexts
    .filter(Boolean)
    .map((text) => el('span', { class: 'pill' }, text));
  const summaryHeaderChildren = [el('strong', {}, summaryTitle)];
  if (summaryMeta.length > 0) {
    summaryHeaderChildren.push(el('div', { class: 'card-meta' }, summaryMeta));
  }

  const listingPanel = createCollapsibleSection(summaryTitle, { classes: ['listing-card', 'landlord-listing-card'] });
  const { section, content, toggle } = listingPanel;
  section.dataset.id = fallbackId;
  toggle.classList.add('landlord-card-toggle');
  toggle.textContent = '';
  toggle.append(el('div', { class: 'card-header' }, summaryHeaderChildren));
  toggle.setAttribute('aria-label', `Toggle tools for ${summaryTitle}`);

  const sections = el('div', { class: 'landlord-card-sections' });
  content.append(sections);

  const details = el('div', { class: 'landlord-card-details' });
  sections.append(details);

  const appendDetail = (text) => {
    if (!text) return;
    details.append(el('div', { class: 'landlord-card-detail' }, text));
  };

  appendDetail(`Base rate: ${fmt.usdc(listing.baseDailyRate)} USDC / day`);
  appendDetail(`Deposit: ${fmt.usdc(listing.depositAmount)} USDC`);
  if (Number.isFinite(areaValue) && areaValue > 0) {
    appendDetail(`Area: ${fmt.sqm(areaValue)}`);
  }
  const minNoticeText = fmt.duration(listing.minBookingNotice);
  const maxWindowText = listing.maxBookingWindow > 0n ? fmt.duration(listing.maxBookingWindow) : 'Unlimited';
  appendDetail(`Min notice: ${minNoticeText} · Booking window: ${maxWindowText}`);
  if (listingIdText) {
    const extraParts = [];
    if (titleText) {
      extraParts.push(titleText);
    }
    if (shortDescText) {
      extraParts.push(shortDescText);
    }
    const detailText = ['Listing ID: ' + listingIdText, ...extraParts].join(' — ');
    appendDetail(detailText);
  } else {
    appendDetail('Listing ID: (not assigned)');
  }
  const createdLabel = listing.createdAtIso || (listing.createdAt > 0n ? fmt.timestamp(listing.createdAt) : '(not recorded)');
  appendDetail(`Created: ${createdLabel}`);

  const addressRow = el('div', { class: 'landlord-card-detail landlord-card-address-row' }, [
    el('div', {}, 'Listing address:'),
    el('div', { class: 'landlord-card-address' }, listing.address || '—'),
  ]);
  if (navigator?.clipboard?.writeText && listing.address) {
    const copyBtn = el('button', { type: 'button', class: 'inline-button small' }, 'Copy address');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(listing.address);
        notify({ message: 'Listing address copied to clipboard.', variant: 'success', role: 'landlord', timeout: 4000 });
      } catch (err) {
        console.error('Failed to copy listing address', err);
        notify({ message: 'Unable to copy listing address.', variant: 'error', role: 'landlord', timeout: 5000 });
      }
    });
    addressRow.append(copyBtn);
  }
  details.append(addressRow);

  if (Number.isFinite(listing.lat) && Number.isFinite(listing.lon)) {
    const latText = Number(listing.lat).toFixed(5);
    const lonText = Number(listing.lon).toFixed(5);
    appendDetail(`Coordinates: ${latText}°, ${lonText}°`);
  }

  if (listing.metadataURI) {
    details.append(
      el('a', { href: listing.metadataURI, target: '_blank', rel: 'noopener', class: 'listing-link' }, 'Metadata'),
    );
  }

  const bookingsPanel = createCollapsibleSection('Bookings', { classes: ['landlord-bookings-card'] });
  const bookingsRefresh = el('button', {
    type: 'button',
    class: 'inline-button small',
    disabled: true,
  }, 'Refresh');
  const bookingsStatus = el('div', { class: 'bookings-status' }, 'Press refresh to load bookings.');
  const bookingsList = el('div', { class: 'bookings-list' });
  const bookingsHeader = el('div', { class: 'bookings-header' }, [
    el('h3', {}, 'Bookings'),
    bookingsRefresh,
  ]);
  bookingsPanel.content.append(bookingsHeader, bookingsStatus, bookingsList);
  sections.append(bookingsPanel.section);

  let bookingsLoaded = false;
  let bookingsLoading = null;

  const loadBookings = async ({ force = false } = {}) => {
    if (bookingsLoading) {
      return bookingsLoading;
    }
    if (bookingsLoaded && !force) {
      return;
    }
    bookingsLoading = (async () => {
      bookingsRefresh.disabled = true;
      bookingsStatus.textContent = 'Loading bookings…';
      try {
        const records = await fetchListingBookings(listing);
        bookingsLoaded = true;
        renderLandlordBookings(listing, bookingsList, records, bookingsStatus);
        if (!records || records.length === 0) {
          bookingsStatus.textContent = 'No bookings found for this listing yet.';
        }
      } catch (err) {
        console.error('Failed to load bookings for listing', listing?.address, err);
        bookingsStatus.textContent = err?.message || 'Unable to load bookings.';
        notify({
          message: 'Unable to load bookings for this listing.',
          variant: 'error',
          role: 'landlord',
          timeout: 6000,
        });
      } finally {
        bookingsLoading = null;
        bookingsRefresh.disabled = false;
      }
    })();
    try {
      await bookingsLoading;
    } finally {
      bookingsLoading = null;
    }
  };

  bookingsRefresh.addEventListener('click', () => {
    bookingsPanel.setOpen(true);
    loadBookings({ force: true }).catch((err) => {
      console.error('Failed to refresh bookings', err);
    });
  });

  const availabilityPanel = createCollapsibleSection('Check availability');
  const startInput = el('input', { type: 'date' });
  const endInput = el('input', { type: 'date' });
  const dateRow = el('div', { class: 'row' }, [
    el('label', {}, ['Start', startInput]),
    el('label', {}, ['End', endInput]),
  ]);
  const checkBtn = el('button', { type: 'button', class: 'check-availability' }, 'Check availability');
  const result = el('div', { class: 'availability-result muted' }, 'Select dates to check availability.');
  availabilityPanel.content.append(dateRow, checkBtn, result);
  sections.append(availabilityPanel.section);

  checkBtn.onclick = () =>
    disableWhile(checkBtn, async () => {
      try {
        const start = startInput.value;
        const end = endInput.value;
        if (!start || !end) throw new Error('Select dates.');
        const startMs = Date.parse(`${start}T00:00:00Z`);
        const endMs = Date.parse(`${end}T00:00:00Z`);
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error('Invalid dates.');
        const startTs = BigInt(Math.floor(startMs / 1000));
        const endTs = BigInt(Math.floor(endMs / 1000));
        if (endTs <= startTs) throw new Error('End before start.');
        result.className = 'availability-result';
        result.textContent = 'Checking…';
        info('Checking availability…');
        const available = await pub.readContract({
          address: REGISTRY_ADDRESS,
          abi: REGISTRY_ABI,
          functionName: 'isAvailable',
          args: [listing.address, startTs, endTs],
        });
        if (available) {
          result.className = 'availability-result available';
          result.textContent = 'Available';
          info('Listing available for selected dates.');
        } else {
          result.className = 'availability-result unavailable';
          result.textContent = 'Booked';
          info('Listing is booked for those dates.');
        }
      } catch (err) {
        result.className = 'availability-result error';
        result.textContent = err?.message || 'Error';
        info(`Error: ${err?.message || err}`);
      }
    });

  const depositTools = createDepositTools(listing);
  sections.append(depositTools.section);

  const tokenTools = createTokenTools(listing);
  sections.append(tokenTools.section);

  const controller = {
    listing,
    card: section,
    section,
    toggle,
    deposit: depositTools.controller,
    token: tokenTools.controller,
    setSectionOpen(value) {
      listingPanel.setOpen(value);
    },
    focusSummary() {
      if (typeof toggle.focus === 'function') {
        toggle.focus();
      }
    },
    setQuickAuthReady(value) {
      depositTools.controller?.setQuickAuthReady(value);
      tokenTools.controller?.setQuickAuthReady(value);
    },
    setQuickAuthFailed(message) {
      depositTools.controller?.setQuickAuthFailed(message);
      tokenTools.controller?.setQuickAuthFailed(message);
    },
    setWalletConnected(value) {
      depositTools.controller?.setWalletConnected(value);
      tokenTools.controller?.setWalletConnected(value);
    },
    openTokenForBooking(bookingId, options = {}) {
      tokenTools.controller?.openForBooking(bookingId, options);
    },
  };
  const key = getListingControllerKey(listing);
  if (key) {
    listingUiControllers.set(key, controller);
  }

  if (quickAuthReady) {
    controller.setQuickAuthReady(true);
  }
  controller.setWalletConnected(walletConnected);

  return section;
}
function toBigIntOrZero(value) {
  if (typeof value === 'bigint') return value;
  try {
    return BigInt(value || 0);
  } catch {
    return 0n;
  }
}

function toNumberOr(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function updateListingControlsVisibility(visible) {
  if (!els.listingControls) return;
  els.listingControls.hidden = !visible;
}

function renderLandlordListingView() {
  const container = els.landlordListings;
  if (!container) return;

  const { entries, total, filterInfo } = applyListingFilters(landlordListingRecords, {
    sortMode: listingSortMode,
    locationFilterValue: listingLocationFilterValue,
    geohashPrecision: GEOHASH_PRECISION,
    locationPrecision: LOCATION_FILTER_PRECISION,
    parseLatLon,
  });

  updateListingControlsVisibility(total > 0);

  if (els.listingSort && els.listingSort.value !== listingSortMode) {
    els.listingSort.value = listingSortMode;
  }

  if (els.listingLocationClear) {
    const hasFilterText = typeof listingLocationFilterValue === 'string' && listingLocationFilterValue.trim().length > 0;
    els.listingLocationClear.disabled = !hasFilterText;
  }

  container.innerHTML = '';

  if (total === 0) {
    container.classList.add('muted');
    container.textContent = 'No listings yet';
    info('No listings yet.');
    return;
  }

  if (filterInfo.applied && filterInfo.prefix && entries.length === 0) {
    container.classList.add('muted');
    container.textContent = 'No listings match the current filters.';
  } else {
    container.classList.remove('muted');
    for (const listing of entries) {
      container.appendChild(renderLandlordListingCard(listing));
    }
  }

  const activeKeys = new Set(entries.map((entry) => getListingControllerKey(entry)).filter(Boolean));
  for (const key of Array.from(listingUiControllers.keys())) {
    if (!activeKeys.has(key)) {
      listingUiControllers.delete(key);
    }
  }

  if (filterInfo.invalid && filterInfo.typed) {
    info(`Location filter not recognised — showing all ${total} listing${total === 1 ? '' : 's'}.`);
  } else if (filterInfo.applied && filterInfo.prefix) {
    if (entries.length === 0) {
      info('No listings match the current filters.');
    } else if (entries.length === total) {
      info(`Showing all ${total} listing${total === 1 ? '' : 's'} (filters applied).`);
    } else {
      info(`Showing ${entries.length} of ${total} listing${total === 1 ? '' : 's'} after filters.`);
    }
  } else {
    info(`Loaded ${total} listing${total === 1 ? '' : 's'}.`);
  }
}

function setLandlordListingRecords(records) {
  const normalized = [];
  if (Array.isArray(records)) {
    for (let i = 0; i < records.length; i++) {
      const entry = records[i];
      if (!entry) continue;
      const copy = { ...entry };
      if (!Number.isFinite(copy.order)) {
        copy.order = i;
      }
      if (typeof copy.geohash === 'string') {
        copy.geohash = copy.geohash.toLowerCase();
      }
      normalized.push(copy);
    }
  }
  landlordListingRecords = normalized;
  syncLandlordListingEventWatchers(normalized);
  renderLandlordListingView();
}

function resetLandlordRefreshQueue() {
  if (landlordEventRefreshState.timer) {
    clearTimeout(landlordEventRefreshState.timer);
    landlordEventRefreshState.timer = null;
  }
  landlordEventRefreshState.messages.clear();
  landlordEventRefreshState.running = false;
}

function clearLandlordEventWatchers() {
  for (const unwatchers of landlordListingEventWatchers.values()) {
    for (const stop of unwatchers) {
      try {
        if (typeof stop === 'function') {
          stop();
        }
      } catch (err) {
        console.warn('Failed to remove landlord event watcher', err);
      }
    }
  }
  landlordListingEventWatchers.clear();
}

function queueLandlordListingRefresh(message) {
  if (!currentLandlordAddress) {
    return;
  }
  if (message) {
    landlordEventRefreshState.messages.add(message);
  }
  if (landlordEventRefreshState.timer) {
    return;
  }
  landlordEventRefreshState.timer = setTimeout(processLandlordListingRefresh, 1500);
}

async function processLandlordListingRefresh() {
  landlordEventRefreshState.timer = null;
  if (!currentLandlordAddress) {
    landlordEventRefreshState.messages.clear();
    landlordEventRefreshState.running = false;
    return;
  }
  if (landlordListingsLoading || landlordEventRefreshState.running) {
    landlordEventRefreshState.timer = setTimeout(processLandlordListingRefresh, 1500);
    return;
  }
  const messages = Array.from(landlordEventRefreshState.messages);
  landlordEventRefreshState.messages.clear();
  landlordEventRefreshState.running = true;
  const summary = messages.length ? messages.join(' • ') : 'On-chain update detected';
  if (messages.length) {
    info(`${summary}. Refreshing listings…`);
  }
  let success = false;
  try {
    success = await loadLandlordListings(currentLandlordAddress, { silent: true });
  } catch (err) {
    console.error('Failed to refresh landlord listings after event', err);
  }
  if (success && messages.length) {
    info(`${summary}. Listings updated.`);
  }
  landlordEventRefreshState.running = false;
  if (landlordEventRefreshState.messages.size > 0) {
    landlordEventRefreshState.timer = setTimeout(processLandlordListingRefresh, 1500);
  }
}

function createLandlordListingWatchers(listingAddress) {
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
              console.error(`Landlord event handler error (${eventName})`, err);
            }
          }
        },
        onError: (err) => {
          console.error(`Landlord event watcher error (${eventName})`, err);
        },
      });
      if (typeof unwatch === 'function') {
        watchers.push(unwatch);
      }
    } catch (err) {
      console.error('Failed to watch landlord event', eventName, listingAddress, err);
    }
  };

  const shortListing = shortAddress(listingAddress);

  register('TokenisationProposed', (log) => {
    const bookingId = toBigIntOrZero(log?.args?.bookingId);
    const proposer = typeof log?.args?.proposer === 'string' ? log.args.proposer : '';
    const bookingLabel = bookingId > 0n ? bookingId.toString() : '?';
    const proposerLabel = proposer ? shortAddress(proposer) : 'unknown';
    const message = `Tokenisation proposed for booking #${bookingLabel} on ${shortListing} by ${proposerLabel}.`;
    notify({ message, variant: 'info', role: 'landlord', timeout: 6000 });
    queueLandlordListingRefresh(`Tokenisation proposal update for booking #${bookingLabel}`);
  });

  register('TokenisationApproved', (log) => {
    const bookingId = toBigIntOrZero(log?.args?.bookingId);
    const bookingLabel = bookingId > 0n ? bookingId.toString() : '?';
    const message = `Tokenisation approved for booking #${bookingLabel} on ${shortListing}.`;
    notify({ message, variant: 'success', role: 'landlord', timeout: 6000 });
    queueLandlordListingRefresh(`Tokenisation approved for booking #${bookingLabel}`);
  });

  register('SQMUTokensMinted', (log) => {
    const bookingId = toBigIntOrZero(log?.args?.bookingId);
    const bookingLabel = bookingId > 0n ? bookingId.toString() : '?';
    const investorAddr = typeof log?.args?.investor === 'string' ? log.args.investor : '';
    const investorLabel = investorAddr ? shortAddress(investorAddr) : 'unknown';
    const sqmuAmount = toBigIntOrZero(log?.args?.sqmuAmount);
    const message = `${investorLabel} purchased ${fmt.sqmu(sqmuAmount)} SQMU for booking #${bookingLabel} on ${shortListing}.`;
    notify({ message, variant: 'success', role: 'landlord', timeout: 6000 });
    queueLandlordListingRefresh(`SQMU sale update for booking #${bookingLabel}`);
  });

  register('RentPaid', (log) => {
    const bookingId = toBigIntOrZero(log?.args?.bookingId);
    const bookingLabel = bookingId > 0n ? bookingId.toString() : '?';
    const netAmount = toBigIntOrZero(log?.args?.netAmount);
    const message = `Rent payment received for booking #${bookingLabel} on ${shortListing}: ${fmt.usdc(netAmount)} USDC net.`;
    notify({ message, variant: 'success', role: 'landlord', timeout: 6000 });
    queueLandlordListingRefresh(`Rent payment for booking #${bookingLabel}`);
  });

  register('Claimed', (log) => {
    const bookingId = toBigIntOrZero(log?.args?.bookingId);
    const bookingLabel = bookingId > 0n ? bookingId.toString() : '?';
    const account = typeof log?.args?.account === 'string' ? log.args.account : '';
    const accountLabel = account ? shortAddress(account) : 'unknown';
    const amount = toBigIntOrZero(log?.args?.amount);
    const message = `${accountLabel} claimed ${fmt.usdc(amount)} USDC from booking #${bookingLabel} on ${shortListing}.`;
    notify({ message, variant: 'info', role: 'landlord', timeout: 6000 });
    queueLandlordListingRefresh(`Claim update for booking #${bookingLabel}`);
  });

  return watchers;
}

function syncLandlordListingEventWatchers(records) {
  if (!currentLandlordAddress) {
    return;
  }
  const desired = new Set();
  for (const entry of records || []) {
    const addr = normaliseAddress(entry?.address);
    if (!addr) {
      continue;
    }
    desired.add(addr);
    if (landlordListingEventWatchers.has(addr)) {
      continue;
    }
    const watchers = createLandlordListingWatchers(entry.address);
    if (watchers.length) {
      landlordListingEventWatchers.set(addr, watchers);
    }
  }
  for (const [addr, unwatchers] of landlordListingEventWatchers) {
    if (desired.has(addr)) {
      continue;
    }
    for (const stop of unwatchers) {
      try {
        if (typeof stop === 'function') {
          stop();
        }
      } catch (err) {
        console.warn('Failed to remove stale landlord watcher', err);
      }
    }
    landlordListingEventWatchers.delete(addr);
  }
}

let landlordListingsLoading;

async function loadLandlordListings(landlordAddr, options = {}) {
  const { silent = false } = options;
  const container = els.landlordListings;
  if (!container) return false;
  const normalized = typeof landlordAddr === 'string' ? landlordAddr.toLowerCase() : '';
  if (!normalized) return false;

  if (landlordListingsLoading) {
    try {
      const result = await landlordListingsLoading;
      return Boolean(result);
    } catch {
      return false;
    }
  }

  const setMessage = (msg) => {
    if (silent) return;
    container.classList.add('muted');
    container.textContent = msg;
  };

  landlordListingsLoading = (async () => {
    if (!silent) {
      setMessage('Loading your listings…');
    }

    let abi;
    try {
      abi = await loadPlatformAbi();
      if (!Array.isArray(abi) || abi.length === 0) {
        throw new Error('Platform ABI unavailable.');
      }
    } catch (err) {
      console.error('Failed to load Platform ABI for listings', err);
      setMessage('Unable to load listings.');
      info(err?.message ? `Error: ${err.message}` : 'Failed to load listings.');
      notify({ message: 'Unable to load listings.', variant: 'error', role: 'landlord', timeout: 6000 });
      throw err;
    }

    let addresses = [];
    try {
      const result = await pub.readContract({
        address: PLATFORM_ADDRESS,
        abi,
        functionName: 'allListings',
      });
      addresses = Array.isArray(result) ? result : [];
    } catch (err) {
      console.error('Failed to load listing addresses', err);
      setMessage('Unable to load listings.');
      info(err?.message ? `Error: ${err.message}` : 'Unable to load listings.');
      notify({ message: 'Unable to load listings.', variant: 'error', role: 'landlord', timeout: 6000 });
      throw err;
    }

    const cleaned = addresses.filter(
      (addr) => typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr) && !/^0x0+$/i.test(addr)
    );

    if (!cleaned.length) {
      setLandlordListingRecords([]);
      if (!silent) {
        notify({ message: 'No listings yet — create your first property.', variant: 'info', role: 'landlord', timeout: 5000 });
      }
      return true;
    }

    const infos = await Promise.all(cleaned.map((addr, index) => fetchListingInfo(addr, index)));
    const valid = infos.filter((entry) => entry && typeof entry.landlord === 'string');
    const matches = valid.filter((entry) => entry.landlord.toLowerCase() === normalized);

    if (!matches.length) {
      setLandlordListingRecords([]);
      if (!silent) {
        notify({ message: 'No listings yet — create your first property.', variant: 'info', role: 'landlord', timeout: 5000 });
      }
      return true;
    }

    setLandlordListingRecords(matches);
    if (!silent) {
      notify({
        message: `Loaded ${matches.length} listing${matches.length === 1 ? '' : 's'}.`,
        variant: 'success',
        role: 'landlord',
        timeout: 5000,
      });
    }
    return true;
  })();

  try {
    const result = await landlordListingsLoading;
    return Boolean(result);
  } catch {
    return false;
  } finally {
    landlordListingsLoading = null;
  }
}

let fidBig; // bigint from QuickAuth
let provider; // EIP-1193
const pub = createPublicClient({ chain: arbitrum, transport: http(RPC_URL || 'https://arb1.arbitrum.io/rpc') });

async function fetchTokenBookingDetails(listingAddr, bookingId) {
  const [bookingRaw, pendingRaw] = await Promise.all([
    pub.readContract({ address: listingAddr, abi: LISTING_ABI, functionName: 'bookingInfo', args: [bookingId] }),
    pub.readContract({ address: listingAddr, abi: LISTING_ABI, functionName: 'pendingTokenisation', args: [bookingId] }),
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
    tokenised: bookingRaw.tokenised,
    totalSqmu: bookingRaw.totalSqmu,
    soldSqmu: bookingRaw.soldSqmu,
    pricePerSqmu: bookingRaw.pricePerSqmu,
    feeBps: bookingRaw.feeBps,
    period: bookingRaw.period,
    proposer: bookingRaw.proposer,
    accRentPerSqmu: bookingRaw.accRentPerSqmu,
    landlordAccrued: bookingRaw.landlordAccrued,
    depositReleased: bookingRaw.depositReleased,
    depositTenantBps: bookingRaw.depositTenantBps,
    calendarReleased: bookingRaw.calendarReleased,
  };

  const pending = pendingRaw
    ? {
        exists: pendingRaw.exists,
        proposer: pendingRaw.proposer,
        totalSqmu: pendingRaw.totalSqmu,
        pricePerSqmu: pendingRaw.pricePerSqmu,
        feeBps: pendingRaw.feeBps,
        period: pendingRaw.period,
      }
    : { exists: false };

  return { booking, pending };
}

// -------------------- Deposit split tools --------------------
function parseBookingIdValue(raw) {
  const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (!text) throw new Error('Enter a booking ID.');
  if (!/^\d+$/.test(text)) throw new Error('Booking ID must be a whole number.');
  const value = BigInt(text);
  if (value <= 0n) throw new Error('Booking ID must be at least 1.');
  return value;
}

function parseTenantBpsValue(raw) {
  const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (!text) throw new Error('Enter the tenant share in basis points.');
  if (!/^\d+$/.test(text)) throw new Error('Tenant share must be whole basis points.');
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 10_000) {
    throw new Error('Basis points must be between 0 and 10000.');
  }
  return value;
}

async function fetchDepositBookingDetails(listingAddr, bookingId) {
  const [bookingRaw, pendingRaw] = await Promise.all([
    pub.readContract({ address: listingAddr, abi: LISTING_ABI, functionName: 'bookingInfo', args: [bookingId] }),
    pub.readContract({ address: listingAddr, abi: LISTING_ABI, functionName: 'pendingDepositSplit', args: [bookingId] }),
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
    tokenised: bookingRaw.tokenised,
    totalSqmu: bookingRaw.totalSqmu,
    soldSqmu: bookingRaw.soldSqmu,
    pricePerSqmu: bookingRaw.pricePerSqmu,
    feeBps: bookingRaw.feeBps,
    period: bookingRaw.period,
    proposer: bookingRaw.proposer,
  };
  const pending = pendingRaw
    ? {
        exists: pendingRaw.exists,
        tenantBps: pendingRaw.tenantBps,
        proposer: pendingRaw.proposer,
      }
    : { exists: false };
  return { booking, pending };
}

function renderDepositBookingInfo(container, listingAddr, bookingId, booking, pending) {
  if (!container || !booking) {
    return;
  }
  container.innerHTML = '';
  const statusIndex = Number(booking.status || 0n);
  const statusLabel = BOOKING_STATUS_LABELS[statusIndex] || `Unknown (${statusIndex})`;
  const durationSeconds = (booking.end || 0n) - (booking.start || 0n);
  const depositShareText = booking.depositReleased
    ? ` · Tenant share: ${(Number(booking.depositTenantBps || 0n) / 100).toFixed(2)}%`
    : '';
  const tokenised = Boolean(booking.tokenised);
  const tokenPeriodIndex = toNumberOr(booking.period, 0);
  const tokenPeriodLabel = BOOKING_PERIOD_LABELS[tokenPeriodIndex] || `Custom (${tokenPeriodIndex})`;
  const lines = [
    `Listing: ${listingAddr}`,
    `Booking ID: ${bookingId.toString()}`,
    `Status: ${statusLabel}`,
    `Tenant: ${booking.tenant}`,
    `Range: ${fmt.timestamp(booking.start)} → ${fmt.timestamp(booking.end)} (${fmt.duration(durationSeconds)})`,
    `Deposit held: ${fmt.usdc(booking.deposit)} USDC`,
    `Rent (gross/net): ${fmt.usdc(booking.grossRent)} / ${fmt.usdc(booking.expectedNetRent)} USDC`,
    `Rent paid so far: ${fmt.usdc(booking.rentPaid)} USDC`,
    `Deposit released: ${booking.depositReleased ? 'Yes' : 'No'}${depositShareText}`,
  ];
  if (tokenised) {
    lines.push(
      'Tokenisation: Enabled',
      `Total SQMU: ${fmt.sqmu(booking.totalSqmu)}`,
      `Sold SQMU: ${fmt.sqmu(booking.soldSqmu)}`,
      `Price per SQMU: ${fmt.usdc(booking.pricePerSqmu)} USDC`,
      `Token fee: ${fmt.bps(booking.feeBps)}`,
      `Token period: ${tokenPeriodLabel}`,
    );
  } else {
    lines.push('Tokenisation: Not enabled');
  }
  lines.push(
    pending?.exists
      ? `Pending proposal: tenant ${(Number(pending.tenantBps || 0n) / 100).toFixed(2)}% · proposer ${pending.proposer}`
      : 'Pending proposal: none',
  );
  for (const line of lines) {
    const row = document.createElement('div');
    row.textContent = line;
    container.appendChild(row);
  }
}

function createDepositTools(listing) {
  const { section, content, setOpen } = createCollapsibleSection('Deposit split');
  content.classList.add('deposit-tools');

  const intro = document.createElement('p');
  intro.className = 'muted';
  intro.textContent = 'Propose how deposits should be split after checkout. Platform owners confirm the final release.';
  content.appendChild(intro);

  const fieldset = document.createElement('div');
  const bookingLabel = document.createElement('label');
  bookingLabel.textContent = 'Booking ID';
  const bookingInput = document.createElement('input');
  bookingInput.type = 'number';
  bookingInput.min = '1';
  bookingInput.step = '1';
  bookingInput.placeholder = '1';
  bookingInput.inputMode = 'numeric';
  bookingLabel.appendChild(bookingInput);
  fieldset.appendChild(bookingLabel);

  const tenantLabel = document.createElement('label');
  tenantLabel.textContent = 'Tenant share (bps)';
  const tenantInput = document.createElement('input');
  tenantInput.type = 'number';
  tenantInput.min = '0';
  tenantInput.max = '10000';
  tenantInput.step = '1';
  tenantInput.value = '5000';
  tenantInput.inputMode = 'numeric';
  tenantLabel.appendChild(tenantInput);
  fieldset.appendChild(tenantLabel);

  content.appendChild(fieldset);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const loadBtn = document.createElement('button');
  loadBtn.type = 'button';
  loadBtn.className = 'inline-button';
  loadBtn.textContent = 'Load booking';
  actions.appendChild(loadBtn);

  const proposeBtn = document.createElement('button');
  proposeBtn.type = 'button';
  proposeBtn.className = 'inline-button';
  proposeBtn.textContent = 'Propose deposit split';
  actions.appendChild(proposeBtn);

  content.appendChild(actions);

  const statusEl = document.createElement('div');
  statusEl.className = 'muted deposit-status';
  content.appendChild(statusEl);

  const bookingInfoEl = document.createElement('div');
  bookingInfoEl.className = 'muted deposit-booking-info';
  content.appendChild(bookingInfoEl);

  const state = {
    quickAuthReady: false,
    walletConnected: false,
    currentBookingId: null,
  };

  const setStatus = (message, variant = 'info', { notify: shouldNotify = false } = {}) => {
    statusEl.textContent = message || '';
    if (shouldNotify && message) {
      notify({ message, variant, role: 'landlord', timeout: variant === 'error' ? 7000 : 5000 });
    }
  };

  const updateButtonState = () => {
    loadBtn.disabled = !state.quickAuthReady;
    const noBooking = !state.currentBookingId;
    proposeBtn.disabled = !state.quickAuthReady || !state.walletConnected || noBooking;
  };

  const clearBookingDetails = () => {
    bookingInfoEl.innerHTML = '';
    state.currentBookingId = null;
    updateButtonState();
  };

  const loadBooking = async ({ preserveStatus = false } = {}) => {
    if (!listing?.address) {
      setStatus('Listing address unavailable for deposit tools.', 'error');
      return;
    }
    let bookingId;
    try {
      bookingId = parseBookingIdValue(bookingInput.value);
    } catch (err) {
      setStatus(err?.message || 'Enter a valid booking ID.', 'error');
      return;
    }
    setStatus('Loading booking details…');
    loadBtn.disabled = true;
    try {
      const { booking, pending } = await fetchDepositBookingDetails(listing.address, bookingId);
      renderDepositBookingInfo(bookingInfoEl, listing.address, bookingId, booking, pending);
      state.currentBookingId = bookingId;
      if (pending?.tenantBps != null) {
        tenantInput.value = toNumberOr(pending.tenantBps, 0).toString();
      }
      if (!preserveStatus) {
        setStatus('Booking details loaded.', state.walletConnected ? 'success' : 'info');
      }
    } catch (err) {
      console.error('Unable to load deposit booking details', err);
      clearBookingDetails();
      if (isUnknownBookingError(err)) {
        setStatus('Booking not found for that listing. Double-check the ID and try again.', 'warning');
      } else {
        setStatus(err?.message || 'Unable to load booking details.', 'error');
      }
    } finally {
      updateButtonState();
    }
  };

  const submitProposal = async () => {
    if (!listing?.address) {
      setStatus('Listing address unavailable for deposit tools.', 'error');
      return;
    }
    if (!provider) {
      setStatus('Connect wallet before proposing deposit splits.', 'error');
      return;
    }
    if (!state.currentBookingId) {
      setStatus('Load a booking before proposing a deposit split.', 'error');
      return;
    }
    let tenantBps;
    try {
      tenantBps = parseTenantBpsValue(tenantInput.value);
    } catch (err) {
      setStatus(err?.message || 'Enter the tenant share in basis points.', 'error');
      return;
    }
    let from;
    try {
      const accounts = await provider.request({ method: 'eth_accounts' });
      [from] = Array.isArray(accounts) ? accounts : [];
    } catch (err) {
      console.error('Failed to read wallet accounts', err);
    }
    if (!from) {
      setStatus('No wallet account connected.', 'error');
      return;
    }
    try {
      await ensureArbitrum(provider);
    } catch (err) {
      setStatus(err?.message || 'Switch to Arbitrum to continue.', 'error');
      return;
    }
    try {
      await assertListingOwnership(listing.address, from);
    } catch (err) {
      setStatus(err?.message || 'Connected wallet is not the landlord for this listing.', 'error');
      return;
    }
    const args = [state.currentBookingId, BigInt(tenantBps)];
    const data = encodeFunctionData({ abi: LISTING_ABI, functionName: 'proposeDepositSplit', args });
    setStatus('Submitting deposit split proposal…');
    loadBtn.disabled = true;
    proposeBtn.disabled = true;
    try {
      let walletSendUnsupported = false;
      try {
        const { unsupported } = await requestWalletSendCalls(provider, {
          calls: [{ to: listing.address, data }],
          from,
          chainId: ARBITRUM_HEX,
        });
        walletSendUnsupported = unsupported;
      } catch (err) {
        if (isUserRejectedRequestError(err)) {
          setStatus('Deposit split proposal cancelled.', 'warning');
          return;
        }
        throw err;
      }
      if (walletSendUnsupported) {
        await provider.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: listing.address, data }],
        });
      }
      setStatus('Deposit split proposal submitted. Awaiting platform approval.', 'success', { notify: true });
      try {
        await loadBooking({ preserveStatus: true });
      } catch (err) {
        console.error('Failed to refresh deposit booking after proposal', err);
      }
    } catch (err) {
      console.error('Deposit split proposal failed', err);
      const variant = isUserRejectedRequestError(err) ? 'warning' : 'error';
      setStatus(err?.message || 'Failed to propose split.', variant);
    } finally {
      updateButtonState();
    }
  };

  loadBtn.addEventListener('click', () => {
    loadBooking();
  });

  proposeBtn.addEventListener('click', () => {
    submitProposal();
  });

  setStatus('Sign in with Farcaster to manage deposit splits.');
  updateButtonState();

  return {
    section,
    controller: {
      setQuickAuthReady: (ready) => {
        state.quickAuthReady = Boolean(ready);
        updateButtonState();
        if (state.quickAuthReady) {
          const message = state.walletConnected
            ? 'Load a booking to review its deposit.'
            : 'Connect wallet to manage deposit splits.';
          setStatus(message);
        }
      },
      setQuickAuthFailed: (message) => {
        state.quickAuthReady = false;
        clearBookingDetails();
        updateButtonState();
        setStatus(message, 'error');
      },
      setWalletConnected: (connected) => {
        state.walletConnected = Boolean(connected);
        updateButtonState();
        if (!state.quickAuthReady) {
          return;
        }
        const message = state.walletConnected
          ? state.currentBookingId
            ? 'Booking details loaded.'
            : 'Load a booking to review its deposit.'
          : 'Connect wallet to manage deposit splits.';
        setStatus(message);
      },
      openPanel: ({ focus = false } = {}) => {
        setOpen(true);
        if (focus) {
          bookingInput.focus();
        }
      },
      loadBookingById: async (bookingId, options = {}) => {
        bookingInput.value = bookingId?.toString() || '';
        await loadBooking(options);
      },
    },
  };
}
// -------------------- Tokenisation tools --------------------
function parseTokenTotalSqmuValue(raw) {
  const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (!text) throw new Error('Enter the total SQMU supply.');
  if (!/^\d+$/.test(text)) throw new Error('Total SQMU must be a whole number.');
  const value = BigInt(text);
  if (value === 0n) throw new Error('Total SQMU must be greater than zero.');
  return value;
}

function parseTokenPricePerSqmuValue(raw) {
  const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (!text) throw new Error('Enter the price per SQMU.');
  let value;
  try {
    value = parseDec6(text);
  } catch (err) {
    throw new Error('Enter the price per SQMU using up to 6 decimals.');
  }
  if (value <= 0n) {
    throw new Error('Price per SQMU must be greater than zero.');
  }
  return value;
}

function parseTokenFeeBpsValue(raw) {
  const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (!text) throw new Error('Enter the platform fee in basis points.');
  if (!/^\d+$/.test(text)) throw new Error('Platform fee must be whole basis points.');
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 10_000) {
    throw new Error('Platform fee must be between 0 and 10000 basis points.');
  }
  return value;
}

function parseTokenPeriodOptionValue(key) {
  const option = PERIOD_OPTIONS[key];
  if (!option) {
    throw new Error('Select a distribution period.');
  }
  return option;
}

function renderTokenBookingInfo(container, listingAddr, bookingId, booking, pending) {
  if (!container || !booking) {
    return;
  }
  container.innerHTML = '';
  const statusIndex = Number(booking.status || 0n);
  const statusLabel = BOOKING_STATUS_LABELS[statusIndex] || `Unknown (${statusIndex})`;
  const durationSeconds = (booking.end || 0n) - (booking.start || 0n);
  const periodIndex = Number(booking.period || 0n);
  const periodLabel = BOOKING_PERIOD_LABELS[periodIndex] || `Custom (${periodIndex})`;
  const awaitingApproval = Boolean(pending?.exists) && !booking.tokenised;

  const heading = document.createElement('div');
  heading.className = 'booking-tokenisation-title';
  heading.textContent = 'Tokenisation';
  container.appendChild(heading);

  if (awaitingApproval) {
    const alert = document.createElement('div');
    alert.className = 'booking-tokenisation-alert';
    alert.textContent = 'Waiting for platform approval';
    container.appendChild(alert);
  }

  const details = document.createElement('div');
  details.className = 'booking-details';
  details.appendChild(createBookingDetailElement('Status', statusLabel));
  details.appendChild(createBookingDetailElement('Booking ID', bookingId.toString()));
  details.appendChild(createBookingDetailElement('Range', `${fmt.timestamp(booking.start)} → ${fmt.timestamp(booking.end)} (${fmt.duration(durationSeconds)})`));
  details.appendChild(createBookingDetailElement('Deposit', `${fmt.usdc(booking.deposit)} USDC`));
  details.appendChild(createBookingDetailElement('Gross rent', `${fmt.usdc(booking.grossRent)} USDC`));
  details.appendChild(createBookingDetailElement('Net rent', `${fmt.usdc(booking.expectedNetRent)} USDC`));
  details.appendChild(createBookingDetailElement('Rent paid', `${fmt.usdc(booking.rentPaid)} USDC`));
  details.appendChild(createBookingDetailElement('Token period', periodLabel));
  details.appendChild(createBookingDetailElement('Tokenised', booking.tokenised ? 'Yes' : 'No'));
  if (booking.tokenised) {
    details.appendChild(createBookingDetailElement('Total SQMU', fmt.sqmu(booking.totalSqmu)));
    details.appendChild(createBookingDetailElement('Sold SQMU', fmt.sqmu(booking.soldSqmu)));
    details.appendChild(createBookingDetailElement('Price per SQMU', `${fmt.usdc(booking.pricePerSqmu)} USDC`));
    details.appendChild(createBookingDetailElement('Fee', fmt.bps(booking.feeBps)));
  }
  const proposerText = booking.proposer && !/^0x0+$/i.test(booking.proposer) ? booking.proposer : '—';
  details.appendChild(createBookingDetailElement('Last proposer', proposerText));
  if (pending?.exists) {
    const pendingPeriodIndex = Number(pending.period || 0);
    const pendingPeriodLabel = BOOKING_PERIOD_LABELS[pendingPeriodIndex] || `Custom (${pendingPeriodIndex})`;
    const pendingDetail = `Pending proposal: ${fmt.sqmu(pending.totalSqmu)} SQMU @ ${fmt.usdc(pending.pricePerSqmu)} USDC · Fee ${fmt.bps(pending.feeBps)} · ${pendingPeriodLabel} · proposer ${pending.proposer}`;
    details.appendChild(createBookingDetailElement('Pending', pendingDetail));
  } else {
    details.appendChild(createBookingDetailElement('Pending', 'None'));
  }
  container.appendChild(details);

  const helper = document.createElement('div');
  helper.className = 'booking-helper-text';
  helper.textContent = awaitingApproval
    ? 'Tokenisation proposal submitted. Awaiting platform decision.'
    : 'Load bookings to manage tokenisation proposals.';
  container.appendChild(helper);
}

function createTokenTools(listing) {
  const identifier = listing?.listingIdText || listing?.listingId?.toString?.() || shortAddress(listing?.address || '') || 'listing';
  const panelId = `tokenPanel-${identifier}`;
  const { section, content, setOpen } = createCollapsibleSection('Tokenisation');
  content.classList.add('token-tools');

  const intro = document.createElement('p');
  intro.className = 'muted';
  intro.textContent = 'Define SQMU supply, pricing and cadence for bookings you manage. Platform approval is required before investors can participate.';
  content.appendChild(intro);

  const bookingLabel = document.createElement('label');
  bookingLabel.textContent = 'Booking ID';
  const bookingInput = document.createElement('input');
  bookingInput.type = 'number';
  bookingInput.min = '1';
  bookingInput.step = '1';
  bookingInput.placeholder = '1';
  bookingInput.inputMode = 'numeric';
  bookingLabel.appendChild(bookingInput);
  content.appendChild(bookingLabel);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const loadBtn = document.createElement('button');
  loadBtn.type = 'button';
  loadBtn.className = 'inline-button';
  loadBtn.textContent = 'Load booking';
  actions.appendChild(loadBtn);
  content.appendChild(actions);

  const statusEl = document.createElement('div');
  statusEl.className = 'muted token-status';
  content.appendChild(statusEl);

  const infoContainer = document.createElement('div');
  infoContainer.className = 'token-booking-info';
  content.appendChild(infoContainer);

  const proposalPanel = document.createElement('div');
  proposalPanel.dataset.collapsibleContent = 'inner';
  proposalPanel.id = panelId;
  content.appendChild(proposalPanel);

  const state = {
    quickAuthReady: false,
    walletConnected: false,
    currentBookingId: null,
    awaitingApproval: false,
    loading: false,
  };

  let proposalForm = null;

  const setStatus = (message, variant = 'info', { notify: shouldNotify = false } = {}) => {
    statusEl.textContent = message || '';
    if (shouldNotify && message) {
      notify({ message, variant, role: 'landlord', timeout: variant === 'error' ? 7000 : 5000 });
    }
  };

  const updateButtonState = () => {
    loadBtn.disabled = !state.quickAuthReady || state.loading;
  };

  const updateFormDisabled = () => {
    if (!proposalForm) return;
    const disabled = !state.quickAuthReady || !state.walletConnected || state.awaitingApproval || state.loading;
    const controls = proposalForm.querySelectorAll('input, select, button');
    controls.forEach((el) => { el.disabled = disabled; });
  };

  const clearBookingDetails = () => {
    infoContainer.innerHTML = '';
    proposalPanel.innerHTML = '';
    proposalForm = null;
    state.currentBookingId = null;
    state.awaitingApproval = false;
    updateButtonState();
    updateFormDisabled();
  };

  const renderProposalForm = (booking, pending) => {
    proposalPanel.innerHTML = '';
    const form = TokenisationCard({
      bookingId: state.currentBookingId ? state.currentBookingId.toString() : '',
      totalSqmu: booking?.totalSqmu ? booking.totalSqmu.toString() : undefined,
      soldSqmu: booking?.soldSqmu ? booking.soldSqmu.toString() : undefined,
      pricePerSqmu: booking?.pricePerSqmu ? fmt.usdc(booking.pricePerSqmu) : undefined,
      feeBps: booking?.feeBps ? Number(booking.feeBps) : undefined,
      period: getPeriodKeyFromValue(booking?.period) || undefined,
      mode: 'propose',
      onSubmit: (vals) => submitProposal(vals),
    });
    proposalPanel.appendChild(form);
    const amountInput = form.querySelector('input[name="amount"]');
    if (amountInput && booking?.totalSqmu > 0n) {
      amountInput.value = booking.totalSqmu.toString();
    }
    const priceInput = form.querySelector('input[name="price"]');
    if (priceInput && booking?.pricePerSqmu > 0n) {
      priceInput.value = fmt.usdc(booking.pricePerSqmu);
    }
    const feeInput = form.querySelector('input[name="fee"]');
    if (feeInput && booking?.feeBps) {
      feeInput.value = booking.feeBps.toString();
    }
    const periodSelect = form.querySelector('select[name="period"]');
    const periodKey = getPeriodKeyFromValue(booking?.period);
    if (periodSelect && periodKey) {
      periodSelect.value = periodKey;
    }
    proposalForm = form;
    updateFormDisabled();
  };

  const loadBooking = async ({ preserveStatus = false } = {}) => {
    if (!listing?.address) {
      setStatus('Listing address unavailable for tokenisation tools.', 'error');
      return;
    }
    let bookingId;
    try {
      bookingId = parseBookingIdValue(bookingInput.value);
    } catch (err) {
      setStatus(err?.message || 'Enter a valid booking ID.', 'error');
      return;
    }
    setStatus('Loading booking details…');
    state.loading = true;
    updateButtonState();
    updateFormDisabled();
    try {
      const { booking, pending } = await fetchTokenBookingDetails(listing.address, bookingId);
      state.currentBookingId = bookingId;
      state.awaitingApproval = Boolean(pending?.exists) && !booking.tokenised;
      infoContainer.innerHTML = '';
      renderTokenBookingInfo(infoContainer, listing.address, bookingId, booking, pending);
      renderProposalForm(booking, pending);
      if (!preserveStatus) {
        if (state.awaitingApproval) {
          setStatus('Booking details loaded — waiting for platform approval before new proposals.', 'info');
        } else if (state.walletConnected) {
          setStatus('Booking details loaded. Adjust parameters and submit to manage tokenisation.', 'success');
        } else {
          setStatus('Booking details loaded. Connect wallet to submit proposals.', 'info');
        }
      }
    } catch (err) {
      console.error('Unable to load token booking details', err);
      clearBookingDetails();
      if (isUnknownBookingError(err)) {
        setStatus('Booking not found for that listing. Double-check the ID and try again.', 'warning');
      } else {
        setStatus(err?.message || 'Unable to load booking details.', 'error');
      }
    } finally {
      state.loading = false;
      updateButtonState();
      updateFormDisabled();
    }
  };

  const submitProposal = async (values) => {
    if (!listing?.address) {
      setStatus('Listing address unavailable for tokenisation tools.', 'error');
      return;
    }
    if (!provider) {
      setStatus('Connect wallet before proposing tokenisation.', 'error');
      return;
    }
    if (!state.currentBookingId) {
      setStatus('Load a booking before proposing tokenisation.', 'error');
      return;
    }
    if (state.awaitingApproval) {
      setStatus('Await platform approval before submitting a new proposal.', 'info');
      return;
    }
    let totalSqmu;
    let pricePerSqmu;
    let feeBps;
    let periodInfo;
    try {
      totalSqmu = parseTokenTotalSqmuValue(values.amount);
      pricePerSqmu = parseTokenPricePerSqmuValue(values.price);
      feeBps = parseTokenFeeBpsValue(values.fee);
      periodInfo = parseTokenPeriodOptionValue(values.period);
    } catch (err) {
      setStatus(err?.message || 'Check your proposal inputs.', 'error');
      return;
    }
    let from;
    try {
      const accounts = await provider.request({ method: 'eth_accounts' });
      [from] = Array.isArray(accounts) ? accounts : [];
    } catch (err) {
      console.error('Failed to read wallet accounts', err);
    }
    if (!from) {
      setStatus('No wallet account connected.', 'error');
      return;
    }
    try {
      await ensureArbitrum(provider);
    } catch (err) {
      setStatus(err?.message || 'Switch to Arbitrum to continue.', 'error');
      return;
    }
    try {
      await assertListingOwnership(listing.address, from);
    } catch (err) {
      setStatus(err?.message || 'Connected wallet is not the landlord for this listing.', 'error');
      return;
    }
    const args = [state.currentBookingId, totalSqmu, pricePerSqmu, BigInt(feeBps), periodInfo.value];
    try {
      await pub.simulateContract({
        address: listing.address,
        abi: LISTING_ABI,
        functionName: 'proposeTokenisation',
        args,
        account: from,
      });
    } catch (err) {
      const detail = err?.shortMessage || err?.message || 'Tokenisation proposal simulation failed.';
      setStatus(detail, 'error');
      return;
    }
    const data = encodeFunctionData({
      abi: LISTING_ABI,
      functionName: 'proposeTokenisation',
      args,
    });
    setStatus('Submitting tokenisation proposal…');
    state.loading = true;
    updateButtonState();
    updateFormDisabled();
    try {
      let walletSendUnsupported = false;
      let batchedSuccess = false;
      try {
        const { unsupported } = await requestWalletSendCalls(provider, {
          calls: [{ to: listing.address, data }],
          from,
          chainId: ARBITRUM_HEX,
        });
        walletSendUnsupported = unsupported;
        batchedSuccess = !unsupported;
      } catch (err) {
        if (isUserRejectedRequestError(err)) {
          setStatus('Tokenisation proposal cancelled.', 'warning');
          return;
        }
        throw err;
      }
      if (!batchedSuccess && walletSendUnsupported) {
        await provider.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: listing.address, data }],
        });
      }
      setStatus('Tokenisation proposal submitted. Awaiting platform approval.', 'success', { notify: true });
      try {
        await loadBooking({ preserveStatus: true });
      } catch (err) {
        console.error('Failed to refresh token booking details after proposal', err);
      }
    } catch (err) {
      console.error('Tokenisation proposal failed', err);
      const variant = isUserRejectedRequestError(err) ? 'warning' : 'error';
      setStatus(err?.message || 'Tokenisation proposal failed.', variant);
    } finally {
      state.loading = false;
      updateButtonState();
      updateFormDisabled();
    }
  };

  loadBtn.addEventListener('click', () => {
    loadBooking();
  });

  setStatus('Sign in with Farcaster to manage tokenisation.');
  updateButtonState();
  updateFormDisabled();

  return {
    section,
    controller: {
      setQuickAuthReady: (ready) => {
        state.quickAuthReady = Boolean(ready);
        updateButtonState();
        updateFormDisabled();
        if (state.quickAuthReady) {
          const message = state.walletConnected
            ? 'Load a booking to manage tokenisation.'
            : 'Connect wallet to propose tokenisation.';
          setStatus(message);
        }
      },
      setQuickAuthFailed: (message) => {
        state.quickAuthReady = false;
        clearBookingDetails();
        updateButtonState();
        updateFormDisabled();
        setStatus(message, 'error');
      },
      setWalletConnected: (connected) => {
        state.walletConnected = Boolean(connected);
        updateFormDisabled();
        if (!state.quickAuthReady) {
          return;
        }
        const message = state.walletConnected
          ? state.currentBookingId
            ? 'Booking details loaded. Adjust parameters and submit to manage tokenisation.'
            : 'Load a booking to manage tokenisation.'
          : 'Connect wallet to propose tokenisation.';
        setStatus(message);
      },
      openPanel: ({ focus = false } = {}) => {
        setOpen(true);
        if (focus) {
          bookingInput.focus();
        }
      },
      openForBooking: async (bookingId, options = {}) => {
        bookingInput.value = bookingId?.toString() || '';
        setOpen(true);
        if (options.focus) {
          bookingInput.focus();
        }
        await loadBooking(options);
      },
    },
  };
}
// -------------------- Boot --------------------
(async () => {
  try {
    await sdk.actions.ready();
  } catch {}

  await refreshListingPriceDisplay();

  try {
    const { token } = await sdk.quickAuth.getToken();
    const [, payloadB64] = token.split('.');
    const payloadJson = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    fidBig = BigInt(payloadJson.sub);
    els.contextBar.textContent = `FID: ${fidBig.toString()} · Signed in`;
    notify({ message: `Signed in with FID ${fidBig.toString()}.`, variant: 'success', role: 'landlord', timeout: 5000 });
    quickAuthReady = true;
    forEachListingController((controller) => {
      controller.setQuickAuthReady(true);
    });
  } catch (e) {
    quickAuthReady = false;
    els.contextBar.textContent = 'QuickAuth failed. Open this inside a Farcaster client.';
    notify({ message: 'QuickAuth failed. Open inside a Farcaster client.', variant: 'error', role: 'landlord', timeout: 6000 });
    forEachListingController((controller) => {
      controller.setQuickAuthFailed('QuickAuth failed. Open inside a Farcaster client.');
    });
    return;
  }

  els.connect.disabled = false;
  updateOnboardingProgress();
})();

// -------------------- Wallet connect --------------------
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

function setConnectButtonState(connected, label) {
  if (!els.connect) return;
  if (!els.connect.dataset.defaultLabel) {
    const initialLabel = (els.connect.textContent || '').trim();
    if (initialLabel) {
      els.connect.dataset.defaultLabel = initialLabel;
    }
  }
  if (connected) {
    if (label) {
      els.connect.textContent = label;
    }
    els.connect.classList.add('is-connected');
  } else {
    const fallback = els.connect.dataset.defaultLabel || 'Connect Wallet';
    els.connect.textContent = fallback;
    els.connect.classList.remove('is-connected');
  }
}

els.connect.onclick = async () => {
  try {
    provider = await sdk.wallet.getEthereumProvider();
    await provider.request({ method: 'eth_requestAccounts' });
    await ensureArbitrum(provider);
    const [from] = (await provider.request({ method: 'eth_accounts' })) || [];
    if (!from) throw new Error('No wallet account connected.');
    const landlordAddr = getAddress(from);
    const previousNormalised = normaliseAddress(currentLandlordAddress);
    const nextNormalised = normaliseAddress(landlordAddr);
    if (!previousNormalised || previousNormalised !== nextNormalised) {
      clearLandlordEventWatchers();
    }
    resetLandlordRefreshQueue();
    currentLandlordAddress = landlordAddr;
    setConnectButtonState(true, 'Wallet Connected');
    walletConnected = true;
    forEachListingController((controller) => {
      controller.setWalletConnected(true);
    });
    updateOnboardingProgress();
    info('Wallet ready. Loading your listings…');
    notify({ message: 'Wallet connected — ready to deploy.', variant: 'success', role: 'landlord', timeout: 5000 });
    try {
      await loadLandlordListings(landlordAddr);
    } catch (err) {
      console.error('Failed to refresh landlord listings after connect', err);
    }
  } catch (e) {
    walletConnected = false;
    setConnectButtonState(false);
    forEachListingController((controller) => {
      controller.setWalletConnected(false);
    });
    info(e?.message || 'Wallet connection failed.');
    notify({ message: e?.message || 'Wallet connection failed.', variant: 'error', role: 'landlord', timeout: 6000 });
    updateOnboardingProgress();
    resetLandlordRefreshQueue();
    clearLandlordEventWatchers();
    currentLandlordAddress = null;
  }
};

// -------------------- Create listing (compose cast → on-chain) --------------------
els.create.onclick = () =>
  disableWhile(els.create, async () => {
    try {
      const allComplete = Object.values(checkpointState).every(Boolean);
      if (!walletConnected || !allComplete) {
        info('Complete the required fields before creating a listing.');
        notify({
          message: 'Complete the required fields before creating a listing.',
          variant: 'warning',
          role: 'landlord',
          timeout: 5000,
        });
        return;
      }
      if (fidBig === undefined) throw new Error('QuickAuth did not provide FID.');
      if (!provider) throw new Error('Connect your wallet first.');

      const [from] = (await provider.request({ method: 'eth_accounts' })) || [];
      if (!from) throw new Error('No wallet account connected.');
      await ensureArbitrum(provider);
      const landlordAddr = getAddress(from);

      // Inputs + guards
      const title = els.title.value.trim();
      const shortDesc = els.shortDesc.value.trim();
      if (!title) throw new Error('Title is required.');
      if (!shortDesc) throw new Error('Short description is required.');
      if (utf8BytesLen(title) > 64) throw new Error('Title exceeds 64 bytes.');
      if (utf8BytesLen(shortDesc) > 140) throw new Error('Short description exceeds 140 bytes.');

      const deposit = parseDec6(els.deposit.value);
      const rateDaily = parseOptionalDec6(els.rateDaily.value);
      if (deposit <= 0n) throw new Error('Deposit must be greater than zero.');
      if (rateDaily <= 0n) throw new Error('Daily rate must be greater than zero.');

      const { lat, lon } = parseLatLon(els.lat.value, els.lon.value);
      const geohashStr = latLonToGeohash(lat, lon, GEOHASH_PRECISION);
      const geolen = geohashStr.length;
      const areaSqm = parseAreaSqm(els.areaSqm.value);
      const minBookingNotice = parseHoursToSeconds(els.minNotice.value);
      const maxBookingWindow = parseDaysToSeconds(els.maxWindow.value);
      const geohashBytes = geohashToBytes32(geohashStr);
      const listingPrice = await getListingPrice();
      const abi = await loadPlatformAbi();
      if (!Array.isArray(abi) || abi.length === 0) {
        throw new Error('Platform ABI unavailable');
      }

      // 1) Compose the landlord's canonical cast and capture the hash
      info('Open composer… Post your listing cast.');
      notify({ message: 'Opening Farcaster composer…', variant: 'info', role: 'landlord', timeout: 4000 });
      const qs = [
        'draft=1',
        `title=${encodeURIComponent(title)}`,
        `shortDesc=${encodeURIComponent(shortDesc)}`,
        `lat=${encodeURIComponent(String(lat))}`,
        `lon=${encodeURIComponent(String(lon))}`,
        `areaSqm=${encodeURIComponent(areaSqm.toString())}`,
      ].join('&');
      const embedUrl = `https://r3nt.sqmu.net/index.html?${qs}`;
      const res = await sdk.actions.composeCast({
        text: `🏠 ${title}\n${shortDesc}\n\nView & book in r3nt ↓`,
        embeds: [embedUrl],
        close: false,
      });
      if (res === undefined) {
        throw new Error('Composer invoked with close:true; no result returned.');
      }
      if (!res.cast) {
        throw new Error('Cast was not posted (user cancelled).');
      }
      const castHash = normalizeCastHash(res.cast.hash);
      if (!castHash) {
        throw new Error('Host returned an unexpected cast.hash format.');
      }
      info('Cast posted. Continuing on-chain…');
      notify({ message: 'Cast posted — preparing on-chain deployment.', variant: 'success', role: 'landlord', timeout: 5000 });

      const metadataUri = buildMetadataUri({
        metadataUrl: els.metadataUrl.value,
        title,
        shortDesc,
        embedUrl,
        geohash: geohashStr,
        geolen,
        areaSqm,
        deposit,
        rateDaily,
        fid: fidBig,
        castHash,
        minBookingNotice,
        maxBookingWindow,
        listingPrice,
      });

      // 2) Submit createListing to the platform
      info(`Submitting createListing (fee ${fmt.usdc(listingPrice)} USDC)…`);
      notify({ message: `Submitting createListing (fee ${fmt.usdc(listingPrice)} USDC)…`, variant: 'info', role: 'landlord', timeout: 5000 });
      const createData = encodeFunctionData({
        abi,
        functionName: 'createListing',
        args: [
          landlordAddr,
          fidBig,
          castHash,
          geohashBytes,
          geolen,
          areaSqm,
          rateDaily,
          deposit,
          minBookingNotice,
          maxBookingWindow,
          metadataUri,
        ],
      });

      const calls = [];
      let approveData;
      if (listingPrice > 0n) {
        approveData = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [PLATFORM_ADDRESS, listingPrice],
        });
        calls.push({ to: USDC_ADDRESS, data: approveData });
      }

      calls.push({ to: PLATFORM_ADDRESS, data: createData });

      if (listingPrice > 0n) {
        info(`Approving ${fmt.usdc(listingPrice)} USDC listing fee…`);
      } else {
        info('Submitting createListing…');
      }

      let txHash;
      const recordTxHash = (result) => {
        if (!result) return;
        const entries = Array.isArray(result?.results)
          ? result.results
          : Array.isArray(result)
            ? result
            : null;
        if (!Array.isArray(entries) || entries.length === 0) return;
        const last = entries[entries.length - 1];
        const hash =
          (typeof last?.hash === 'string' && last.hash.startsWith('0x'))
            ? last.hash
            : typeof last?.transactionHash === 'string' && last.transactionHash.startsWith('0x')
              ? last.transactionHash
              : null;
        if (hash) {
          txHash = hash;
        }
      };
      let walletSendUnsupported = false;
      try {
        const { result, unsupported } = await requestWalletSendCalls(provider, {
          calls,
          from,
          chainId: ARBITRUM_HEX,
        });
        if (!unsupported) {
          recordTxHash(result);
        } else {
          walletSendUnsupported = true;
        }
      } catch (err) {
        throw err;
      }

      if (walletSendUnsupported) {
        if (listingPrice > 0n && approveData) {
          await provider.request({
            method: 'eth_sendTransaction',
            params: [{ from, to: USDC_ADDRESS, data: approveData }],
          });
        }
        txHash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{ from, to: PLATFORM_ADDRESS, data: createData }],
        });
      }

      if (txHash) {
        info(`Listing tx sent: ${txHash}`);
        notify({ message: 'Listing transaction sent.', variant: 'success', role: 'landlord', timeout: 6000 });
      } else {
        info('Listing transaction submitted.');
        notify({ message: 'Listing transaction submitted.', variant: 'success', role: 'landlord', timeout: 6000 });
      }
    } catch (e) {
      if (isUserRejectedRequestError(e)) {
        const message = 'Listing transaction cancelled by user.';
        info(message);
        notify({ message, variant: 'warning', role: 'landlord', timeout: 5000 });
        return;
      }
      info(`Error: ${e?.message || e}`);
      notify({ message: e?.message ? `Create listing failed: ${e.message}` : 'Create listing failed.', variant: 'error', role: 'landlord', timeout: 6000 });
    }
  });

