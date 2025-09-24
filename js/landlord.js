import { sdk } from 'https://esm.sh/@farcaster/miniapp-sdk';
import { createPublicClient, http, encodeFunctionData, parseUnits, getAddress, erc20Abi } from 'https://esm.sh/viem@2.9.32';
import { arbitrum } from 'https://esm.sh/viem/chains';
import { assertLatLon, geohashToLatLon, latLonToGeohash, isHex20or32, toBytes32FromCastHash } from './tools.js';
import { requestWalletSendCalls, isUserRejectedRequestError } from './wallet.js';
import { notify, mountNotificationCenter } from './notifications.js';
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
const LOCATION_FILTER_PRECISION = 5;
const GEOHASH_ALLOWED_PATTERN = /^[0-9bcdefghjkmnpqrstuvwxyz]+$/;
const LAT_LON_FILTER_PATTERN = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const DEFAULT_SORT_MODE = 'created-desc';
const BOOKING_STATUS_LABELS = ['None', 'Active', 'Completed', 'Cancelled', 'Defaulted'];
const BOOKING_PERIOD_LABELS = ['Unspecified', 'Daily', 'Weekly', 'Monthly'];

const UINT64_MAX = (1n << 64n) - 1n;
const utf8Encoder = new TextEncoder();
let platformAbi = Array.isArray(PLATFORM_ABI) && PLATFORM_ABI.length ? PLATFORM_ABI : null;
let listingPriceCache;
let listingPriceLoading;
let locationUpdateSource = null;

