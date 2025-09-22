import { sdk } from 'https://esm.sh/@farcaster/miniapp-sdk';
import { encodeFunctionData, erc20Abi, createPublicClient, http } from 'https://esm.sh/viem@2.9.32';
import { arbitrum } from 'https://esm.sh/viem/chains';
import { bytes32ToCastHash, buildFarcasterCastUrl, geohashToLatLon } from './tools.js';
import { notify, mountNotificationCenter } from './notifications.js';
import createBackController from './back-navigation.js';
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
};

let selectedListing = null;
let selectedCard = null;
let selectedListingTitle = '';
let pub;
let viewPassPrice;
let viewPassDuration;
let configLoading;
let viewPassRequired = false;
let hasActiveViewPass = false;

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
  const alreadySelected = selectedListing && selectedListing.address === info.address;
  if (selectedCard && selectedCard !== card) {
    selectedCard.classList.remove('selected');
  }
  selectedListing = info;
  selectedCard = card || null;
  selectedListingTitle = card?.dataset.displayTitle || getListingTitle(info);
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
    return {
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
  } catch (err) {
    console.error('Failed to load listing info', listingAddr, err);
    return null;
  }
}

function renderListingCard(info){
  const card = document.createElement('div');
  card.className = 'card';

  const title = document.createElement('div');
  title.className = 'listing-title';
  const displayTitle = getListingTitle(info);
  title.textContent = displayTitle;
  card.dataset.displayTitle = displayTitle;
  card.appendChild(title);

  if (info && typeof info.description === 'string') {
    const trimmed = info.description.trim();
    if (trimmed && trimmed !== displayTitle && trimmed !== info.address) {
      const summary = document.createElement('div');
      summary.className = 'listing-summary';
      summary.textContent = trimmed;
      card.appendChild(summary);
    }
  }

  const rateLine = document.createElement('div');
  rateLine.textContent = `Base rate: ${formatUsdc(info.baseDailyRate)} USDC / day`;
  card.appendChild(rateLine);

  const depositLine = document.createElement('div');
  depositLine.textContent = `Security deposit: ${formatUsdc(info.depositAmount)} USDC`;
  card.appendChild(depositLine);

  if (Number.isFinite(info.areaSqm) && info.areaSqm > 0) {
    const areaLine = document.createElement('div');
    areaLine.textContent = `Area: ${info.areaSqm} m²`;
    card.appendChild(areaLine);
  }

  const noticeLine = document.createElement('div');
  const minNoticeText = formatDuration(info.minBookingNotice);
  const maxWindowText = info.maxBookingWindow > 0n ? formatDuration(info.maxBookingWindow) : 'Unlimited';
  noticeLine.textContent = `Min notice: ${minNoticeText} · Booking window: ${maxWindowText}`;
  card.appendChild(noticeLine);

  if (info.geohash) {
    const geoLine = document.createElement('div');
    geoLine.className = 'listing-geo';
    const label = document.createElement('span');
    let preciseCoords = null;
    if (Number.isFinite(info.lat) && Number.isFinite(info.lon)) {
      const latText = info.lat.toFixed(5);
      const lonText = info.lon.toFixed(5);
      preciseCoords = `${info.lat.toFixed(6)},${info.lon.toFixed(6)}`;
      label.textContent = `Location: ${latText}°, ${lonText}°`;
    } else {
      label.textContent = 'Location: —';
    }
    geoLine.appendChild(label);

    if (preciseCoords) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'inline-button geo-copy-button';
      copyBtn.textContent = 'Copy';
      if (navigator?.clipboard?.writeText) {
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(preciseCoords);
            notify({
              message: 'Coordinates copied to clipboard.',
              variant: 'success',
              role: 'tenant',
              timeout: 4000,
            });
          } catch (err) {
            console.error('Failed to copy coordinates', err);
            notify({
              message: 'Unable to copy coordinates.',
              variant: 'error',
              role: 'tenant',
              timeout: 5000,
            });
          }
        };
      } else {
        copyBtn.disabled = true;
        copyBtn.title = 'Clipboard unavailable';
      }
      geoLine.appendChild(copyBtn);

      const mapLink = document.createElement('a');
      mapLink.href = `https://www.google.com/maps/search/?api=1&query=${preciseCoords}`;
      mapLink.target = '_blank';
      mapLink.rel = 'noopener';
      mapLink.className = 'geo-map-link';
      mapLink.textContent = 'Open map';
      geoLine.appendChild(mapLink);
    }

    card.appendChild(geoLine);
  }

  if (info.metadataURI) {
    const metaLink = document.createElement('a');
    metaLink.href = info.metadataURI;
    metaLink.target = '_blank';
    metaLink.rel = 'noopener';
    metaLink.textContent = 'Metadata';
    metaLink.className = 'listing-link';
    card.appendChild(metaLink);
  }

  const actions = document.createElement('div');
  actions.className = 'listing-actions';
  const planBtn = document.createElement('button');
  planBtn.type = 'button';
  planBtn.textContent = 'Plan stay';
  planBtn.onclick = () => setSelectedListing(info, card);
  actions.appendChild(planBtn);
  card.appendChild(actions);

  const farcasterUrl = buildFarcasterCastUrl(info.fid, info.castHash);
  const viewLink = document.createElement('a');
  viewLink.href = farcasterUrl;
  viewLink.target = '_blank';
  viewLink.rel = 'noopener';
  viewLink.textContent = 'View full details on Farcaster';
  viewLink.className = 'listing-link';
  viewLink.onclick = (ev) => {
    ev.preventDefault();
    openCast(info.fid, info.castHash, farcasterUrl);
  };
  card.appendChild(viewLink);

  return card;
}

