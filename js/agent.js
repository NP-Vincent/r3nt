import { sdk } from 'https://esm.sh/@farcaster/miniapp-sdk';
import { createPublicClient, http, encodeFunctionData, parseUnits } from 'https://esm.sh/viem@2.9.32';
import { arbitrum } from 'https://esm.sh/viem/chains';
import { notify, mountNotificationCenter } from './notifications.js';
import { requestWalletSendCalls, isUserRejectedRequestError, extractErrorMessage } from './wallet.js';
import {
  RPC_URL,
  LISTING_ABI,
  AGENT_ABI,
  R3NT_ABI,
  R3NT_ADDRESS,
  APP_VERSION,
} from './config.js';
import createBackController from './back-navigation.js';

const ARBITRUM_HEX = '0xa4b1';
const USDC_DECIMALS = 6;
const RENT_PRECISION = 1_000_000_000_000_000_000n; // 1e18
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_SUB_BOOKINGS = 50;

const els = {
  connect: document.getElementById('connect'),
  loadAgent: document.getElementById('loadAgent'),
  agentAddress: document.getElementById('agentAddress'),
  walletAddress: document.getElementById('walletAddress'),
  status: document.getElementById('status'),
  overviewCard: document.getElementById('overviewCard'),
  overview: document.getElementById('agentOverview'),
  fundraisingCard: document.getElementById('fundraisingCard'),
  fundraisingForm: document.getElementById('fundraisingForm'),
  fundraisingTotal: document.getElementById('fundraisingTotal'),
  fundraisingPrice: document.getElementById('fundraisingPrice'),
  fundraisingFee: document.getElementById('fundraisingFee'),
  fundraisingPeriod: document.getElementById('fundraisingPeriod'),
  openFundraising: document.getElementById('openFundraising'),
  closeFundraising: document.getElementById('closeFundraising'),
  rentCard: document.getElementById('rentCard'),
  rentMetrics: document.getElementById('rentMetrics'),
  collectRentForm: document.getElementById('collectRentForm'),
  rentPayer: document.getElementById('rentPayer'),
  rentAmount: document.getElementById('rentAmount'),
  withdrawFeesForm: document.getElementById('withdrawFeesForm'),
  withdrawRecipient: document.getElementById('withdrawRecipient'),
  subBookingsCard: document.getElementById('subBookingsCard'),
  subBookingsList: document.getElementById('subBookingsList'),
  subBookingForm: document.getElementById('subBookingForm'),
  subTenant: document.getElementById('subTenant'),
  subStart: document.getElementById('subStart'),
  subEnd: document.getElementById('subEnd'),
  subRent: document.getElementById('subRent'),
  collectSubRentForm: document.getElementById('collectSubRentForm'),
  collectSubId: document.getElementById('collectSubId'),
  collectSubPayer: document.getElementById('collectSubPayer'),
  collectSubAmount: document.getElementById('collectSubAmount'),
  collectSubComplete: document.getElementById('collectSubComplete'),
};

if (els.connect && !els.connect.dataset.defaultLabel) {
  const initialLabel = (els.connect.textContent || '').trim();
  if (initialLabel) {
    els.connect.dataset.defaultLabel = initialLabel;
  }
}

mountNotificationCenter(document.getElementById('notificationTray'), { role: 'agent' });

if (els.fundraisingPeriod && !els.fundraisingPeriod.value) {
  els.fundraisingPeriod.value = '3';
}

const pub = createPublicClient({ chain: arbitrum, transport: http(RPC_URL || 'https://arb1.arbitrum.io/rpc') });
let provider;
const state = { account: null, agent: null, data: null };
const backButton = document.querySelector('[data-back-button]');
const backController = createBackController({ sdk, button: backButton });
let agentViewBackEntry = null;
backController.update();

function setStatus(message) {
  if (els.status) {
    els.status.textContent = message || '';
  }
}

function setVersionBadge() {
  const badge = document.querySelector('[data-version]');
  if (badge) badge.textContent = `Build ${APP_VERSION}`;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setVersionBadge);
} else {
  setVersionBadge();
}

