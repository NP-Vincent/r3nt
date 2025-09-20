import { sdk } from 'https://esm.sh/@farcaster/miniapp-sdk';
import { createPublicClient, http, encodeFunctionData, parseUnits, getAddress, erc20Abi } from 'https://esm.sh/viem@2.9.32';
import { arbitrum } from 'https://esm.sh/viem/chains';
import { latLonToGeohash, isHex20or32, toBytes32FromCastHash } from './tools.js';
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

// -------------------- Config --------------------
const ARBITRUM_HEX = '0xa4b1';
const USDC_DECIMALS = 6;
const USDC_SCALAR = 1_000_000n;

const UINT64_MAX = (1n << 64n) - 1n;
const utf8Encoder = new TextEncoder();
let platformAbi = Array.isArray(PLATFORM_ABI) && PLATFORM_ABI.length ? PLATFORM_ABI : null;
let listingPriceCache;
let listingPriceLoading;

// -------------------- UI handles --------------------
const els = {
  contextBar: document.getElementById('contextBar'),
  feeInfo: document.getElementById('feeInfo'),
  connect: document.getElementById('connect'),
  create: document.getElementById('create'),
  status: document.getElementById('status'),
  lat: document.getElementById('lat'),
  lon: document.getElementById('lon'),
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
};
const info = (t) => (els.status.textContent = t);

mountNotificationCenter(document.getElementById('notificationTray'), { role: 'landlord' });

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
  }
}

updateOnboardingProgress();

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

async function fetchListingInfo(listingAddr) {
  try {
    const responses = await pub.multicall({
      contracts: [
        { address: listingAddr, abi: LISTING_ABI, functionName: 'baseDailyRate' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'depositAmount' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'metadataURI' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'minBookingNotice' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'maxBookingWindow' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'areaSqm' },
        { address: listingAddr, abi: LISTING_ABI, functionName: 'landlord' },
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
    return {
      address: listingAddr,
      baseDailyRate: getBig(0),
      depositAmount: getBig(1),
      metadataURI: getString(2, ''),
      minBookingNotice: getBig(3),
      maxBookingWindow: getBig(4),
      areaSqm: getBig(5),
      landlord: getString(6, '0x0000000000000000000000000000000000000000'),
    };
  } catch (err) {
    console.error('Failed to load listing info', listingAddr, err);
    return null;
  }
}

function renderLandlordListingCard(listing) {
  const card = document.createElement('div');
  card.className = 'landlord-card';

  const title = document.createElement('div');
  title.className = 'landlord-card-title';
  title.textContent = `Listing ${shortAddress(listing.address)}`;
  card.appendChild(title);

  const rateLine = document.createElement('div');
  rateLine.className = 'landlord-card-detail';
  rateLine.textContent = `Base rate: ${formatUsdc(listing.baseDailyRate)} USDC / day`;
  card.appendChild(rateLine);

  const depositLine = document.createElement('div');
  depositLine.className = 'landlord-card-detail';
  depositLine.textContent = `Deposit: ${formatUsdc(listing.depositAmount)} USDC`;
  card.appendChild(depositLine);

  const areaValue = Number(listing.areaSqm ?? 0n);
  if (Number.isFinite(areaValue) && areaValue > 0) {
    const areaLine = document.createElement('div');
    areaLine.className = 'landlord-card-detail';
    areaLine.textContent = `Area: ${areaValue} m²`;
    card.appendChild(areaLine);
  }

  const minNoticeText = formatDuration(listing.minBookingNotice);
  const maxWindowText = listing.maxBookingWindow > 0n ? formatDuration(listing.maxBookingWindow) : 'Unlimited';
  const windowLine = document.createElement('div');
  windowLine.className = 'landlord-card-detail';
  windowLine.textContent = `Min notice: ${minNoticeText} · Booking window: ${maxWindowText}`;
  card.appendChild(windowLine);

  if (listing.metadataURI) {
    const metaLink = document.createElement('a');
    metaLink.href = listing.metadataURI;
    metaLink.target = '_blank';
    metaLink.rel = 'noopener';
    metaLink.textContent = 'Metadata';
    metaLink.className = 'listing-link';
    card.appendChild(metaLink);
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

  card.appendChild(dateRow);

  const checkBtn = document.createElement('button');
  checkBtn.textContent = 'Check availability';
  checkBtn.className = 'check-availability';
  card.appendChild(checkBtn);

  const result = document.createElement('div');
  result.className = 'availability-result muted';
  result.textContent = 'Select dates to check availability.';
  card.appendChild(result);

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

  return card;
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
      setMessage('No listings yet');
      info('No listings yet.');
      notify({ message: 'No listings yet — create your first property.', variant: 'info', role: 'landlord', timeout: 5000 });
      return;
    }

    const infos = await Promise.all(cleaned.map((addr) => fetchListingInfo(addr)));
    const valid = infos.filter((entry) => entry && typeof entry.landlord === 'string');
    const matches = valid.filter((entry) => entry.landlord.toLowerCase() === normalized);

    if (!matches.length) {
      setMessage('No listings yet');
      info('No listings yet.');
      notify({ message: 'No listings yet — create your first property.', variant: 'info', role: 'landlord', timeout: 5000 });
      return;
    }

    container.classList.remove('muted');
    container.innerHTML = '';

    for (const listing of matches) {
      container.appendChild(renderLandlordListingCard(listing));
    }

    info(`Loaded ${matches.length} listing${matches.length === 1 ? '' : 's'}.`);
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

// -------------------- Boot --------------------
let fidBig; // bigint from QuickAuth
let provider; // EIP-1193
const pub = createPublicClient({ chain: arbitrum, transport: http(RPC_URL || 'https://arb1.arbitrum.io/rpc') });

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

els.connect.onclick = async () => {
  try {
    provider = await sdk.wallet.getEthereumProvider();
    await provider.request({ method: 'eth_requestAccounts' });
    await ensureArbitrum(provider);
    const [from] = (await provider.request({ method: 'eth_accounts' })) || [];
    if (!from) throw new Error('No wallet account connected.');
    const landlordAddr = getAddress(from);
    els.connect.textContent = 'Wallet Connected';
    els.connect.style.background = '#10b981';
    walletConnected = true;
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
      const geohashStr = latLonToGeohash(lat, lon, 7);
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
      try {
        const result = await provider.request({ method: 'wallet_sendCalls', params: [{ calls }] });
        recordTxHash(result);
      } catch (err) {
        try {
          const result = await provider.request({ method: 'wallet_sendCalls', params: calls });
          recordTxHash(result);
        } catch (fallbackErr) {
          try {
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
          } catch (finalErr) {
            throw finalErr;
          }
        }
      }

      if (txHash) {
        info(`Listing tx sent: ${txHash}`);
        notify({ message: 'Listing transaction sent.', variant: 'success', role: 'landlord', timeout: 6000 });
      } else {
        info('Listing transaction submitted.');
        notify({ message: 'Listing transaction submitted.', variant: 'success', role: 'landlord', timeout: 6000 });
      }
    } catch (e) {
      info(`Error: ${e?.message || e}`);
      notify({ message: e?.message ? `Create listing failed: ${e.message}` : 'Create listing failed.', variant: 'error', role: 'landlord', timeout: 6000 });
    }
  });