// -------------------- UI handles --------------------
const els = {
  contextBar: document.getElementById('contextBar'),
  feeInfo: document.getElementById('feeInfo'),
  connect: document.getElementById('connect'),
  create: document.getElementById('create'),
  status: document.getElementById('status'),
  lat: document.getElementById('lat'),
  lon: document.getElementById('lon'),
  geohash: document.getElementById('geohash'),
  useLocation: document.getElementById('useLocation'),
  title: document.getElementById('title'),
  shortDesc: document.getElementById('shortDesc'),
  deposit: document.getElementById('deposit'),
  areaSqm: document.getElementById('areaSqm'),
  rateDaily: document.getElementById('rateDaily'),
  rateWeekly: document.getElementById('rateWeekly'),
  rateMonthly: document.getElementById('rateMonthly'),
  minNotice: document.getElementById('minNotice'),
  maxWindow: document.getElementById('maxWindow'),
  metadataUrl: document.getElementById('metadataUrl'),
  landlordListings: document.getElementById('landlordListings'),
  onboardingHints: document.getElementById('onboardingHints'),
  onboardingChecklist: document.getElementById('onboardingChecklist'),
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
const depositEls = {
  section: document.getElementById('depositTools'),
  listingId: document.getElementById('depositListingId'),
  bookingId: document.getElementById('depositBookingId'),
  tenantBps: document.getElementById('depositTenantBps'),
  load: document.getElementById('depositLoad'),
  propose: document.getElementById('depositPropose'),
  bookingInfo: document.getElementById('depositBookingInfo'),
  status: document.getElementById('depositStatus'),
};
const info = (t) => (els.status.textContent = t);

mountNotificationCenter(document.getElementById('notificationTray'), { role: 'landlord' });

if (depositEls.status) {
  setDepositStatus('Sign in with Farcaster to manage deposit splits.');
}
if (depositEls.load) {
  depositEls.load.disabled = true;
}
if (depositEls.propose) {
  depositEls.propose.disabled = true;
}

const backButton = document.querySelector('[data-back-button]');
const backController = createBackController({ sdk, button: backButton });
backController.update();

const checklistItems = {
  basics: document.querySelector('[data-check="basics"]'),
  location: document.querySelector('[data-check="location"]'),
  pricing: document.querySelector('[data-check="pricing"]'),
  policies: document.querySelector('[data-check="policies"]'),
};

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

const onboardingFields = [
  'title',
  'shortDesc',
  'lat',
  'lon',
  'areaSqm',
  'deposit',
  'rateDaily',
  'rateWeekly',
  'rateMonthly',
  'minNotice',
  'maxWindow',
];

for (const key of onboardingFields) {
  const element = els[key];
  if (element) {
    element.addEventListener('input', updateOnboardingProgress);
    if (key === 'lat' || key === 'lon') {
      element.addEventListener('input', updateGeohashFromLatLon);
      element.addEventListener('blur', updateGeohashFromLatLon);
    }
  }
}

updateOnboardingProgress();
updateGeohashFromLatLon();
if (els.geohash) {
  els.geohash.addEventListener('input', () => {
    handleGeohashInput();
  });
  els.geohash.addEventListener('blur', () => {
    handleGeohashInput();
    updateGeohashFromLatLon();
  });
}
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

function formatUsdc(amount) {
  const value = typeof amount === 'bigint' ? amount : BigInt(amount || 0);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const units = abs / USDC_SCALAR;
  const fraction = (abs % USDC_SCALAR).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${units.toString()}${fraction ? '.' + fraction : ''}`;
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

function formatBasisPoints(value) {
  let bps;
  try {
    bps = typeof value === 'bigint' ? value : BigInt(value || 0);
  } catch {
    bps = 0n;
  }
  const numeric = Number(bps);
  if (!Number.isFinite(numeric)) {
    return `${bps.toString()} bps`;
  }
  const percent = (numeric / 100).toFixed(2).replace(/\.0+$/, '').replace(/\.([1-9])0$/, '.$1');
  return `${percent}% (${bps.toString()} bps)`;
}

function formatSqmu(value) {
  let amount;
  try {
    amount = typeof value === 'bigint' ? value : BigInt(value || 0);
  } catch {
    amount = 0n;
  }
  const numeric = Number(amount);
  if (Number.isFinite(numeric) && Math.abs(numeric) <= Number.MAX_SAFE_INTEGER) {
    return numeric.toLocaleString('en-US');
  }
  return amount.toString();
}

function formatTimestamp(ts) {
  const value = typeof ts === 'bigint' ? ts : BigInt(ts || 0);
  if (value === 0n) return '-';
  let asNumber;
  try {
    asNumber = Number(value);
  } catch {
    return '-';
  }
  if (!Number.isFinite(asNumber)) return '-';
  const date = new Date(asNumber * 1000);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
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
function parseLatLon(latStr, lonStr) {
  const lat = Number(latStr);
  const lon = Number(lonStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Latitude/Longitude must be numbers.');
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error('Latitude/Longitude out of range.');
  return { lat, lon };
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
    rateWeekly,
    rateMonthly,
    fid,
    castHash,
    minBookingNotice,
    maxBookingWindow,
    listingPrice,
  } = params;
  const trimmed = String(metadataUrl || '').trim();
  if (trimmed) {
    const lower = trimmed.toLowerCase();
    if (!/^https?:\/\//.test(lower) && !lower.startsWith('ipfs://') && !lower.startsWith('data:')) {
      throw new Error('Metadata URL must start with https://, ipfs:// or data:');
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
      weekly: rateWeekly.toString(),
      monthly: rateMonthly.toString(),
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

function updateGeohashFromLatLon() {
  if (!els.lat || !els.lon) return;
  if (locationUpdateSource === 'geohash') return;

  const latRaw = String(els.lat.value ?? '').trim();
  const lonRaw = String(els.lon.value ?? '').trim();
  if (!latRaw || !lonRaw) {
    if (els.geohash && locationUpdateSource !== 'geohash') {
      els.geohash.value = '';
    }
    return;
  }

  try {
    const { lat, lon } = parseLatLon(latRaw, lonRaw);
    const geohash = latLonToGeohash(lat, lon, GEOHASH_PRECISION);
    if (els.geohash) {
      locationUpdateSource = 'latlon';
      els.geohash.value = geohash;
      locationUpdateSource = null;
    }
  } catch {
  }
}

function handleGeohashInput() {
  if (!els.geohash) return;
  const raw = String(els.geohash.value ?? '').trim().toLowerCase();
  if (raw !== els.geohash.value) {
    locationUpdateSource = 'geohash';
    els.geohash.value = raw;
    locationUpdateSource = null;
  }

  if (!raw) {
    return;
  }

  if (locationUpdateSource === 'latlon') return;

  try {
    const coords = geohashToLatLon(raw);
    if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lon)) {
      return;
    }
    locationUpdateSource = 'geohash';
    els.lat.value = coords.lat.toFixed(6);
    els.lon.value = coords.lon.toFixed(6);
    locationUpdateSource = null;
    updateOnboardingProgress();
  } catch (err) {
    console.warn('Invalid geohash input', raw, err);
  }
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
        updateGeohashFromLatLon();
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
    const weekly = parseOptionalDec6(els.rateWeekly.value);
    const monthly = parseOptionalDec6(els.rateMonthly.value);
    results.pricing = deposit > 0n && (daily > 0n || weekly > 0n || monthly > 0n);
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
  const hints = [];

  if (!results.basics) hints.push('Add a title and short description.');
  if (!results.location) hints.push('Provide latitude, longitude and area.');
  if (!results.pricing) hints.push('Set a deposit and at least one rent rate.');
  if (!results.policies) hints.push('Configure booking notice and window.');

  if (els.onboardingHints) {
    if (hints.length) {
      els.onboardingHints.textContent = `Next: ${hints.join(' ')}`;
    } else {
      els.onboardingHints.textContent = 'All checkpoints cleared — ready to deploy.';
    }
  }

  for (const step of Object.keys(results)) {
    const complete = results[step];
    const node = checklistItems[step];
    if (node) {
      node.classList.toggle('complete', complete);
    }
    if (complete && !checkpointState[step]) {
      notify({
        message: `Checkpoint complete: ${checkpointLabels[step]}`,
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
      message: 'All onboarding checkpoints cleared. You can deploy your listing.',
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
    els.feeInfo.textContent = `Listing price: ${formatUsdc(price)} USDC`;
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

    return {
      address: listingAddr,
      baseDailyRate: getBig(0),
      depositAmount: getBig(1),
      metadataURI: getString(2, ''),
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
    };
  } catch (err) {
    console.error('Failed to load listing info', listingAddr, err);
    return null;
  }
}

function renderLandlordListingCard(listing) {
  const card = document.createElement('div');
  card.className = 'landlord-card';
  card.dataset.expanded = 'false';

  const baseId = (listing?.listingIdText || listing?.address || `listing-${listing?.order ?? 0}`).toString();
  const sanitizedId = baseId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const detailsId = `listing-details-${sanitizedId || `listing-${listing?.order ?? 0}`}`;

  const summary = document.createElement('div');
  summary.className = 'landlord-card-summary';

  const summaryMain = document.createElement('div');
  summaryMain.className = 'landlord-card-summary-main';
  summaryMain.tabIndex = 0;
  summaryMain.setAttribute('role', 'button');
  summaryMain.setAttribute('aria-controls', detailsId);
  summaryMain.setAttribute('aria-expanded', 'false');

  const idLine = document.createElement('div');
  idLine.className = 'landlord-card-id';
  idLine.textContent = listing.listingIdText ? `Listing #${listing.listingIdText}` : 'Listing';
  summaryMain.appendChild(idLine);

  const metaLine = document.createElement('div');
  metaLine.className = 'landlord-card-meta';
  const addressSpan = document.createElement('span');
  addressSpan.textContent = shortAddress(listing.address);
  if (listing.address) {
    addressSpan.title = listing.address;
  }
  metaLine.appendChild(addressSpan);

  const priceSpan = document.createElement('span');
  priceSpan.textContent = `${formatUsdc(listing.baseDailyRate)} USDC / day`;
  metaLine.appendChild(priceSpan);

  summaryMain.appendChild(metaLine);

  const summaryActions = document.createElement('div');
  summaryActions.className = 'landlord-card-summary-actions';

  if (navigator?.clipboard?.writeText && listing.address) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'icon-button';
    copyBtn.title = 'Copy listing address';
    copyBtn.setAttribute('aria-label', 'Copy listing address');
    copyBtn.textContent = '⧉';
    copyBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(listing.address);
        notify({
          message: 'Listing address copied to clipboard.',
          variant: 'success',
          role: 'landlord',
          timeout: 4000,
        });
      } catch (err) {
        console.error('Failed to copy listing address', err);
        notify({
          message: 'Unable to copy listing address.',
          variant: 'error',
          role: 'landlord',
          timeout: 5000,
        });
      }
    });
    summaryActions.appendChild(copyBtn);
  }

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'icon-button landlord-card-toggle';
  toggleBtn.textContent = '▸';
  toggleBtn.setAttribute('aria-label', 'Expand listing details');
  toggleBtn.setAttribute('aria-controls', detailsId);
  toggleBtn.setAttribute('aria-expanded', 'false');
  summaryActions.appendChild(toggleBtn);

  summary.appendChild(summaryMain);
  summary.appendChild(summaryActions);
  card.appendChild(summary);

  const details = document.createElement('div');
  details.className = 'landlord-card-details';
  details.id = detailsId;
  details.hidden = true;

  const rateLine = document.createElement('div');
  rateLine.className = 'landlord-card-detail';
  rateLine.textContent = `Base rate: ${formatUsdc(listing.baseDailyRate)} USDC / day`;
  details.appendChild(rateLine);

  const depositLine = document.createElement('div');
  depositLine.className = 'landlord-card-detail';
  depositLine.textContent = `Deposit: ${formatUsdc(listing.depositAmount)} USDC`;
  details.appendChild(depositLine);

  const areaValue = Number(listing.areaSqm ?? 0n);
  if (Number.isFinite(areaValue) && areaValue > 0) {
    const areaLine = document.createElement('div');
    areaLine.className = 'landlord-card-detail';
    areaLine.textContent = `Area: ${areaValue} m²`;
    details.appendChild(areaLine);
  }

  const minNoticeText = formatDuration(listing.minBookingNotice);
  const maxWindowText = listing.maxBookingWindow > 0n ? formatDuration(listing.maxBookingWindow) : 'Unlimited';
  const windowLine = document.createElement('div');
  windowLine.className = 'landlord-card-detail';
  windowLine.textContent = `Min notice: ${minNoticeText} · Booking window: ${maxWindowText}`;
  details.appendChild(windowLine);

  const idDetail = document.createElement('div');
  idDetail.className = 'landlord-card-detail';
  idDetail.textContent = listing.listingIdText ? `Listing ID: ${listing.listingIdText}` : 'Listing ID: (not assigned)';
  details.appendChild(idDetail);

  const createdDetail = document.createElement('div');
  createdDetail.className = 'landlord-card-detail';
  const createdLabel = listing.createdAtIso || (listing.createdAt > 0n ? `Unix ${listing.createdAt.toString()}` : '(not recorded)');
  createdDetail.textContent = `Created: ${createdLabel}`;
  details.appendChild(createdDetail);

  const addressContainer = document.createElement('div');
  addressContainer.className = 'landlord-card-detail';
  const addressLabel = document.createElement('div');
  addressLabel.textContent = 'Listing address:';
  const addressValue = document.createElement('div');
  addressValue.className = 'landlord-card-address';
  addressValue.textContent = listing.address || '—';
  addressContainer.appendChild(addressLabel);
  addressContainer.appendChild(addressValue);
  details.appendChild(addressContainer);

  if (listing.geohash) {
    const geohashLine = document.createElement('div');
    geohashLine.className = 'landlord-card-detail';
    geohashLine.textContent = `Geohash: ${listing.geohash}`;
    details.appendChild(geohashLine);
  }

  if (Number.isFinite(listing.lat) && Number.isFinite(listing.lon)) {
    const coordsLine = document.createElement('div');
    coordsLine.className = 'landlord-card-detail';
    const latText = Number(listing.lat).toFixed(5);
    const lonText = Number(listing.lon).toFixed(5);
    coordsLine.textContent = `Coordinates: ${latText}°, ${lonText}°`;
    details.appendChild(coordsLine);
  }

  if (listing.metadataURI) {
    const metaLink = document.createElement('a');
    metaLink.href = listing.metadataURI;
    metaLink.target = '_blank';
    metaLink.rel = 'noopener';
    metaLink.textContent = 'Metadata';
    metaLink.className = 'listing-link';
    details.appendChild(metaLink);
  }

  const dateRow = document.createElement('div');
  dateRow.className = 'row';

  const startLabel = document.createElement('label');
  startLabel.textContent = 'Start';
  const startInput = document.createElement('input');
  startInput.type = 'date';
  startLabel.appendChild(startInput);
  dateRow.appendChild(startLabel);

  const endLabel = document.createElement('label');
  endLabel.textContent = 'End';
  const endInput = document.createElement('input');
  endInput.type = 'date';
  endLabel.appendChild(endInput);
  dateRow.appendChild(endLabel);

  details.appendChild(dateRow);

  const checkBtn = document.createElement('button');
  checkBtn.textContent = 'Check availability';
  checkBtn.className = 'check-availability';
  details.appendChild(checkBtn);

  const result = document.createElement('div');
  result.className = 'availability-result muted';
  result.textContent = 'Select dates to check availability.';
  details.appendChild(result);

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

  card.appendChild(details);

  let expanded = false;
  const setExpanded = (value) => {
    expanded = Boolean(value);
    details.hidden = !expanded;
    card.dataset.expanded = expanded ? 'true' : 'false';
    const label = expanded ? 'Collapse listing details' : 'Expand listing details';
    toggleBtn.textContent = expanded ? '▾' : '▸';
    toggleBtn.setAttribute('aria-label', label);
    toggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    summaryMain.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  };

  const toggle = () => {
    setExpanded(!expanded);
  };

  summaryMain.addEventListener('click', toggle);
  summaryMain.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });
  toggleBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
  });

  return card;
}