function shortAddress(value) {
  if (typeof value !== 'string') return '';
  if (!value.startsWith('0x') || value.length < 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function updateConnectedAccount(addr) {
  const value = typeof addr === 'string' ? addr : null;
  state.account = value;
  if (els.connect) {
    if (!els.connect.dataset.defaultLabel) {
      const initialLabel = (els.connect.textContent || '').trim();
      if (initialLabel) {
        els.connect.dataset.defaultLabel = initialLabel;
      }
    }
    els.connect.classList.toggle('is-connected', Boolean(value));
    if (value) {
      els.connect.textContent = 'Wallet connected';
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

function formatUsdc(amount) {
  const value = typeof amount === 'bigint' ? amount : BigInt(amount || 0);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const units = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${units.toString()}${fraction ? '.' + fraction : ''}`;
}

function formatBps(bps) {
  const num = Number(bps ?? 0);
  if (!Number.isFinite(num)) return `${bps} bps`;
  const pct = Math.round((num / 100) * 100) / 100;
  return `${num} bps${Number.isFinite(pct) ? ` (${pct.toFixed(pct % 1 === 0 ? 0 : 2)}%)` : ''}`;
}

function formatBoolean(value) {
  return value ? 'Yes' : 'No';
}

function formatTimestamp(seconds) {
  const value = typeof seconds === 'bigint' ? seconds : BigInt(seconds || 0);
  if (value <= 0n) return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return `Unix ${value}`;
  const date = new Date(num * 1000);
  if (Number.isNaN(date.getTime())) return `Unix ${value}`;
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function normaliseAddress(input, { optional = false } = {}) {
  const value = String(input ?? '').trim();
  if (!value) {
    if (optional) return ZERO_ADDRESS;
    throw new Error('Address is required.');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error('Address must be a 42-character hex string.');
  }
  return value;
}

function parsePositiveBigInt(input, label) {
  const value = String(input ?? '').trim();
  if (value === '') throw new Error(`${label} is required.`);
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a whole number.`);
  const result = BigInt(value);
  if (result <= 0n) throw new Error(`${label} must be greater than zero.`);
  return result;
}

function parseNonNegativeBigInt(input, label) {
  const value = String(input ?? '').trim();
  if (value === '') throw new Error(`${label} is required.`);
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a whole number.`);
  return BigInt(value);
}

function parseBpsInput(input, label) {
  const value = String(input ?? '').trim();
  if (value === '') throw new Error(`${label} is required.`);
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a whole number.`);
  const bps = Number(value);
  if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) throw new Error(`${label} must be between 0 and 10,000.`);
  return bps;
}

function parseUsdcInput(input, label) {
  const value = String(input ?? '').trim();
  if (value === '') throw new Error(`${label} is required.`);
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error(`${label} must use up to 6 decimals.`);
  return parseUnits(value, USDC_DECIMALS);
}

function parseDateTimeInput(input, label) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error(`${label} is required.`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} is invalid.`);
  const seconds = Math.floor(ms / 1000);
  if (seconds <= 0) throw new Error(`${label} must be after 1970.`);
  return BigInt(seconds);
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

function toggleSection(element, show) {
  if (!element) return;
  if (show) {
    element.removeAttribute('hidden');
  } else {
    element.setAttribute('hidden', '');
  }
}

function resetAgentView() {
  state.agent = null;
  state.data = null;
  toggleSection(els.overviewCard, false);
  toggleSection(els.fundraisingCard, false);
  toggleSection(els.rentCard, false);
  toggleSection(els.subBookingsCard, false);
  if (els.overview) {
    els.overview.innerHTML = '';
  }
  if (els.rentMetrics) {
    els.rentMetrics.innerHTML = '';
  }
  if (els.subBookingsList) {
    els.subBookingsList.innerHTML = '';
  }
  setStatus('Connect your wallet and load an agent to begin.');
  backController.reset({ skipHandlers: true });
  backController.update();
}

function renderAgentOverview(data) {
  const container = els.overview;
  if (!container) return;
  container.innerHTML = '';
  if (!data) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Load an agent to view details.';
    container.appendChild(empty);
    return;
  }

  const bookingCard = document.createElement('div');
  bookingCard.className = 'data-card';
  const bookingHeader = document.createElement('div');
  bookingHeader.className = 'data-card-header';
  const bookingTitle = document.createElement('strong');
  bookingTitle.textContent = shortAddress(data.listing) || 'Listing';
  bookingHeader.appendChild(bookingTitle);
  const bookingBadge = document.createElement('span');
  bookingBadge.className = 'badge';
  bookingBadge.textContent = `Booking #${data.bookingId?.toString?.() || '—'}`;
  bookingHeader.appendChild(bookingBadge);
  bookingCard.appendChild(bookingHeader);

  const bookingMetrics = document.createElement('div');
  bookingMetrics.className = 'metric-row';
  bookingMetrics.appendChild(makeMetric('Landlord', shortAddress(data.landlord) || '—'));
  bookingMetrics.appendChild(makeMetric('Platform', shortAddress(data.platform) || '—'));
  if (data.bookingInfo) {
    bookingMetrics.appendChild(makeMetric('Check-in', formatTimestamp(data.bookingInfo.start)));
    bookingMetrics.appendChild(makeMetric('Check-out', formatTimestamp(data.bookingInfo.end)));
    bookingMetrics.appendChild(makeMetric('Deposit', `${formatUsdc(data.bookingInfo.deposit)} USDC`));
    bookingMetrics.appendChild(makeMetric('Rent (net)', `${formatUsdc(data.bookingInfo.expectedNetRent)} USDC`));
  }
  bookingCard.appendChild(bookingMetrics);
  container.appendChild(bookingCard);

  const fundraisingCard = document.createElement('div');
  fundraisingCard.className = 'data-card';
  const fundraisingHeader = document.createElement('div');
  fundraisingHeader.className = 'data-card-header';
  const fundraisingTitle = document.createElement('strong');
  fundraisingTitle.textContent = 'Fundraising';
  fundraisingHeader.appendChild(fundraisingTitle);
  fundraisingCard.appendChild(fundraisingHeader);
  const fundraisingMetrics = document.createElement('div');
  fundraisingMetrics.className = 'metric-row';
  fundraisingMetrics.appendChild(makeMetric('Total SQMU', data.totalSqmu.toString()));
  fundraisingMetrics.appendChild(makeMetric('Sold SQMU', data.soldSqmu.toString()));
  fundraisingMetrics.appendChild(makeMetric('Price / SQMU', `${formatUsdc(data.pricePerSqmu)} USDC`));
  fundraisingMetrics.appendChild(makeMetric('Total raised', `${formatUsdc(data.totalRaised)} USDC`));
  fundraisingMetrics.appendChild(makeMetric('Fundraising fee', formatBps(data.fundraisingFeeBps)));
  fundraisingMetrics.appendChild(makeMetric('Active', formatBoolean(data.fundraisingActive)));
  fundraisingMetrics.appendChild(makeMetric('Closed', formatBoolean(data.fundraisingClosed)));
  fundraisingCard.appendChild(fundraisingMetrics);
  container.appendChild(fundraisingCard);

  const configCard = document.createElement('div');
  configCard.className = 'data-card';
  const configHeader = document.createElement('div');
  configHeader.className = 'data-card-header';
  const configTitle = document.createElement('strong');
  configTitle.textContent = 'Configuration';
  configHeader.appendChild(configTitle);
  configCard.appendChild(configHeader);
  const configMetrics = document.createElement('div');
  configMetrics.className = 'metric-row';
  configMetrics.appendChild(makeMetric('Agent wallet', shortAddress(data.agent) || '—'));
  configMetrics.appendChild(makeMetric('Fee recipient', shortAddress(data.agentFeeRecipient) || '—'));
  configMetrics.appendChild(makeMetric('Agent fee', formatBps(data.agentFeeBps)));
  configMetrics.appendChild(makeMetric('Agent fees accrued', `${formatUsdc(data.agentFeesAccrued)} USDC`, data.agentFeesAccrued > 0n));
  configMetrics.appendChild(makeMetric('Rent accumulator / SQMU', `${formatUsdc(data.accRentPerSqmu / RENT_PRECISION)} USDC`));
  configMetrics.appendChild(makeMetric('USDC token', shortAddress(data.usdc) || '—'));
  configMetrics.appendChild(makeMetric('SQMU token', shortAddress(data.sqmuToken) || '—'));
  configCard.appendChild(configMetrics);
  container.appendChild(configCard);
}

function makeMetric(label, value, highlight = false) {
  const wrapper = document.createElement('div');
  wrapper.className = 'metric';
  const title = document.createElement('label');
  title.textContent = label;
  wrapper.appendChild(title);
  const span = document.createElement('span');
  span.textContent = value;
  if (highlight) span.classList.add('highlight');
  wrapper.appendChild(span);
  return wrapper;
}

function renderRentMetrics(data) {
  const container = els.rentMetrics;
  if (!container) return;
  container.innerHTML = '';
  if (!data) {
    container.appendChild(makeMetric('Status', 'Load an agent to view metrics.'));
    return;
  }
  container.appendChild(makeMetric('Agent fees accrued', `${formatUsdc(data.agentFeesAccrued)} USDC`, data.agentFeesAccrued > 0n));
  container.appendChild(makeMetric('Rent accumulator / SQMU', `${formatUsdc(data.accRentPerSqmu / RENT_PRECISION)} USDC`));
  if (state.account) {
    container.appendChild(makeMetric('Your SQMU balance', data.accountBalance?.toString() || '0'));
    container.appendChild(makeMetric('Your contributions', `${formatUsdc(data.accountContribution)} USDC`, data.accountContribution > 0n));
    container.appendChild(makeMetric('Pending claim', `${formatUsdc(data.accountPendingClaim)} USDC`, data.accountPendingClaim > 0n));
  }
}

function renderSubBookings(list) {
  const container = els.subBookingsList;
  if (!container) return;
  container.innerHTML = '';
  if (!list || !list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No sub-bookings recorded yet.';
    container.appendChild(empty);
    return;
  }
  for (const entry of list) {
    const card = document.createElement('div');
    card.className = 'data-card';
    const header = document.createElement('div');
    header.className = 'data-card-header';
    const title = document.createElement('strong');
    title.textContent = `Sub-booking #${entry.id}`;
    header.appendChild(title);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = entry.active ? 'Active' : entry.calendarReleased ? 'Released' : 'Inactive';
    header.appendChild(badge);
    card.appendChild(header);

    const metrics = document.createElement('div');
    metrics.className = 'metric-row';
    metrics.appendChild(makeMetric('Tenant', shortAddress(entry.tenant) || '—'));
    metrics.appendChild(makeMetric('Window', `${formatTimestamp(entry.start)} → ${formatTimestamp(entry.end)}`));
    metrics.appendChild(makeMetric('Expected rent', `${formatUsdc(entry.expectedRent)} USDC`));
    metrics.appendChild(makeMetric('Paid rent', `${formatUsdc(entry.paidRent)} USDC`, entry.paidRent > 0n));
    metrics.appendChild(makeMetric('Calendar released', formatBoolean(entry.calendarReleased)));
    card.appendChild(metrics);

    if (entry.active) {
      const actions = document.createElement('div');
      actions.className = 'actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ghost';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => cancelSubBooking(entry.id, false, cancelBtn);
      actions.appendChild(cancelBtn);
      const defaultBtn = document.createElement('button');
      defaultBtn.className = 'ghost';
      defaultBtn.textContent = 'Mark default';
      defaultBtn.onclick = () => cancelSubBooking(entry.id, true, defaultBtn);
      actions.appendChild(defaultBtn);
      card.appendChild(actions);
    }

    container.appendChild(card);
  }
  if (list.length >= MAX_SUB_BOOKINGS) {
    const notice = document.createElement('div');
    notice.className = 'muted';
    notice.textContent = `Showing the first ${MAX_SUB_BOOKINGS} sub-bookings. Use the sub-booking ID form for older entries.`;
    container.appendChild(notice);
  }
}

function updateFundraisingForm(data) {
  if (!data) return;
  if (els.fundraisingTotal) {
    els.fundraisingTotal.value = data.totalSqmu.toString();
  }
  if (els.fundraisingPrice) {
    els.fundraisingPrice.value = formatUsdc(data.pricePerSqmu);
  }
  if (els.fundraisingFee) {
    els.fundraisingFee.value = Number(data.fundraisingFeeBps ?? 0).toString();
  }
}

async function loadAgentData(address) {
  try {
    const agentAddress = normaliseAddress(address);
    setStatus('Loading agent data…');
    const [
      bookingIdRaw,
      listing,
      landlord,
      agentWallet,
      agentFeeBpsRaw,
      agentFeeRecipient,
      totalSqmuRaw,
      soldSqmuRaw,
      pricePerSqmuRaw,
      totalRaisedRaw,
      fundraisingFeeBpsRaw,
      fundraisingActive,
      fundraisingClosed,
      agentFeesAccruedRaw,
      accRentPerSqmuRaw,
      nextSubBookingIdRaw,
      platform,
      sqmuToken,
      usdc,
    ] = await Promise.all([
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'bookingId' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'listing' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'landlord' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'agent' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'agentFeeBps' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'agentFeeRecipient' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'totalSqmu' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'soldSqmu' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'pricePerSqmu' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'totalRaised' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'fundraisingFeeBps' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'fundraisingActive' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'fundraisingClosed' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'agentFeesAccrued' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'accRentPerSqmu' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'nextSubBookingId' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'platform' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'sqmuToken' }),
      pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'usdc' }),
    ]);

    const bookingId = typeof bookingIdRaw === 'bigint' ? bookingIdRaw : BigInt(bookingIdRaw || 0);
    let bookingInfo = null;
    if (listing && bookingId > 0n) {
      try {
        bookingInfo = await pub.readContract({ address: listing, abi: LISTING_ABI, functionName: 'bookingInfo', args: [bookingId] });
      } catch (err) {
        console.warn('Failed to load booking info', err);
      }
    }

    const nextSubBookingId = typeof nextSubBookingIdRaw === 'bigint' ? nextSubBookingIdRaw : BigInt(nextSubBookingIdRaw || 0);
    const subBookings = [];
    const limit = Number(nextSubBookingId);
    if (Number.isFinite(limit) && limit > 0) {
      const max = Math.min(limit, MAX_SUB_BOOKINGS);
      for (let i = 0; i < max; i++) {
        const id = BigInt(i);
        try {
          const entry = await pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'subBookings', args: [id] });
          if (!entry) continue;
          const active = Boolean(entry.active);
          const start = typeof entry.start === 'bigint' ? entry.start : BigInt(entry.start || 0);
          const end = typeof entry.end === 'bigint' ? entry.end : BigInt(entry.end || 0);
          const expectedRent = typeof entry.expectedRent === 'bigint' ? entry.expectedRent : BigInt(entry.expectedRent || 0);
          const paidRent = typeof entry.paidRent === 'bigint' ? entry.paidRent : BigInt(entry.paidRent || 0);
          if (start === 0n && end === 0n && expectedRent === 0n && paidRent === 0n && !active) {
            continue;
          }
          subBookings.push({
            id: id.toString(),
            tenant: entry.tenant,
            start,
            end,
            expectedRent,
            paidRent,
            active,
            calendarReleased: Boolean(entry.calendarReleased),
          });
        } catch (err) {
          console.warn('Failed to load sub-booking', i, err);
        }
      }
    }

    let accountContribution = 0n;
    let accountPendingClaim = 0n;
    let accountBalance = 0n;
    if (state.account) {
      try {
        const contrib = await pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'contributions', args: [state.account] });
        accountContribution = typeof contrib === 'bigint' ? contrib : BigInt(contrib || 0);
      } catch {}
      if (bookingId > 0n) {
        try {
          const balance = await pub.readContract({ address: R3NT_ADDRESS, abi: R3NT_ABI, functionName: 'balanceOf', args: [state.account, bookingId] });
          accountBalance = typeof balance === 'bigint' ? balance : BigInt(balance || 0);
        } catch {}
        try {
          const pending = await pub.readContract({ address: agentAddress, abi: AGENT_ABI, functionName: 'previewClaim', args: [state.account] });
          accountPendingClaim = typeof pending === 'bigint' ? pending : BigInt(pending || 0);
        } catch {}
      }
    }

    const data = {
      agent: agentWallet,
      agentFeeBps: Number(agentFeeBpsRaw || 0),
      agentFeeRecipient,
      bookingId,
      bookingInfo,
      listing,
      landlord,
      platform,
      totalSqmu: typeof totalSqmuRaw === 'bigint' ? totalSqmuRaw : BigInt(totalSqmuRaw || 0),
      soldSqmu: typeof soldSqmuRaw === 'bigint' ? soldSqmuRaw : BigInt(soldSqmuRaw || 0),
      pricePerSqmu: typeof pricePerSqmuRaw === 'bigint' ? pricePerSqmuRaw : BigInt(pricePerSqmuRaw || 0),
      totalRaised: typeof totalRaisedRaw === 'bigint' ? totalRaisedRaw : BigInt(totalRaisedRaw || 0),
      fundraisingFeeBps: Number(fundraisingFeeBpsRaw || 0),
      fundraisingActive: Boolean(fundraisingActive),
      fundraisingClosed: Boolean(fundraisingClosed),
      agentFeesAccrued: typeof agentFeesAccruedRaw === 'bigint' ? agentFeesAccruedRaw : BigInt(agentFeesAccruedRaw || 0),
      accRentPerSqmu: typeof accRentPerSqmuRaw === 'bigint' ? accRentPerSqmuRaw : BigInt(accRentPerSqmuRaw || 0),
      sqmuToken,
      usdc,
      accountContribution,
      accountPendingClaim,
      accountBalance,
      subBookings,
    };

    state.agent = agentAddress;
    state.data = data;
    if (els.agentAddress) {
      els.agentAddress.value = agentAddress;
    }
    setStatus('Agent data loaded.');
    notify({ message: 'Agent data loaded.', variant: 'success', role: 'agent', timeout: 5000 });

    toggleSection(els.overviewCard, true);
    toggleSection(els.fundraisingCard, true);
    toggleSection(els.rentCard, true);
    toggleSection(els.subBookingsCard, true);

    renderAgentOverview(data);
    renderRentMetrics(data);
    renderSubBookings(subBookings);
    updateFundraisingForm(data);
    if (!agentViewBackEntry) {
      agentViewBackEntry = backController.push({
        onPop: () => {
          agentViewBackEntry = null;
          resetAgentView();
        },
      });
    }
    backController.update();
  } catch (err) {
    console.error('Failed to load agent data', err);
    state.data = null;
    const message = extractErrorMessage(err, 'Unable to load agent data.');
    setStatus(message);
    notify({ message, variant: 'error', role: 'agent', timeout: 6000 });
    toggleSection(els.overviewCard, false);
    toggleSection(els.fundraisingCard, false);
    toggleSection(els.rentCard, false);
    toggleSection(els.subBookingsCard, false);
    if (agentViewBackEntry) {
      agentViewBackEntry = null;
      backController.reset({ skipHandlers: true });
    }
    backController.update();
  }
}

