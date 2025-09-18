import { sdk } from 'https://esm.sh/@farcaster/miniapp-sdk';
import { createPublicClient, http, encodeFunctionData, parseUnits, getAddress, erc20Abi } from 'https://esm.sh/viem@2.9.32';
import { arbitrum } from 'https://esm.sh/viem/chains';
import { latLonToGeohash, isHex20or32, toBytes32FromCastHash } from './tools.js';
import {
  PLATFORM_ADDRESS,
  PLATFORM_ABI,
  RPC_URL,
  REGISTRY_ADDRESS,
  REGISTRY_ABI,
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
  availListing: document.getElementById('availListing'),
  availStart: document.getElementById('availStart'),
  availEnd: document.getElementById('availEnd'),
  checkAvail: document.getElementById('checkAvail'),
  availResult: document.getElementById('availResult'),
};
const info = (t) => (els.status.textContent = t);

function formatUsdc(amount) {
  const value = typeof amount === 'bigint' ? amount : BigInt(amount || 0);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const units = abs / USDC_SCALAR;
  const fraction = (abs % USDC_SCALAR).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${units.toString()}${fraction ? '.' + fraction : ''}`;
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
  } catch (e) {
    els.contextBar.textContent = 'QuickAuth failed. Open this inside a Farcaster client.';
    return;
  }

  els.connect.disabled = false;
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
    els.connect.textContent = 'Wallet Connected';
    els.connect.style.background = '#10b981';
    els.create.disabled = false;
    info('Wallet ready.');
  } catch (e) {
    info(e?.message || 'Wallet connection failed.');
  }
};

// -------------------- Create listing (compose cast → on-chain) --------------------
els.create.onclick = () =>
  disableWhile(els.create, async () => {
    try {
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
      } else {
        info('Listing transaction submitted.');
      }
    } catch (e) {
      info(`Error: ${e?.message || e}`);
    }
  });

els.checkAvail.onclick = () =>
  disableWhile(els.checkAvail, async () => {
    try {
      const abi = await loadPlatformAbi();
      if (!Array.isArray(abi) || abi.length === 0) throw new Error('Platform ABI unavailable.');
      const rawId = String(els.availListing.value || '').trim();
      if (!/^\d+$/.test(rawId)) throw new Error('Listing ID must be a whole number.');
      const id = BigInt(rawId);
      if (id === 0n) throw new Error('Listing ID must be at least 1.');
      const start = els.availStart.value;
      const end = els.availEnd.value;
      if (!start || !end) throw new Error('Select dates.');
      const sTs = BigInt(Date.parse(start + 'T00:00:00Z') / 1000);
      const eTs = BigInt(Date.parse(end + 'T00:00:00Z') / 1000);
      if (eTs <= sTs) throw new Error('End before start');
      const listingAddr = await pub.readContract({
        address: PLATFORM_ADDRESS,
        abi,
        functionName: 'listingById',
        args: [id],
      });
      if (typeof listingAddr !== 'string' || /^0x0+$/i.test(listingAddr)) throw new Error('Listing not found.');
      const free = await pub.readContract({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'isAvailable',
        args: [listingAddr, sTs, eTs],
      });
      els.availResult.textContent = free ? 'Available' : 'Booked';
    } catch (e) {
      els.availResult.textContent = e?.message || 'Error';
    }
  });