function toBigIntOrZero(value) {
  if (typeof value === 'bigint') return value;
  try {
    return BigInt(value || 0);
  } catch {
    return 0n;
  }
}

function compareBigIntAsc(a, b) {
  const left = toBigIntOrZero(a);
  const right = toBigIntOrZero(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareBigIntDesc(a, b) {
  return -compareBigIntAsc(a, b);
}

function toNumberOr(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareNumber(a, b) {
  const left = toNumberOr(a);
  const right = toNumberOr(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareAddress(a, b) {
  const left = typeof a === 'string' ? a.toLowerCase() : '';
  const right = typeof b === 'string' ? b.toLowerCase() : '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseLocationFilter(rawValue) {
  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!raw) {
    return { typed: false, applied: false, invalid: false, prefix: '', derivedFrom: null };
  }
  const latLonMatch = raw.match(LAT_LON_FILTER_PATTERN);
  if (latLonMatch) {
    try {
      const { lat, lon } = parseLatLon(latLonMatch[1], latLonMatch[3]);
      const geohash = latLonToGeohash(lat, lon, GEOHASH_PRECISION);
      const prefix = geohash.slice(0, Math.min(LOCATION_FILTER_PRECISION, geohash.length)).toLowerCase();
      return { typed: true, applied: true, invalid: false, prefix, derivedFrom: 'latlon' };
    } catch (err) {
      console.warn('Invalid latitude/longitude filter input', raw, err);
      return { typed: true, applied: false, invalid: true, prefix: '', derivedFrom: 'latlon' };
    }
  }
  const normalized = raw.toLowerCase();
  if (!GEOHASH_ALLOWED_PATTERN.test(normalized)) {
    return { typed: true, applied: false, invalid: true, prefix: '', derivedFrom: 'geohash' };
  }
  return { typed: true, applied: true, invalid: false, prefix: normalized, derivedFrom: 'geohash' };
}

function sortListings(listings) {
  const arr = Array.isArray(listings) ? [...listings] : [];
  arr.sort((a, b) => {
    switch (listingSortMode) {
      case 'created-asc':
        return (
          compareBigIntAsc(a?.createdAt, b?.createdAt) ||
          compareNumber(a?.order, b?.order) ||
          compareAddress(a?.address, b?.address)
        );
      case 'price-asc':
        return (
          compareBigIntAsc(a?.baseDailyRate, b?.baseDailyRate) ||
          compareBigIntDesc(a?.createdAt, b?.createdAt) ||
          compareNumber(a?.order, b?.order)
        );
      case 'price-desc':
        return (
          compareBigIntDesc(a?.baseDailyRate, b?.baseDailyRate) ||
          compareBigIntDesc(a?.createdAt, b?.createdAt) ||
          compareNumber(a?.order, b?.order)
        );
      case 'created-desc':
      default:
        return (
          compareBigIntDesc(a?.createdAt, b?.createdAt) ||
          compareNumber(a?.order, b?.order) ||
          compareAddress(a?.address, b?.address)
        );
    }
  });
  return arr;
}

function applyListingFilters(records) {
  const list = Array.isArray(records) ? records : [];
  const filterInfo = parseLocationFilter(listingLocationFilterValue);
  let filtered = list;
  if (filterInfo.applied && filterInfo.prefix) {
    const prefix = filterInfo.prefix;
    filtered = list.filter((entry) => {
      const geohash = typeof entry?.geohash === 'string' ? entry.geohash.toLowerCase() : '';
      return geohash.startsWith(prefix);
    });
  }
  const sorted = sortListings(filtered);
  return { entries: sorted, total: list.length, filterInfo };
}

function updateListingControlsVisibility(visible) {
  if (!els.listingControls) return;
  els.listingControls.hidden = !visible;
}

function renderLandlordListingView() {
  const container = els.landlordListings;
  if (!container) return;

  const { entries, total, filterInfo } = applyListingFilters(landlordListingRecords);

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
  renderLandlordListingView();
}

let landlordListingsLoading;

async function loadLandlordListings(landlordAddr) {
  const container = els.landlordListings;
  if (!container) return;
  const normalized = typeof landlordAddr === 'string' ? landlordAddr.toLowerCase() : '';
  if (!normalized) return;

  if (landlordListingsLoading) {
    try {
      await landlordListingsLoading;
    } catch {
      // ignore
    }
    return;
  }

  const setMessage = (msg) => {
    container.classList.add('muted');
    container.textContent = msg;
  };

  landlordListingsLoading = (async () => {
    setMessage('Loading your listings…');

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
      notify({ message: 'No listings yet — create your first property.', variant: 'info', role: 'landlord', timeout: 5000 });
      return;
    }

    const infos = await Promise.all(cleaned.map((addr, index) => fetchListingInfo(addr, index)));
    const valid = infos.filter((entry) => entry && typeof entry.landlord === 'string');
    const matches = valid.filter((entry) => entry.landlord.toLowerCase() === normalized);

    if (!matches.length) {
      setLandlordListingRecords([]);
      notify({ message: 'No listings yet — create your first property.', variant: 'info', role: 'landlord', timeout: 5000 });
      return;
    }

    setLandlordListingRecords(matches);
    notify({
      message: `Loaded ${matches.length} listing${matches.length === 1 ? '' : 's'}.`,
      variant: 'success',
      role: 'landlord',
      timeout: 5000,
    });
  })();

  try {
    await landlordListingsLoading;
  } finally {
    landlordListingsLoading = null;
  }
}

let fidBig; // bigint from QuickAuth
let provider; // EIP-1193
const pub = createPublicClient({ chain: arbitrum, transport: http(RPC_URL || 'https://arb1.arbitrum.io/rpc') });

// -------------------- Deposit split tools --------------------
function setDepositStatus(message) {
  if (depositEls.status) {
    depositEls.status.textContent = message || '';
  }
}

function updateDepositStatus(message, variant = 'info') {
  setDepositStatus(message);
  if (message) {
    notify({ message, variant, role: 'landlord', timeout: variant === 'error' ? 7000 : 5000 });
  }
}

function clearDepositBookingInfo() {
  if (depositEls.bookingInfo) {
    depositEls.bookingInfo.innerHTML = '';
  }
}

function parseDepositListingId() {
  if (!depositEls.listingId) throw new Error('Listing ID input missing.');
  const raw = depositEls.listingId.value.trim();
  if (!/^\d+$/.test(raw)) throw new Error('Listing ID must be a whole number.');
  const id = BigInt(raw);
  if (id === 0n) throw new Error('Listing ID must be at least 1.');
  return id;
}

function parseDepositBookingId() {
  if (!depositEls.bookingId) throw new Error('Booking ID input missing.');
  const raw = depositEls.bookingId.value.trim();
  if (!/^\d+$/.test(raw)) throw new Error('Booking ID must be a whole number.');
  return BigInt(raw);
}

function parseDepositTenantBps() {
  if (!depositEls.tenantBps) throw new Error('Tenant share input missing.');
  const raw = depositEls.tenantBps.value.trim();
  if (!/^\d+$/.test(raw)) throw new Error('Tenant share must be whole basis points.');
  const bps = Number(raw);
  if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) {
    throw new Error('Basis points must be between 0 and 10000.');
  }
  return bps;
}

async function getListingAddressById(listingId) {
  const abi = await loadPlatformAbi();
  if (!Array.isArray(abi) || abi.length === 0) {
    throw new Error('Platform ABI unavailable.');
  }
  const addr = await pub.readContract({
    address: PLATFORM_ADDRESS,
    abi,
    functionName: 'listingById',
    args: [listingId],
  });
  if (
    typeof addr !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(addr) ||
    /^0x0+$/i.test(addr)
  ) {
    throw new Error('Listing not found.');
  }
  return addr;
}

function renderDepositBookingInfo(listingAddr, bookingId, booking, pending) {
  if (!depositEls.bookingInfo) return;
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
    `Range: ${formatTimestamp(booking.start)} → ${formatTimestamp(booking.end)} (${formatDuration(durationSeconds)})`,
    `Deposit held: ${formatUsdc(booking.deposit)} USDC`,
    `Rent (gross/net): ${formatUsdc(booking.grossRent)} / ${formatUsdc(booking.expectedNetRent)} USDC`,
    `Rent paid so far: ${formatUsdc(booking.rentPaid)} USDC`,
    `Deposit released: ${booking.depositReleased ? 'Yes' : 'No'}${depositShareText}`,
  ];
  if (tokenised) {
    lines.push(
      'Tokenisation: Enabled',
      `Total SQMU: ${formatSqmu(booking.totalSqmu)}`,
      `Sold SQMU: ${formatSqmu(booking.soldSqmu)}`,
      `Price per SQMU: ${formatUsdc(booking.pricePerSqmu)} USDC`,
      `Token fee: ${formatBasisPoints(booking.feeBps)}`,
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
  depositEls.bookingInfo.innerHTML = lines.map((line) => escapeHtml(line)).join('<br>');
}

async function loadDepositBooking() {
  if (!depositEls.load) return;
  setDepositStatus('Loading booking details…');
  try {
    const listingId = parseDepositListingId();
    const bookingId = parseDepositBookingId();
    const listingAddr = await getListingAddressById(listingId);
    const [bookingRaw, pending] = await Promise.all([
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
    };

    renderDepositBookingInfo(listingAddr, bookingId, booking, pending);
    updateDepositStatus('Booking details loaded.', 'success');
  } catch (err) {
    clearDepositBookingInfo();
    updateDepositStatus(err?.message || 'Unable to load booking details.', 'error');
  }
}

if (depositEls.load) {
  depositEls.load.addEventListener('click', () => {
    loadDepositBooking();
  });
}

if (depositEls.propose) {
  depositEls.propose.addEventListener('click', async () => {
    try {
      if (!provider) throw new Error('Connect wallet first.');
      const accounts = await provider.request({ method: 'eth_accounts' });
      const [from] = Array.isArray(accounts) ? accounts : [];
      if (!from) throw new Error('No wallet account.');
      await ensureArbitrum(provider);
      const listingId = parseDepositListingId();
      const bookingId = parseDepositBookingId();
      const tenantBps = parseDepositTenantBps();
      const listingAddr = await getListingAddressById(listingId);
      const data = encodeFunctionData({
        abi: LISTING_ABI,
        functionName: 'proposeDepositSplit',
        args: [bookingId, BigInt(tenantBps)],
      });
      const txHash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from, to: listingAddr, data }],
      });
      updateDepositStatus(`Proposal tx sent: ${txHash}`, 'success');
    } catch (err) {
      updateDepositStatus(err?.message || 'Failed to propose split.', 'error');
    }
  });
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
  } catch (e) {
    els.contextBar.textContent = 'QuickAuth failed. Open this inside a Farcaster client.';
    notify({ message: 'QuickAuth failed. Open inside a Farcaster client.', variant: 'error', role: 'landlord', timeout: 6000 });
    if (depositEls.load) {
      depositEls.load.disabled = true;
    }
    setDepositStatus('QuickAuth failed. Open inside a Farcaster client.');
    return;
  }

  if (depositEls.load) {
    depositEls.load.disabled = false;
  }
  setDepositStatus('Connect wallet to manage deposit splits.');
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
    setConnectButtonState(true, 'Wallet Connected');
    walletConnected = true;
    if (depositEls.propose) {
      depositEls.propose.disabled = false;
    }
    setDepositStatus('Wallet connected. Load a booking to review its deposit.');
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
    if (depositEls.propose) {
      depositEls.propose.disabled = true;
    }
    if (depositEls.load && depositEls.load.disabled === false) {
      setDepositStatus(e?.message || 'Wallet connection failed.');
    }
    info(e?.message || 'Wallet connection failed.');
    notify({ message: e?.message || 'Wallet connection failed.', variant: 'error', role: 'landlord', timeout: 6000 });
    updateOnboardingProgress();
  }
};

// -------------------- Create listing (compose cast → on-chain) --------------------
els.create.onclick = () =>
  disableWhile(els.create, async () => {
    try {
      const allComplete = Object.values(checkpointState).every(Boolean);
      if (!walletConnected || !allComplete) {
        info('Complete onboarding checkpoints before creating a listing.');
        notify({
          message: 'Complete onboarding checkpoints before creating a listing.',
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
      const rateWeekly = parseOptionalDec6(els.rateWeekly.value);
      const rateMonthly = parseOptionalDec6(els.rateMonthly.value);

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
        rateWeekly,
        rateMonthly,
        fid: fidBig,
        castHash,
        minBookingNotice,
        maxBookingWindow,
        listingPrice,
      });

      // 2) Submit createListing to the platform
      info(`Submitting createListing (fee ${formatUsdc(listingPrice)} USDC)…`);
      notify({ message: `Submitting createListing (fee ${formatUsdc(listingPrice)} USDC)…`, variant: 'info', role: 'landlord', timeout: 5000 });
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
        info(`Approving ${formatUsdc(listingPrice)} USDC listing fee…`);
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