async function sendAgentTransaction(functionName, args, messages = {}, button) {
  try {
    if (!state.agent) throw new Error('Load an agent first.');
    if (!state.account) throw new Error('Connect your wallet first.');
    const p = provider || (provider = await sdk.wallet.getEthereumProvider());
    const [from] = (await p.request({ method: 'eth_accounts' })) || [];
    if (!from) throw new Error('No wallet account connected.');
    await ensureArbitrum(p);
    const data = encodeFunctionData({ abi: AGENT_ABI, functionName, args });
    const call = { to: state.agent, data };
    if (button) button.disabled = true;
    const pending = messages.pending || 'Submitting transaction…';
    setStatus(pending);
    notify({ message: pending, variant: 'info', role: 'agent', timeout: 5000 });
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
        const cancelled = messages.cancelled || 'Transaction cancelled by user.';
        setStatus(cancelled);
        notify({ message: cancelled, variant: 'warning', role: 'agent', timeout: 5000 });
        return;
      }
      throw err;
    }

    if (walletSendUnsupported) {
      await p.request({ method: 'eth_sendTransaction', params: [{ from, to: state.agent, data }] });
    }
    const success = messages.success || 'Transaction sent.';
    setStatus(success);
    notify({ message: success, variant: 'success', role: 'agent', timeout: 6000 });
    await loadAgentData(state.agent);
  } catch (err) {
    console.error('Transaction failed', err);
    if (isUserRejectedRequestError(err)) {
      const message = messages.cancelled || 'Transaction cancelled by user.';
      setStatus(message);
      notify({ message, variant: 'warning', role: 'agent', timeout: 5000 });
      return;
    }
    const message = extractErrorMessage(err, 'Transaction failed.');
    setStatus(message);
    notify({ message, variant: 'error', role: 'agent', timeout: 6000 });
  } finally {
    if (button) button.disabled = false;
  }
}