async function loadListings(){
  await loadConfig();
  els.listings.textContent = 'Loading listings…';
  clearSelection();
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
  els.listings.innerHTML = '';
  if (!valid.length) {
    els.listings.textContent = 'No active listings.';
    notify({ message: 'No active listings right now.', variant: 'warning', role: 'tenant', timeout: 5000 });
    return;
  }
  for (const info of valid) {
    els.listings.appendChild(renderListingCard(info));
  }
  notify({
    message: `Loaded ${valid.length} listing${valid.length === 1 ? '' : 's'}.`,
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
    const calls = [{ to: listing.address, data: bookData }];

    const submitSequential = async () => {
      if (needsApproval && approveData) {
        await p.request({ method: 'eth_sendTransaction', params: [{ from, to: USDC_ADDRESS, data: approveData }] });
      }
      await p.request({ method: 'eth_sendTransaction', params: [{ from, to: listing.address, data: bookData }] });
    };

    const depositMsg = deposit > 0n ? `${formatUsdc(deposit)} USDC deposit` : 'no deposit';
    const rentMsg = rent > 0n ? `${formatUsdc(rent)} USDC rent` : '0 USDC rent';
    const cadenceMsg = installmentCap > 0n
      ? `${selectedPeriod.label} payments up to ${formatUsdc(installmentCap)} USDC`
      : `${selectedPeriod.label} payments`;
    const approvalNotice = needsApproval
      ? ' Approve the deposit when prompted, then confirm the booking.'
      : '';
    els.status.textContent = `Booking stay (${depositMsg}; rent due later: ${rentMsg}; ${cadenceMsg}).${approvalNotice}`;

    if (!needsApproval && calls.length === 1) {
      try {
        await p.request({ method: 'wallet_sendCalls', params: [{ calls }] });
      } catch {
        try {
          await p.request({ method: 'wallet_sendCalls', params: calls });
        } catch {
          await submitSequential();
        }
      }
    } else {
      await submitSequential();
    }

    els.status.textContent = 'Booking submitted.';
    notify({ message: 'Booking transaction sent.', variant: 'success', role: 'tenant', timeout: 6000 });
    updateSummary();
  } catch (e) {
    console.error(e);
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
      els.status.textContent = 'Connect wallet to verify your view pass status.';
      hasActiveViewPass = false;
      updateSummary();
      await loadListings();
      return;
    }

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

els.connect.onclick = async () => {
  try {
    if (!inHost) { els.status.textContent = 'Open in Farcaster app to connect wallet.'; return; }
    if (!(await hostSupportsWallet())) { els.status.textContent = 'This client does not support wallets for Mini Apps.'; return; }
    const p = await getProvider();
    await p.request({ method: 'eth_requestAccounts' });
    const [addr] = await p.request({ method: 'eth_accounts' });
    if (!addr) throw new Error('No account found.');
    await ensureArbitrum(p);
    els.addr.textContent = `Connected: ${short(addr)}`;
    els.connect.textContent = `Connected ${short(addr)}`;
    els.connect.style.background = '#10b981';
    els.buy.disabled = true;
    els.status.textContent = 'Ready.';
    await checkViewPass();
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
    try {
      await p.request({ method:'wallet_sendCalls', params:[{ calls }] });
    } catch {
      try {
        await p.request({ method:'wallet_sendCalls', params: calls });
      } catch {
        if (price > 0n && approveData) {
          await p.request({ method: 'eth_sendTransaction', params: [{ from, to: USDC_ADDRESS, data: approveData }] });
        }
        await p.request({ method: 'eth_sendTransaction', params: [{ from, to: PLATFORM_ADDRESS, data: buyData }] });
      }
    }
      els.status.textContent = 'Success. View pass purchased.';
      alert('View pass purchased!');
      await checkViewPass();
  } catch (err) { console.error(err); els.status.textContent = `Error: ${err?.message || err}`; }
};

loadConfig().catch((err) => console.error('Initial config load failed', err));