async function cancelSubBooking(id, defaulted, button) {
  const bookingId = BigInt(id);
  await sendAgentTransaction(
    'cancelSubBooking',
    [bookingId, Boolean(defaulted)],
    { pending: 'Cancelling sub-booking…', success: 'Sub-booking updated.' },
    button
  );
}

if (els.loadAgent) {
  els.loadAgent.addEventListener('click', async () => {
    const raw = els.agentAddress?.value;
    try {
      const address = normaliseAddress(raw);
      await loadAgentData(address);
    } catch (err) {
      console.error('Failed to load agent', err);
      const message = extractErrorMessage(err, 'Unable to load agent.');
      setStatus(message);
      notify({ message, variant: 'error', role: 'agent', timeout: 6000 });
    }
  });
}

if (els.agentAddress) {
  els.agentAddress.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      els.loadAgent?.click();
    }
  });
}

if (els.connect) {
  els.connect.addEventListener('click', async () => {
    try {
      provider = await sdk.wallet.getEthereumProvider();
      await provider.request({ method: 'eth_requestAccounts' });
      await ensureArbitrum(provider);
      const [addr] = (await provider.request({ method: 'eth_accounts' })) || [];
      if (!addr) throw new Error('No wallet account connected.');
      updateConnectedAccount(addr);
      notify({ message: 'Wallet connected.', variant: 'success', role: 'agent', timeout: 5000 });
      if (state.agent) {
        await loadAgentData(state.agent);
      }
    } catch (err) {
      console.error('Wallet connection failed', err);
      updateConnectedAccount(null);
      const message = extractErrorMessage(err, 'Wallet connection failed.');
      setStatus(message);
      notify({ message, variant: 'error', role: 'agent', timeout: 6000 });
    }
  });
}

if (els.fundraisingForm) {
  els.fundraisingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    let total;
    let price;
    let feeBps;
    let periodValue;
    try {
      total = parsePositiveBigInt(els.fundraisingTotal?.value, 'Total SQMU supply');
      price = parseUsdcInput(els.fundraisingPrice?.value, 'Price per SQMU');
      feeBps = parseBpsInput(els.fundraisingFee?.value, 'Fundraising fee');
      periodValue = Number((els.fundraisingPeriod?.value ?? '').trim() || '3');
      if (!Number.isInteger(periodValue) || periodValue <= 0) {
        throw new Error('Select how often rent is paid.');
      }
    } catch (err) {
      console.error('Fundraising input error', err);
      const message = extractErrorMessage(err, 'Invalid fundraising parameters.');
      setStatus(message);
      notify({ message, variant: 'error', role: 'agent', timeout: 6000 });
      return;
    }
    const button = els.fundraisingForm.querySelector('button[type="submit"]');
    await sendAgentTransaction(
      'configureFundraising',
      [total, price, feeBps, periodValue],
      { pending: 'Updating fundraising configuration…', success: 'Fundraising configuration updated.' },
      button
    );
  });
}

els.openFundraising?.addEventListener('click', async () => {
  const button = els.openFundraising;
  await sendAgentTransaction('openFundraising', [], { pending: 'Opening fundraising…', success: 'Fundraising opened.' }, button);
});

els.closeFundraising?.addEventListener('click', async () => {
  const button = els.closeFundraising;
  await sendAgentTransaction('closeFundraising', [], { pending: 'Closing fundraising…', success: 'Fundraising closed.' }, button);
});

if (els.collectRentForm) {
  els.collectRentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    let payer;
    let amount;
    try {
      payer = normaliseAddress(els.rentPayer?.value);
      amount = parseUsdcInput(els.rentAmount?.value, 'Gross amount');
    } catch (err) {
      console.error('Collect rent input error', err);
      const message = extractErrorMessage(err, 'Invalid rent details.');
      setStatus(message);
      notify({ message, variant: 'error', role: 'agent', timeout: 6000 });
      return;
    }
    const button = els.collectRentForm.querySelector('button[type="submit"]');
    await sendAgentTransaction(
      'collectRent',
      [payer, amount],
      { pending: 'Collecting rent…', success: 'Rent recorded.' },
      button
    );
    els.collectRentForm.reset();
  });
}

if (els.withdrawFeesForm) {
  els.withdrawFeesForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    let recipient;
    try {
      recipient = normaliseAddress(els.withdrawRecipient?.value, { optional: true });
    } catch (err) {
      console.error('Withdraw fees input error', err);
      const message = extractErrorMessage(err, 'Invalid recipient address.');
      setStatus(message);
      notify({ message, variant: 'error', role: 'agent', timeout: 6000 });
      return;
    }
    const button = els.withdrawFeesForm.querySelector('button[type="submit"]');
    await sendAgentTransaction(
      'withdrawAgentFees',
      [recipient],
      { pending: 'Withdrawing agent fees…', success: 'Agent fees withdrawn.' },
      button
    );
    els.withdrawFeesForm.reset();
  });
}

if (els.subBookingForm) {
  els.subBookingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    let tenant;
    let start;
    let end;
    let rent;
    try {
      const tenantRaw = (els.subTenant?.value ?? '').trim();
      tenant = tenantRaw ? normaliseAddress(tenantRaw) : ZERO_ADDRESS;
      start = parseDateTimeInput(els.subStart?.value, 'Start time');
      end = parseDateTimeInput(els.subEnd?.value, 'End time');
      if (end <= start) throw new Error('End time must be after start time.');
      rent = parseUsdcInput(els.subRent?.value, 'Expected rent');
    } catch (err) {
      console.error('Create sub-booking input error', err);
      const message = extractErrorMessage(err, 'Invalid sub-booking details.');
      setStatus(message);
      notify({ message, variant: 'error', role: 'agent', timeout: 6000 });
      return;
    }
    const button = els.subBookingForm.querySelector('button[type="submit"]');
    await sendAgentTransaction(
      'createSubBooking',
      [tenant, start, end, rent],
      { pending: 'Creating sub-booking…', success: 'Sub-booking created.' },
      button
    );
    els.subBookingForm.reset();
  });
}

if (els.collectSubRentForm) {
  els.collectSubRentForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    let subId;
    let payer;
    let amount;
    let markComplete;
    try {
      subId = parseNonNegativeBigInt(els.collectSubId?.value, 'Sub-booking ID');
      payer = normaliseAddress(els.collectSubPayer?.value);
      amount = parseUsdcInput(els.collectSubAmount?.value, 'Gross amount');
      markComplete = (els.collectSubComplete?.value ?? 'true') === 'true';
    } catch (err) {
      console.error('Collect sublet rent input error', err);
      const message = extractErrorMessage(err, 'Invalid sublet rent details.');
      setStatus(message);
      notify({ message, variant: 'error', role: 'agent', timeout: 6000 });
      return;
    }
    const button = els.collectSubRentForm.querySelector('button[type="submit"]');
    await sendAgentTransaction(
      'collectSubletRent',
      [subId, payer, amount, markComplete],
      { pending: 'Recording sublet rent…', success: 'Sublet rent recorded.' },
      button
    );
    els.collectSubRentForm.reset();
  });
}

function boot() {
  setStatus('Connect your wallet and load an agent to begin.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

(async () => {
  try { await sdk.actions.ready(); } catch {}
})();
