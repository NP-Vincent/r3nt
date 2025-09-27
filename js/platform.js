const ethersLib = window.ethers;
if (!ethersLib) {
  throw new Error('Ethers library not found. Ensure ethers UMD bundle is loaded before platform.js.');
}

import {
  PLATFORM_ADDRESS,
  PLATFORM_ABI,
  LISTING_ABI,
  REGISTRY_ABI,
  REGISTRY_ADDRESS,
  FACTORY_ABI,
  RPC_URL,
  APP_VERSION,
} from './config.js';
import { connectWallet, disconnectWallet } from './platform-only-metamask-wallet.js';
import { notify, mountNotificationCenter } from './notifications.js';
import { normalizeCastInputToBytes32 } from './tools.js';

const { BigNumber, constants, utils, providers, Contract } = ethersLib;

const readProvider = new providers.JsonRpcProvider(RPC_URL);
const platformRead = new Contract(PLATFORM_ADDRESS, PLATFORM_ABI, readProvider);

let signer = null;
let provider = null;
let platformWrite = null;
let bookingRegistryAddress = null;
let bookingRegistryRead = null;
let bookingRegistryWrite = null;
let configuredRegistryAddress = null;
try {
  if (REGISTRY_ADDRESS) {
    const normalizedRegistry = utils.getAddress(REGISTRY_ADDRESS);
    if (normalizedRegistry !== constants.AddressZero) {
      configuredRegistryAddress = normalizedRegistry;
    }
  }
} catch (err) {
  console.warn('Invalid BookingRegistry address configured in config.js', err);
}
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const refreshSnapshotBtn = document.getElementById('refreshSnapshotBtn');
const connectedAccountEl = document.getElementById('connectedAccount');
const snapshotOutputEl = document.getElementById('snapshotOutput');
const actionStatusEl = document.getElementById('actionStatus');
const ownerGuardMessageEl = document.getElementById('ownerGuardMessage');
const ownerOnlyNodes = document.querySelectorAll('[data-owner-only]');
const devConsoleStatusEl = document.getElementById('devConsoleStatus');
const toggleDevConsoleBtn = document.getElementById('toggleDevConsoleBtn');
const depositListingIdInput = document.getElementById('depositListingId');
const depositBookingIdInput = document.getElementById('depositBookingId');
const depositLoadBtn = document.getElementById('depositLoadBtn');
const depositInfoEl = document.getElementById('depositInfo');
const depositStatusEl = document.getElementById('depositStatus');
const depositConfirmForm = document.getElementById('formConfirmDeposit');
const confirmDepositBtn = document.getElementById('confirmDepositBtn');
const deactivateListingForm = document.getElementById('formDeactivateListing');
const deactivateListingIdInput = document.getElementById('deactivateListingId');
const deactivateListingStatusEl = document.getElementById('deactivateListingStatus');
const deactivateListingSubmitBtn = document.getElementById('deactivateListingSubmit');
const deregisterListingForm = document.getElementById('formDeregisterListing');
const deregisterListingIdInput = document.getElementById('deregisterListingId');
const deregisterListingAddressInput = document.getElementById('deregisterListingAddress');
const deregisterLookupBtn = document.getElementById('deregisterLookupBtn');
const deregisterListingStatusEl = document.getElementById('deregisterListingStatus');
const deregisterSubmitBtn = document.getElementById('deregisterListingSubmit');
const tokenRefreshBtn = document.getElementById('tokenRefreshBtn');
const tokenProposalStatusEl = document.getElementById('tokenProposalStatus');
const tokenProposalListEl = document.getElementById('tokenProposalList');

const OWNER_REQUIREMENT_MESSAGE = 'Connect the platform owner wallet to unlock controls.';

let ownerAddress = null;
let ownerAddressPromise = null;
let ownerRequirementMessage = OWNER_REQUIREMENT_MESSAGE;
let ownerAccessGranted = false;

const STATUS_LABELS = ['None', 'Active', 'Completed', 'Cancelled', 'Defaulted'];
const BOOKING_STATUS_CLASS_MAP = { 1: 'active', 2: 'completed', 3: 'cancelled', 4: 'defaulted' };
const TOKEN_PERIOD_LABELS = ['Unspecified', 'Daily', 'Weekly', 'Monthly'];
const DEPOSIT_DEFAULT_MESSAGE =
  'Enter a listing & booking ID, then load the booking to inspect its deposit status.';
const DEPOSIT_DEFAULT_STATUS = 'Load a booking to view deposit proposal details.';
let currentDepositContext = null;
const DEACTIVATE_DEFAULT_STATUS = 'Enter a listing ID to verify availability.';
const DEREGISTER_DEFAULT_STATUS = 'Enter a listing address or lookup by ID.';
const DEREGISTER_REGISTRY_WARNING =
  'Booking registry not configured. Update module addresses before deregistering listings.';
let deactivateListingContext = {
  listingId: null,
  listingAddress: null,
  exists: false,
  loading: false,
  active: false,
};
let deactivateLookupCounter = 0;
let deactivateLookupTimeout = null;
let deregisterContext = { listingId: null, address: null, resolvedFromId: false, loading: false };
let deregisterLookupCounter = 0;
let tokenProposalRecords = [];
let tokenProposalLoading = false;
let tokenProposalLoadCounter = 0;

if (toggleDevConsoleBtn) {
  toggleDevConsoleBtn.disabled = true;
}

mountNotificationCenter(document.getElementById('notificationTray'), { role: 'platform' });

const versionTargets = document.querySelectorAll('[data-version]');
versionTargets.forEach((node) => {
  if (node) node.textContent = APP_VERSION || 'dev';
});
const navBadge = document.querySelector('nav .version-badge[data-version]');
if (navBadge) {
  navBadge.textContent = `Build ${APP_VERSION}`;
}

resetDepositContext();
resetDeactivateContext();
resetDeregisterContext();
resetTokenProposalState();
setBookingRegistryAddress(configuredRegistryAddress);

function setActionStatus(message, type = 'info', toast = false) {
  actionStatusEl.textContent = message ?? '';
  actionStatusEl.classList.remove('status-ok', 'status-error', 'status-warning');
  if (type === 'success') {
    actionStatusEl.classList.add('status-ok');
  } else if (type === 'error') {
    actionStatusEl.classList.add('status-error');
  } else if (type === 'warning') {
    actionStatusEl.classList.add('status-warning');
  }
  if (toast && message) {
    const variant = type === 'success' ? 'success' : type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info';
    notify({ message, variant, role: 'platform', timeout: type === 'error' ? 8000 : 5000 });
  }
}

function resetOwnerGuardMessage() {
  if (ownerGuardMessageEl) {
    ownerGuardMessageEl.textContent = ownerRequirementMessage;
  }
}

async function loadOwnerAddress() {
  if (ownerAddress) {
    return ownerAddress;
  }
  if (!ownerAddressPromise) {
    ownerAddressPromise = platformRead
      .owner()
      .then((address) => utils.getAddress(address))
      .then((normalized) => {
        ownerAddress = normalized;
        ownerRequirementMessage = OWNER_REQUIREMENT_MESSAGE;
        resetOwnerGuardMessage();
        return normalized;
      })
      .catch((error) => {
        ownerAddressPromise = null;
        console.error('Failed to load platform owner address', error);
        if (ownerGuardMessageEl) {
          ownerGuardMessageEl.textContent =
            'Unable to load platform owner address. Check RPC configuration and reload.';
        }
        throw error;
      });
  }
  return ownerAddressPromise;
}

function setOwnerControlsEnabled(enabled) {
  ownerAccessGranted = Boolean(enabled);
  ownerOnlyNodes.forEach((node) => {
    if (!node) return;
    if (ownerAccessGranted) {
      node.removeAttribute('hidden');
    } else {
      node.setAttribute('hidden', 'true');
    }
  });
  if (refreshSnapshotBtn) {
    refreshSnapshotBtn.disabled = !ownerAccessGranted;
  }
  if (!ownerAccessGranted) {
    snapshotOutputEl.textContent = 'Connect the platform owner wallet to view snapshot.';
    if (toggleDevConsoleBtn) {
      toggleDevConsoleBtn.disabled = true;
    }
  } else if (toggleDevConsoleBtn) {
    toggleDevConsoleBtn.disabled = false;
  }
  updateDepositControlsEnabled();
  updateDeactivateControlsEnabled();
  updateDeregisterControlsEnabled();
  updateTokenProposalControlsEnabled();
}

function updateDevConsoleStatus() {
  if (!devConsoleStatusEl || !toggleDevConsoleBtn) {
    return;
  }
  const manager = window.r3ntDevConsole;
  let enabled = false;
  if (manager) {
    try {
      if (typeof manager.isEnabled === 'function') {
        enabled = Boolean(manager.isEnabled());
      } else if (typeof manager.isActive === 'function') {
        enabled = Boolean(manager.isActive());
      }
    } catch (err) {
      console.error('Failed to determine dev console status', err);
    }
  }
  devConsoleStatusEl.textContent = enabled ? 'Dev console is enabled.' : 'Dev console is disabled.';
  toggleDevConsoleBtn.textContent = enabled ? 'Disable dev console' : 'Enable dev console';
}

function cleanErrorMessage(message) {
  if (typeof message !== 'string') return '';
  let result = message.trim();
  if (!result) return '';

  const prefixPatterns = [
    /^Error:\s*/i,
    /^ProviderError:\s*/i,
    /^CALL_EXCEPTION:\s*/i,
  ];

  for (const pattern of prefixPatterns) {
    result = result.replace(pattern, '').trim();
  }

  result = result.replace(/^(execution reverted:?)(\s)*/i, '').trim();
  result = result.replace(/^VM Exception while processing transaction:\s*/i, '').trim();
  result = result.replace(/^reverted with reason string\s*/i, '').trim();
  result = result.replace(/^Returned error:\s*/i, '').trim();

  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1).trim();
  }

  return result;
}

function interpretError(err) {
  const fallback = 'Unknown error';
  if (!err) {
    return { message: fallback, severity: 'error' };
  }

  if (typeof err === 'object') {
    const potentialSeverity = err?.severity;
    const potentialMessage = err?.message;
    if (typeof potentialSeverity === 'string' && typeof potentialMessage === 'string') {
      const cleaned = cleanErrorMessage(potentialMessage);
      const normalizedSeverity = potentialSeverity.toLowerCase();
      const allowedSeverities = ['error', 'warning', 'success', 'info'];
      const severityValue = allowedSeverities.includes(normalizedSeverity) ? normalizedSeverity : 'error';
      return { message: cleaned || potentialMessage || fallback, severity: severityValue };
    }
  }

  const messages = [];
  const seen = new Set();

  const pushMessage = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === '[object Object]') return;
    messages.push(trimmed);
  };

  const parseBody = (body) => {
    if (typeof body !== 'string') return;
    try {
      const parsed = JSON.parse(body);
      traverse(parsed);
    } catch (jsonErr) {
      // ignore malformed JSON bodies
    }
  };

  const traverse = (value) => {
    if (value == null) return;

    if (typeof value === 'string') {
      pushMessage(value);
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (typeof value.message === 'string') pushMessage(value.message);
    if (typeof value.reason === 'string') pushMessage(value.reason);
    if (typeof value.shortMessage === 'string') pushMessage(value.shortMessage);

    if (typeof value.error === 'string') pushMessage(value.error);
    if (typeof value.error === 'object') traverse(value.error);

    if (typeof value.data === 'string') pushMessage(value.data);
    if (typeof value.data === 'object') traverse(value.data);

    if (Array.isArray(value.errors)) {
      value.errors.forEach((item) => traverse(item));
    }

    if (typeof value.body === 'string') parseBody(value.body);
    if (typeof value.error?.body === 'string') parseBody(value.error.body);

    if (typeof value.cause === 'object' || typeof value.cause === 'string') {
      traverse(value.cause);
    }

    Object.keys(value).forEach((key) => {
      if (['message', 'reason', 'shortMessage', 'error', 'data', 'errors', 'body', 'cause'].includes(key)) {
        return;
      }
      const nested = value[key];
      if (typeof nested === 'string') {
        pushMessage(nested);
      } else if (typeof nested === 'object') {
        traverse(nested);
      }
    });
  };

  traverse(err);

  let rawMessage = messages.find(Boolean);
  if (!rawMessage) {
    if (typeof err === 'string') {
      rawMessage = err;
    } else {
      try {
        rawMessage = String(err);
      } catch (stringErr) {
        rawMessage = fallback;
      }
    }
  }

  if (!rawMessage) {
    rawMessage = fallback;
  }

  const cleaned = cleanErrorMessage(rawMessage);
  const baseMessage = cleaned || rawMessage || fallback;
  const normalized = baseMessage.toLowerCase();

  if (normalized.includes('circuit breaker')) {
    return {
      message: `Arbitrum network circuit breaker is active. Wait for the sequencer to recover before retrying. (${baseMessage})`,
      severity: 'warning',
    };
  }

  if (normalized.includes('sequencer is down') || normalized.includes('sequencer down')) {
    return {
      message: `Arbitrum sequencer is currently offline. Retry once it resumes processing transactions. (${baseMessage})`,
      severity: 'warning',
    };
  }

  return { message: baseMessage, severity: 'error' };
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

function formatUsdc(value) {
  const big = typeof value === 'bigint' ? value : BigInt(BigNumber.from(value || 0).toString());
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const units = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${units}${fraction ? `.${fraction}` : ''}`;
}

function formatSqmu(value) {
  try {
    const amount = BigNumber.from(value || 0);
    const text = amount.toString();
    if (text.length <= 3) {
      return text;
    }
    return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  } catch (err) {
    console.error('Failed to format SQMU value', err);
    return String(value ?? '');
  }
}

function formatBps(bps) {
  const num = Number(BigNumber.from(bps).toString());
  if (!Number.isFinite(num)) return `${bps} bps`;
  const pct = num / 100;
  const rounded = Math.round(pct * 100) / 100;
  const label = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${num} bps (${label}%)`;
}

function formatDuration(secondsValue) {
  const seconds = Number(BigNumber.from(secondsValue).toString());
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Disabled';
  const hours = seconds / 3600;
  if (Number.isInteger(hours)) {
    if (hours % 24 === 0) {
      const days = hours / 24;
      return `${days} day${days === 1 ? '' : 's'}`;
    }
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const hoursRounded = Math.round(hours * 10) / 10;
  return `${seconds} sec (~${hoursRounded} h)`;
}

function formatTimestamp(value) {
  try {
    const seconds = BigNumber.from(value || 0);
    if (seconds.isZero()) {
      return '-';
    }
    const millis = Number(seconds.toString()) * 1000;
    if (!Number.isFinite(millis)) {
      return seconds.toString();
    }
    const date = new Date(millis);
    if (Number.isNaN(date.getTime())) {
      return seconds.toString();
    }
    return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  } catch (err) {
    console.error('Failed to format timestamp', err);
    return String(value ?? '');
  }
}

function shortAddress(value) {
  if (typeof value !== 'string') return '';
  if (!value.startsWith('0x') || value.length < 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function createTokenDetail(label, value, options = {}) {
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

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (value == null) return false;
  if (BigNumber.isBigNumber(value)) return !value.isZero();
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '' && value !== '0';
  try {
    return Boolean(value);
  } catch (err) {
    console.error('Failed to normalise boolean value', err);
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function setStatusNode(node, message, severity = 'info') {
  if (!node) return;
  node.textContent = message || '';
  node.classList.remove('status-ok', 'status-error', 'status-warning', 'status-info');
  if (!message) {
    return;
  }
  if (severity === 'success') {
    node.classList.add('status-ok');
  } else if (severity === 'error') {
    node.classList.add('status-error');
  } else if (severity === 'warning') {
    node.classList.add('status-warning');
  } else {
    node.classList.add('status-info');
  }
}

function setDeactivateListingStatus(message, severity = 'info') {
  setStatusNode(deactivateListingStatusEl, message, severity);
}

function setDeregisterListingStatus(message, severity = 'info') {
  setStatusNode(deregisterListingStatusEl, message, severity);
}

function setDepositStatus(message, severity = 'info') {
  if (!depositStatusEl) return;
  depositStatusEl.textContent = message || '';
  depositStatusEl.classList.remove('status-ok', 'status-error', 'status-warning');
  if (!message) {
    return;
  }
  if (severity === 'success') {
    depositStatusEl.classList.add('status-ok');
  } else if (severity === 'error') {
    depositStatusEl.classList.add('status-error');
  } else if (severity === 'warning') {
    depositStatusEl.classList.add('status-warning');
  }
}

function renderDepositInfo(context) {
  if (!depositInfoEl) {
    return;
  }
  if (!context) {
    depositInfoEl.textContent = DEPOSIT_DEFAULT_MESSAGE;
    return;
  }

  const { listingAddress, bookingId, booking, pending } = context;
  const statusIndex = Number(BigNumber.from(booking.status || 0).toString());
  const statusLabel = STATUS_LABELS[statusIndex] || `Unknown (${statusIndex})`;
  const start = BigNumber.from(booking.start || 0);
  const end = BigNumber.from(booking.end || 0);
  const staySeconds = end.gt(start) ? end.sub(start) : BigNumber.from(0);
  const depositReleased = toBool(booking.depositReleased);
  const pendingExists = toBool(pending?.exists);
  const tenantShareLabel = depositReleased ? ` · Tenant share: ${formatBps(booking.depositTenantBps || 0)}` : '';
  const pendingLine = pendingExists
    ? `Pending proposal: tenant ${formatBps(pending.tenantBps || 0)} · proposer ${
        pending.proposer || constants.AddressZero
      }`
    : 'Pending proposal: none';

  const lines = [
    `Listing address: ${listingAddress}`,
    `Booking ID: ${bookingId.toString()}`,
    `Status: ${statusLabel}`,
    `Tenant: ${booking.tenant}`,
    `Range: ${formatTimestamp(booking.start)} → ${formatTimestamp(booking.end)} (${formatDuration(staySeconds)})`,
    `Deposit held: ${formatUsdc(booking.deposit)} USDC`,
    `Rent (gross/net): ${formatUsdc(booking.grossRent)} / ${formatUsdc(booking.expectedNetRent)} USDC`,
    `Rent paid so far: ${formatUsdc(booking.rentPaid)} USDC`,
    `Deposit released: ${depositReleased ? 'Yes' : 'No'}${tenantShareLabel}`,
    pendingLine,
  ];

  depositInfoEl.innerHTML = lines.map(escapeHtml).join('<br>');
}

function updateDepositControlsEnabled() {
  if (!confirmDepositBtn) {
    return;
  }
  const hasPending = currentDepositContext ? toBool(currentDepositContext.pending?.exists) : false;
  const alreadyReleased = currentDepositContext ? toBool(currentDepositContext.booking?.depositReleased) : false;
  const walletReady = ownerAccessGranted && Boolean(platformWrite) && Boolean(signer);
  confirmDepositBtn.disabled = !(walletReady && hasPending && !alreadyReleased);
}

function resetDepositContext() {
  currentDepositContext = null;
  renderDepositInfo(null);
  setDepositStatus(DEPOSIT_DEFAULT_STATUS, 'info');
  updateDepositControlsEnabled();
}

function updateDeactivateControlsEnabled() {
  if (!deactivateListingSubmitBtn) {
    return;
  }
  const walletReady = ownerAccessGranted && Boolean(platformWrite) && Boolean(signer);
  const context = deactivateListingContext;
  const ready = walletReady && context && context.exists && context.active && !context.loading;
  deactivateListingSubmitBtn.disabled = !ready;
}

function resetDeactivateContext() {
  deactivateListingContext = {
    listingId: null,
    listingAddress: null,
    exists: false,
    loading: false,
    active: false,
  };
  deactivateLookupCounter = 0;
  if (deactivateLookupTimeout) {
    clearTimeout(deactivateLookupTimeout);
    deactivateLookupTimeout = null;
  }
  setDeactivateListingStatus(DEACTIVATE_DEFAULT_STATUS, 'info');
  updateDeactivateControlsEnabled();
}

function updateDeregisterControlsEnabled() {
  if (!deregisterSubmitBtn) {
    return;
  }
  const walletReady = ownerAccessGranted && Boolean(platformWrite) && Boolean(signer);
  const registryReady = walletReady && Boolean(bookingRegistryWrite) && Boolean(bookingRegistryAddress);
  const context = deregisterContext;
  const addressReady = Boolean(context && context.address);
  const loading = Boolean(context && context.loading);
  deregisterSubmitBtn.disabled = !(registryReady && addressReady && !loading);
}

function resetDeregisterContext({ clearInputs = false } = {}) {
  deregisterContext = { listingId: null, address: null, resolvedFromId: false, loading: false };
  deregisterLookupCounter = 0;
  if (clearInputs) {
    if (deregisterListingIdInput) deregisterListingIdInput.value = '';
    if (deregisterListingAddressInput) deregisterListingAddressInput.value = '';
  }
  if (!bookingRegistryAddress) {
    setDeregisterListingStatus(DEREGISTER_REGISTRY_WARNING, 'warning');
  } else {
    setDeregisterListingStatus(DEREGISTER_DEFAULT_STATUS, 'info');
  }
  updateDeregisterControlsEnabled();
}

function setTokenProposalStatus(message, type = 'info', toast = false) {
  if (!tokenProposalStatusEl) {
    return;
  }
  tokenProposalStatusEl.textContent = message ?? '';
  tokenProposalStatusEl.classList.remove('status-ok', 'status-error', 'status-warning', 'status-info');
  if (type === 'success') {
    tokenProposalStatusEl.classList.add('status-ok');
  } else if (type === 'error') {
    tokenProposalStatusEl.classList.add('status-error');
  } else if (type === 'warning') {
    tokenProposalStatusEl.classList.add('status-warning');
  } else {
    tokenProposalStatusEl.classList.add('status-info');
  }
  if (toast && message) {
    const variant = type === 'success' ? 'success' : type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info';
    notify({ message, variant, role: 'platform', timeout: type === 'error' ? 8000 : 5000 });
  }
}

function resetTokenProposalState() {
  tokenProposalRecords = [];
  if (tokenProposalListEl) {
    tokenProposalListEl.innerHTML = '';
  }
  setTokenProposalStatus('Connect the owner wallet to load tokenisation proposals.', 'info');
  updateTokenProposalControlsEnabled();
}

function updateTokenProposalControlsEnabled() {
  if (!tokenRefreshBtn) {
    return;
  }
  const walletReady = ownerAccessGranted && Boolean(platformWrite) && Boolean(signer);
  tokenRefreshBtn.disabled = !(walletReady && !tokenProposalLoading);
}

function renderTokenProposalList(records) {
  if (!tokenProposalListEl) {
    return;
  }
  tokenProposalListEl.innerHTML = '';
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) {
    return;
  }
  for (const record of list) {
    tokenProposalListEl.appendChild(createTokenProposalCard(record));
  }
}

function createTokenProposalCard(record) {
  const card = document.createElement('div');
  card.className = 'token-proposal-card';

  const title = document.createElement('h3');
  title.textContent = `Listing #${record.listingIdText} · Booking #${record.bookingIdText}`;
  card.appendChild(title);

  const context = document.createElement('div');
  context.className = 'token-proposal-context';
  const landlordLine = document.createElement('strong');
  landlordLine.textContent = `Landlord ${record.landlordShort || record.landlord}`;
  if (record.landlord) {
    landlordLine.title = record.landlord;
  }
  context.appendChild(landlordLine);
  const statusMeta = document.createElement('div');
  statusMeta.className = 'token-proposal-meta';
  const statusClass = record.statusClass ? ` booking-status-${record.statusClass}` : '';
  statusMeta.innerHTML = `Status: <span class="booking-status-badge${statusClass}">${record.statusLabel}</span>`;
  context.appendChild(statusMeta);
  const stayMeta = document.createElement('div');
  stayMeta.className = 'token-proposal-meta';
  stayMeta.textContent = `Stay: ${record.startLabel} → ${record.endLabel} (${record.durationLabel})`;
  context.appendChild(stayMeta);
  card.appendChild(context);

  const details = document.createElement('div');
  details.className = 'booking-details';
  details.appendChild(createTokenDetail('Total SQMU', formatSqmu(record.pending.totalSqmu)));
  details.appendChild(createTokenDetail('Price per SQMU', `${formatUsdc(record.pending.pricePerSqmu)} USDC`));
  details.appendChild(createTokenDetail('Platform fee', formatBps(record.pending.feeBps)));
  details.appendChild(createTokenDetail('Cadence', record.pending.periodLabel));
  const proposerText = record.pending.proposerShort || record.pending.proposer || '—';
  details.appendChild(createTokenDetail('Proposer', proposerText, { tooltip: record.pending.proposer || undefined }));
  details.appendChild(createTokenDetail('Gross rent', `${formatUsdc(record.grossRent)} USDC`));
  details.appendChild(createTokenDetail('Net rent', `${formatUsdc(record.expectedNetRent)} USDC`));
  card.appendChild(details);

  const actions = document.createElement('div');
  actions.className = 'token-proposal-actions';
  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.textContent = 'Approve tokenisation';
  const rejectBtn = document.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'secondary';
  rejectBtn.textContent = 'Reject proposal';
  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  card.appendChild(actions);

  const statusLine = document.createElement('div');
  statusLine.className = 'token-proposal-status';
  statusLine.textContent = 'Awaiting platform approval.';
  card.appendChild(statusLine);

  approveBtn.addEventListener('click', () => {
    handleTokenProposalAction(record, 'approve', { approveBtn, rejectBtn, statusLine }).catch((err) => {
      console.error('Failed to approve tokenisation proposal', err);
    });
  });
  rejectBtn.addEventListener('click', () => {
    handleTokenProposalAction(record, 'reject', { approveBtn, rejectBtn, statusLine }).catch((err) => {
      console.error('Failed to reject tokenisation proposal', err);
    });
  });

  return card;
}

async function handleTokenProposalAction(record, action, controls = {}) {
  if (!ownerAccessGranted || !platformWrite || !signer) {
    setTokenProposalStatus('Connect the platform owner wallet before managing tokenisation proposals.', 'error', true);
    return;
  }
  const { approveBtn, rejectBtn, statusLine } = controls;
  if (approveBtn) approveBtn.disabled = true;
  if (rejectBtn) rejectBtn.disabled = true;
  if (tokenRefreshBtn) tokenRefreshBtn.disabled = true;
  if (statusLine) {
    statusLine.textContent = action === 'approve' ? 'Submitting approval…' : 'Rejecting proposal…';
  }
  try {
    const listingId = record?.listingId;
    const bookingId = record?.bookingId;
    if (!listingId || !bookingId) {
      throw new Error('Missing listing or booking id for tokenisation action.');
    }
    const tx =
      action === 'approve'
        ? await platformWrite.approveTokenisation(listingId, bookingId)
        : await platformWrite.rejectTokenisation(listingId, bookingId);
    setTokenProposalStatus('Waiting for platform confirmation…', 'info');
    await tx.wait();
    const actionText = action === 'approve' ? 'approved' : 'rejected';
    const message = `Tokenisation ${actionText} for listing #${record.listingIdText} booking #${record.bookingIdText}.`;
    setTokenProposalStatus(message, 'success', true);
    if (statusLine) {
      statusLine.textContent = `Proposal ${actionText}.`;
    }
    await loadTokenisationProposals({ quiet: true });
  } catch (err) {
    const { message, severity } = interpretError(err);
    const label = action === 'approve' ? 'approval' : 'rejection';
    setTokenProposalStatus(`Tokenisation ${label} failed: ${message}`, severity, true);
    if (statusLine) {
      statusLine.textContent = `Proposal ${label} failed.`;
    }
  } finally {
    if (approveBtn) approveBtn.disabled = false;
    if (rejectBtn) rejectBtn.disabled = false;
    updateTokenProposalControlsEnabled();
  }
}

function normalizeTokenProposalRecord({ listingAddress, listingId, landlord, bookingId, bookingRaw, pendingData }) {
  try {
    const listingIdBn = BigNumber.from(listingId || 0);
    const bookingIdBn = BigNumber.from(bookingId || 0);
    const statusIndex = Number(bookingRaw.status || 0);
    const statusLabel = STATUS_LABELS[statusIndex] || `Unknown (${statusIndex})`;
    const statusClass = BOOKING_STATUS_CLASS_MAP[statusIndex] || '';
    const start = BigNumber.from(bookingRaw.start || 0);
    const end = BigNumber.from(bookingRaw.end || 0);
    const duration = end.gt(start) ? end.sub(start) : BigNumber.from(0);
    const pendingTotal = BigNumber.from(pendingData.totalSqmu || 0);
    const pendingPrice = BigNumber.from(pendingData.pricePerSqmu || 0);
    const pendingFee = BigNumber.from(pendingData.feeBps || 0);
    const pendingPeriod = Number(pendingData.period || 0);
    let proposer = pendingData.proposer || constants.AddressZero;
    try {
      proposer = utils.getAddress(proposer);
    } catch (err) {
      console.warn('Unable to normalise token proposer address', proposer, err);
    }
    return {
      listingAddress,
      listingId: listingIdBn,
      listingIdText: listingIdBn.toString(),
      landlord,
      landlordShort: shortAddress(landlord),
      bookingId: bookingIdBn,
      bookingIdText: bookingIdBn.toString(),
      statusIndex,
      statusLabel,
      statusClass,
      start,
      end,
      startLabel: formatTimestamp(start),
      endLabel: formatTimestamp(end),
      durationLabel: formatDuration(duration),
      grossRent: BigNumber.from(bookingRaw.grossRent || bookingRaw.rent || 0),
      expectedNetRent: BigNumber.from(bookingRaw.expectedNetRent || 0),
      pending: {
        totalSqmu: pendingTotal,
        pricePerSqmu: pendingPrice,
        feeBps: pendingFee,
        period: pendingPeriod,
        periodLabel: TOKEN_PERIOD_LABELS[pendingPeriod] || `Custom (${pendingPeriod})`,
        proposer,
        proposerShort: shortAddress(proposer),
      },
    };
  } catch (err) {
    console.error('Failed to normalise token proposal record', err);
    return null;
  }
}

async function loadTokenisationProposals({ quiet = false } = {}) {
  if (!tokenProposalListEl) {
    return;
  }
  if (!ownerAccessGranted) {
    resetTokenProposalState();
    return;
  }
  const requestId = ++tokenProposalLoadCounter;
  tokenProposalLoading = true;
  updateTokenProposalControlsEnabled();
  if (!quiet) {
    setTokenProposalStatus('Loading tokenisation proposals…', 'info');
  }
  try {
    const listingsRaw = await platformRead.allListings();
    const addresses = Array.isArray(listingsRaw)
      ? listingsRaw.filter((addr) => typeof addr === 'string' && addr !== constants.AddressZero)
      : [];
    const proposals = [];
    for (const rawAddress of addresses) {
      let listingAddress;
      try {
        listingAddress = utils.getAddress(rawAddress);
      } catch (err) {
        console.warn('Skipping invalid listing address', rawAddress, err);
        continue;
      }
      let listingId;
      try {
        listingId = await platformRead.listingIds(listingAddress);
        if (!listingId || BigNumber.from(listingId).isZero()) {
          continue;
        }
      } catch (err) {
        console.warn('Unable to resolve listing id for address', listingAddress, err);
        continue;
      }

      const listingContract = new Contract(listingAddress, LISTING_ABI, readProvider);
      let landlordAddress = constants.AddressZero;
      try {
        landlordAddress = await listingContract.landlord();
      } catch (err) {
        console.warn('Unable to load landlord for listing', listingAddress, err);
      }

      let nextBookingId = BigNumber.from(0);
      try {
        nextBookingId = await listingContract.nextBookingId();
      } catch (err) {
        console.warn('Unable to load booking count for listing', listingAddress, err);
      }
      const maxBooking = BigInt(nextBookingId.toString());
      if (maxBooking < 1n) {
        continue;
      }
      for (let bookingIndex = 1n; bookingIndex <= maxBooking; bookingIndex += 1n) {
        const bookingId = BigNumber.from(bookingIndex.toString());
        let pendingRaw;
        try {
          pendingRaw = await listingContract.pendingTokenisation(bookingId);
        } catch (err) {
          console.warn('Unable to load pending tokenisation', listingAddress, bookingIndex.toString(), err);
          continue;
        }
        const pendingData = pendingRaw?.viewData ?? pendingRaw ?? {};
        if (!toBool(pendingData.exists)) {
          continue;
        }

        let bookingRaw;
        try {
          bookingRaw = await listingContract.bookingInfo(bookingId);
        } catch (err) {
          console.warn('Unable to load booking info for token proposal', listingAddress, bookingIndex.toString(), err);
          continue;
        }

        const record = normalizeTokenProposalRecord({
          listingAddress,
          listingId,
          landlord: landlordAddress,
          bookingId,
          bookingRaw,
          pendingData,
        });
        if (record) {
          proposals.push(record);
        }
      }
    }

    if (requestId !== tokenProposalLoadCounter) {
      return;
    }

    tokenProposalRecords = proposals;
    renderTokenProposalList(proposals);
    if (proposals.length === 0) {
      setTokenProposalStatus('No pending tokenisation proposals.', 'info');
    } else {
      const summary = `Loaded ${proposals.length} tokenisation proposal${proposals.length === 1 ? '' : 's'}.`;
      setTokenProposalStatus(summary, quiet ? 'info' : 'success', !quiet);
    }
  } catch (err) {
    if (requestId !== tokenProposalLoadCounter) {
      return;
    }
    console.error('Failed to load tokenisation proposals', err);
    const { message, severity } = interpretError(err);
    setTokenProposalStatus(`Failed to load tokenisation proposals: ${message}`, severity, true);
  } finally {
    if (requestId === tokenProposalLoadCounter) {
      tokenProposalLoading = false;
      updateTokenProposalControlsEnabled();
    }
  }
}

function updateBookingRegistryContract() {
  if (!bookingRegistryAddress) {
    bookingRegistryRead = null;
    bookingRegistryWrite = null;
    updateDeregisterControlsEnabled();
    return;
  }

  try {
    bookingRegistryRead = new Contract(bookingRegistryAddress, REGISTRY_ABI, readProvider);
  } catch (err) {
    console.error('Failed to create BookingRegistry read contract instance', err);
    bookingRegistryRead = null;
  }

  if (!signer) {
    bookingRegistryWrite = null;
    updateDeregisterControlsEnabled();
    return;
  }

  try {
    bookingRegistryWrite = new Contract(bookingRegistryAddress, REGISTRY_ABI, signer);
  } catch (err) {
    console.error('Failed to create BookingRegistry contract instance', err);
    bookingRegistryWrite = null;
  }

  updateDeregisterControlsEnabled();
}

function setBookingRegistryAddress(nextAddress) {
  let normalized = null;
  if (nextAddress) {
    try {
      const formatted = utils.getAddress(nextAddress);
      if (formatted !== constants.AddressZero) {
        normalized = formatted;
      }
    } catch (err) {
      console.warn('Ignoring invalid BookingRegistry address', nextAddress, err);
    }
  }
  bookingRegistryAddress = normalized;
  updateBookingRegistryContract();
  if (!bookingRegistryAddress) {
    setDeregisterListingStatus(DEREGISTER_REGISTRY_WARNING, 'warning');
  } else if (!deregisterContext.address) {
    setDeregisterListingStatus(DEREGISTER_DEFAULT_STATUS, 'info');
  }
  updateDeregisterControlsEnabled();
}

function scheduleDeactivateListingCheck() {
  if (deactivateLookupTimeout) {
    clearTimeout(deactivateLookupTimeout);
  }
  deactivateLookupTimeout = setTimeout(() => {
    deactivateLookupTimeout = null;
    evaluateDeactivateListingId();
  }, 400);
}

async function evaluateDeactivateListingId() {
  if (!deactivateListingIdInput) {
    return;
  }
  if (deactivateLookupTimeout) {
    clearTimeout(deactivateLookupTimeout);
    deactivateLookupTimeout = null;
  }
  const rawValue = deactivateListingIdInput.value;
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) {
    deactivateListingContext = {
      listingId: null,
      listingAddress: null,
      exists: false,
      loading: false,
      active: false,
    };
    setDeactivateListingStatus(DEACTIVATE_DEFAULT_STATUS, 'info');
    updateDeactivateControlsEnabled();
    return;
  }
  let listingId;
  try {
    listingId = parseListingId(trimmed);
  } catch (err) {
    deactivateListingContext = {
      listingId: null,
      listingAddress: null,
      exists: false,
      loading: false,
      active: false,
    };
    setDeactivateListingStatus(err.message, 'warning');
    updateDeactivateControlsEnabled();
    return;
  }

  const requestId = ++deactivateLookupCounter;
  deactivateListingContext = {
    listingId,
    listingAddress: null,
    exists: false,
    loading: true,
    active: false,
  };
  setDeactivateListingStatus('Checking listing…');
  updateDeactivateControlsEnabled();

  try {
    const listingAddressRaw = await platformRead.listingById(listingId);
    if (requestId !== deactivateLookupCounter) {
      return;
    }
    if (!listingAddressRaw || listingAddressRaw === constants.AddressZero) {
      deactivateListingContext = {
        listingId,
        listingAddress: null,
        exists: false,
        loading: false,
        active: false,
      };
      setDeactivateListingStatus('Listing not found for that ID.', 'error');
    } else {
      const listingAddress = utils.getAddress(listingAddressRaw);
      let isActive = false;
      try {
        const activeRaw = await platformRead.listingActive(listingId);
        isActive = toBool(activeRaw);
      } catch (err) {
        console.error('Failed to load listing active status before deactivation', err);
        const { message, severity } = interpretError(err);
        deactivateListingContext = {
          listingId,
          listingAddress,
          exists: true,
          loading: false,
          active: false,
        };
        setDeactivateListingStatus(`Failed to load listing status: ${message}`, severity);
        updateDeactivateControlsEnabled();
        return;
      }
      deactivateListingContext = {
        listingId,
        listingAddress,
        exists: true,
        loading: false,
        active: isActive,
      };
      if (isActive) {
        setDeactivateListingStatus(`Listing at ${listingAddress} is active.`, 'success');
      } else {
        setDeactivateListingStatus(`Listing at ${listingAddress} is already inactive.`, 'warning');
      }
    }
  } catch (err) {
    if (requestId !== deactivateLookupCounter) {
      return;
    }
    console.error('Failed to check listing before deactivation', err);
    const { message, severity } = interpretError(err);
    deactivateListingContext = {
      listingId,
      listingAddress: null,
      exists: false,
      loading: false,
      active: false,
    };
    setDeactivateListingStatus(`Failed to load listing: ${message}`, severity);
  } finally {
    if (requestId === deactivateLookupCounter) {
      updateDeactivateControlsEnabled();
    }
  }
}

function evaluateDeregisterAddressInput({ silent = false } = {}) {
  if (!deregisterListingAddressInput) {
    return;
  }
  const rawValue = deregisterListingAddressInput.value;
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) {
    deregisterContext.address = null;
    deregisterContext.resolvedFromId = false;
    if (!silent) {
      if (!bookingRegistryAddress) {
        setDeregisterListingStatus(DEREGISTER_REGISTRY_WARNING, 'warning');
      } else {
        setDeregisterListingStatus(DEREGISTER_DEFAULT_STATUS, 'info');
      }
    }
    updateDeregisterControlsEnabled();
    return;
  }

  try {
    const normalized = normalizeAddress(trimmed, 'Listing address');
    deregisterContext.address = normalized;
    deregisterContext.resolvedFromId = false;
    if (!silent) {
      setDeregisterListingStatus(`Listing address ready: ${normalized}.`, 'success');
    }
  } catch (err) {
    deregisterContext.address = null;
    deregisterContext.resolvedFromId = false;
    if (!silent) {
      setDeregisterListingStatus(err.message, 'error');
    }
  }
  updateDeregisterControlsEnabled();
}

async function lookupDeregisterListingById() {
  if (!deregisterListingIdInput) {
    return;
  }
  const rawValue = deregisterListingIdInput.value;
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) {
    setDeregisterListingStatus('Enter a listing ID to lookup its address.', 'warning');
    return;
  }
  let listingId;
  try {
    listingId = parseListingId(trimmed);
  } catch (err) {
    setDeregisterListingStatus(err.message, 'error');
    return;
  }

  const requestId = ++deregisterLookupCounter;
  deregisterContext.listingId = listingId;
  deregisterContext.loading = true;
  setDeregisterListingStatus('Looking up listing address…');
  updateDeregisterControlsEnabled();

  try {
    const listingAddressRaw = await platformRead.listingById(listingId);
    if (requestId !== deregisterLookupCounter) {
      return;
    }
    if (!listingAddressRaw || listingAddressRaw === constants.AddressZero) {
      deregisterContext.address = null;
      deregisterContext.resolvedFromId = false;
      setDeregisterListingStatus('Listing not found for that ID.', 'error');
      if (deregisterListingAddressInput) {
        deregisterListingAddressInput.value = '';
      }
    } else {
      const listingAddress = utils.getAddress(listingAddressRaw);
      deregisterContext.address = listingAddress;
      deregisterContext.resolvedFromId = true;
      setDeregisterListingStatus(`Listing resolved to ${listingAddress}.`, 'success');
      if (deregisterListingAddressInput) {
        deregisterListingAddressInput.value = listingAddress;
      }
    }
  } catch (err) {
    if (requestId !== deregisterLookupCounter) {
      return;
    }
    console.error('Failed to lookup listing address', err);
    const { message, severity } = interpretError(err);
    setDeregisterListingStatus(`Failed to lookup listing: ${message}`, severity);
  } finally {
    if (requestId === deregisterLookupCounter) {
      deregisterContext.loading = false;
      updateDeregisterControlsEnabled();
    }
  }
}

async function loadDepositDetails(options = {}) {
  if (!depositListingIdInput || !depositBookingIdInput) {
    return false;
  }

  const { quiet = false } = options;

  try {
    const listingId = parseListingId(depositListingIdInput.value);
    const bookingId = parseBookingId(depositBookingIdInput.value);
    const listingAddressRaw = await platformRead.listingById(listingId);
    if (!listingAddressRaw || listingAddressRaw === constants.AddressZero) {
      throw new Error('Listing not found for that ID.');
    }
    const listingAddress = utils.getAddress(listingAddressRaw);
    const listingContract = new Contract(listingAddress, LISTING_ABI, readProvider);
    const [bookingRaw, pendingRaw] = await Promise.all([
      listingContract.bookingInfo(bookingId),
      listingContract.pendingDepositSplit(bookingId),
    ]);

    const pendingData = pendingRaw?.viewData ?? pendingRaw ?? {};
    let proposer = constants.AddressZero;
    if (pendingData.proposer) {
      try {
        proposer = utils.getAddress(pendingData.proposer);
      } catch (err) {
        console.warn('Unable to normalise deposit proposer address', err);
        proposer = pendingData.proposer;
      }
    }

    const normalizedBooking = {
      tenant: bookingRaw.tenant,
      start: bookingRaw.start,
      end: bookingRaw.end,
      grossRent: bookingRaw.grossRent,
      expectedNetRent: bookingRaw.expectedNetRent,
      rentPaid: bookingRaw.rentPaid,
      deposit: bookingRaw.deposit,
      status: bookingRaw.status,
      depositReleased: toBool(bookingRaw.depositReleased),
      depositTenantBps: BigNumber.from(bookingRaw.depositTenantBps || 0),
    };

    const normalizedPending = {
      exists: toBool(pendingData.exists),
      tenantBps:
        pendingData.tenantBps !== undefined ? BigNumber.from(pendingData.tenantBps) : BigNumber.from(0),
      proposer,
    };

    currentDepositContext = {
      listingId,
      bookingId,
      listingAddress,
      booking: normalizedBooking,
      pending: normalizedPending,
    };

    renderDepositInfo(currentDepositContext);
    updateDepositControlsEnabled();

    if (!quiet) {
      const hasPending = toBool(normalizedPending.exists);
      const alreadyReleased = toBool(normalizedBooking.depositReleased);
      if (hasPending) {
        setDepositStatus('Pending deposit split found. Review details before confirming.', 'success');
      } else if (alreadyReleased) {
        setDepositStatus('Deposit already released for this booking.', 'warning');
      } else {
        setDepositStatus('No pending deposit split for this booking.', 'warning');
      }
    }

    return true;
  } catch (err) {
    console.error('Failed to load deposit details', err);
    currentDepositContext = null;
    renderDepositInfo(null);
    updateDepositControlsEnabled();
    if (isUnknownBookingError(err)) {
      setDepositStatus('Booking not found for that listing. Double-check the IDs and try again.', 'warning');
    } else {
      const { message, severity } = interpretError(err);
      setDepositStatus(`Failed to load deposit details: ${message}`, severity);
    }
    return false;
  }
}

async function cancelBookingAfterDepositRelease(contextSnapshot) {
  if (!contextSnapshot) {
    setDepositStatus('Deposit release confirmed, but booking context unavailable for cancellation.', 'warning');
    return;
  }

  const { listingAddress, bookingId } = contextSnapshot;
  if (!listingAddress || bookingId === undefined || bookingId === null) {
    setDepositStatus('Deposit release confirmed, but booking reference missing. Cancel manually if needed.', 'warning');
    return;
  }

  if (!Array.isArray(LISTING_ABI) || LISTING_ABI.length === 0) {
    setDepositStatus('Deposit released, but listing ABI unavailable to cancel automatically.', 'warning');
    return;
  }

  if (!signer) {
    setDepositStatus('Deposit released, but wallet disconnected before cancellation could be submitted.', 'error');
    return;
  }

  let listingContract;
  try {
    listingContract = new Contract(listingAddress, LISTING_ABI, signer);
  } catch (err) {
    console.error('Failed to create listing contract instance for cancellation', err);
    const { message, severity } = interpretError(err);
    setDepositStatus(`Deposit released, but cancellation contract initialisation failed: ${message}`, severity);
    return;
  }

  try {
    const cancelled = await withSigner(
      'Cancelling booking after deposit release',
      () => listingContract.cancelBooking(bookingId),
      confirmDepositBtn,
    );

    if (cancelled) {
      await loadDepositDetails({ quiet: true });
      setDepositStatus('Deposit released and booking cancelled.', 'success');
    } else {
      setDepositStatus('Deposit released. Booking cancellation not executed.', 'warning');
    }
  } catch (err) {
    console.error('Failed to cancel booking after deposit release', err);
    const { message, severity } = interpretError(err);
    setDepositStatus(`Deposit released, but booking cancellation failed: ${message}`, severity);
  }
}

function enableForms(enabled) {
  document.querySelectorAll('form[data-requires-signer]').forEach((form) => {
    Array.from(form.elements).forEach((control) => {
      control.disabled = !enabled;
    });
  });
  updateDepositControlsEnabled();
  updateDeactivateControlsEnabled();
  updateDeregisterControlsEnabled();
}

enableForms(false);

async function loadListingImplementationAddress(factoryAddress) {
  if (!factoryAddress || factoryAddress === constants.AddressZero) {
    return 'Not configured (factory unset)';
  }

  if (!Array.isArray(FACTORY_ABI) || FACTORY_ABI.length === 0) {
    console.warn('ListingFactory ABI unavailable. Cannot read implementation address.');
    return 'ABI unavailable';
  }

  let normalizedFactory;
  try {
    normalizedFactory = utils.getAddress(factoryAddress);
  } catch (err) {
    console.warn('Unable to normalise ListingFactory address', factoryAddress, err);
    return 'Invalid factory address';
  }

  let factoryContract;
  try {
    factoryContract = new Contract(normalizedFactory, FACTORY_ABI, readProvider);
  } catch (err) {
    console.error('Failed to create ListingFactory contract instance', err);
    const { message } = interpretError(err);
    return `Lookup failed (${message})`;
  }

  try {
    const implementationRaw = await factoryContract.listingImplementation();
    if (!implementationRaw || implementationRaw === constants.AddressZero) {
      return 'Not set';
    }
    try {
      return utils.getAddress(implementationRaw);
    } catch (normaliseError) {
      console.warn('Unable to normalise listing implementation address', implementationRaw, normaliseError);
      return implementationRaw;
    }
  } catch (error) {
    console.error('Failed to load listing implementation from factory', error);
    const { message } = interpretError(error);
    return `Lookup failed (${message})`;
  }
}

async function refreshSnapshot() {
  if (!ownerAccessGranted) {
    snapshotOutputEl.textContent = 'Connect the platform owner wallet to view snapshot.';
    setActionStatus('Owner access required to load snapshot.', 'warning');
    return;
  }
  try {
    snapshotOutputEl.textContent = 'Loading current state…';
    setActionStatus('Refreshing snapshot…');
    const [
      owner,
      usdc,
      treasury,
      listingCreationFee,
      viewPassPrice,
      viewPassDuration,
      listingCount,
      agentImplementation,
      maxAgentFeeBps,
      modules,
      fees
    ] = await Promise.all([
      platformRead.owner(),
      platformRead.usdc(),
      platformRead.treasury(),
      platformRead.listingCreationFee(),
      platformRead.viewPassPrice(),
      platformRead.viewPassDuration(),
      platformRead.listingCount(),
      platformRead.agentImplementation(),
      platformRead.maxAgentFeeBps(),
      platformRead.modules(),
      platformRead.fees(),
    ]);

    const [listingFactory, bookingRegistry, sqmuToken] = modules;
    const [tenantFeeBps, landlordFeeBps] = fees;

    setBookingRegistryAddress(bookingRegistry);

    const listingImplementationAddress = await loadListingImplementationAddress(listingFactory);

    const lines = [
      `Owner:           ${owner}`,
      `Treasury:        ${treasury}`,
      `USDC:            ${usdc}`,
      '',
      'Modules:',
      `  • ListingFactory : ${listingFactory}`,
      `      ↳ Implementation: ${listingImplementationAddress}`,
      `  • BookingRegistry: ${bookingRegistry}`,
      `  • r3nt-SQMU token: ${sqmuToken}`,
      '',
      'Fees:',
      `  • Tenant   : ${formatBps(tenantFeeBps)}`,
      `  • Landlord : ${formatBps(landlordFeeBps)}`,
      '',
      `Listing creation fee: ${formatUsdc(listingCreationFee)} USDC`,
      `View pass price     : ${formatUsdc(viewPassPrice)} USDC`,
      `View pass duration  : ${formatDuration(viewPassDuration)}`,
      '',
      `Listings created    : ${BigNumber.from(listingCount).toString()}`,
      `Agent implementation: ${agentImplementation === constants.AddressZero ? 'Not set' : agentImplementation}`,
      `Max agent fee       : ${formatBps(maxAgentFeeBps)}`,
    ];

    snapshotOutputEl.textContent = lines.join('\n');
    setActionStatus('Snapshot refreshed.', 'success', true);
  } catch (error) {
    console.error('Failed to refresh snapshot', error);
    const { message } = interpretError(error);
    snapshotOutputEl.textContent = `Failed to load snapshot: ${message}`;
    setActionStatus(`Failed to load snapshot: ${message}`, 'error', true);
  }
}

async function withSigner(label, action, button) {
  if (!platformWrite || !signer) {
    setActionStatus('Connect your wallet before sending transactions.', 'error');
    return false;
  }
  if (button) button.disabled = true;
  let success = false;
  try {
    setActionStatus(`${label}…`);
    const tx = await action();
    setActionStatus(`${label} submitted. Waiting for confirmation (tx: ${tx.hash}).`);
    await tx.wait();
    setActionStatus(`${label} confirmed.`, 'success', true);
    await refreshSnapshot();
    success = true;
  } catch (err) {
    console.error(err);
    const { message, severity } = interpretError(err);
    setActionStatus(`${label} failed: ${message}`, severity, true);
  } finally {
    if (button) button.disabled = false;
  }
  return success;
}

function normalizeAddress(value, label, { optional = false } = {}) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    if (optional) return constants.AddressZero;
    throw new Error(`${label} is required.`);
  }
  try {
    return utils.getAddress(trimmed);
  } catch (err) {
    throw new Error(`${label} must be a valid Ethereum address.`);
  }
}

function parseBps(value, label) {
  const raw = String(value ?? '').trim();
  if (raw === '') throw new Error(`${label} is required.`);
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be an integer.`);
  const parsed = Number(raw);
  if (parsed < 0 || parsed > 10_000) throw new Error(`${label} must be between 0 and 10,000.`);
  return parsed;
}

function parseUsdc(value, label) {
  const raw = String(value ?? '').trim();
  if (raw === '') throw new Error(`${label} is required.`);
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new Error(`${label} must use up to 6 decimals.`);
  return utils.parseUnits(raw, 6);
}

function parseHours(value, label) {
  const raw = String(value ?? '').trim();
  if (raw === '') throw new Error(`${label} is required.`);
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be an integer.`);
  const hours = BigInt(raw);
  if (hours < 0n) throw new Error(`${label} cannot be negative.`);
  return BigNumber.from(hours * 3_600n);
}

function parseListingId(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') throw new Error('Listing ID is required.');
  if (!/^\d+$/.test(raw)) throw new Error('Listing ID must be an integer.');
  const parsed = BigNumber.from(raw);
  if (parsed.isZero()) throw new Error('Listing ID must be at least 1.');
  return parsed;
}

function parseBookingId(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') throw new Error('Booking ID is required.');
  if (!/^\d+$/.test(raw)) throw new Error('Booking ID must be an integer.');
  return BigNumber.from(raw);
}

connectBtn.addEventListener('click', async () => {
  let normalizedAccount = null;
  try {
    connectBtn.disabled = true;
    const result = await connectWallet('walletStatus');
    provider = result.provider;
    signer = result.signer;
    normalizedAccount = utils.getAddress(await signer.getAddress());
    connectedAccountEl.textContent = `Connected as ${normalizedAccount}`;
    disconnectBtn.disabled = false;

    const owner = await loadOwnerAddress();
    if (normalizedAccount !== owner) {
      platformWrite = null;
      provider = null;
      signer = null;
      bookingRegistryWrite = null;
      connectedAccountEl.textContent = `Connected as ${normalizedAccount} (not owner)`;
      if (ownerGuardMessageEl) {
        ownerGuardMessageEl.textContent =
          'Connected wallet is not authorized for platform owner controls. Disconnect and switch wallets.';
      }
      setOwnerControlsEnabled(false);
      enableForms(false);
      updateDeregisterControlsEnabled();
      updateDeactivateControlsEnabled();
      setActionStatus('Connected wallet is not the platform owner. Switch wallets to continue.', 'error', true);
      return;
    }

    platformWrite = new Contract(PLATFORM_ADDRESS, PLATFORM_ABI, signer);
    updateBookingRegistryContract();
    setOwnerControlsEnabled(true);
    enableForms(true);
    if (ownerGuardMessageEl) {
      ownerGuardMessageEl.textContent = 'Owner wallet connected. Controls unlocked.';
    }
    updateDevConsoleStatus();
    setActionStatus('Owner wallet connected. Loading snapshot…');
    await refreshSnapshot();
    await loadTokenisationProposals();
  } catch (err) {
    console.error(err);
    const { message, severity } = interpretError(err);
    setActionStatus(`Connection failed: ${message}`, severity, true);
    connectedAccountEl.textContent = '';
    signer = null;
    provider = null;
    platformWrite = null;
    bookingRegistryWrite = null;
    disconnectBtn.disabled = true;
    updateDeregisterControlsEnabled();
    updateDeactivateControlsEnabled();
  } finally {
    if (!platformWrite) {
      connectBtn.disabled = false;
    }
  }
});

disconnectBtn.addEventListener('click', async () => {
  disconnectBtn.disabled = true;
  try {
    await disconnectWallet('walletStatus');
  } catch (err) {
    console.error(err);
  } finally {
    signer = null;
    provider = null;
    platformWrite = null;
    bookingRegistryWrite = null;
    connectedAccountEl.textContent = '';
    setOwnerControlsEnabled(false);
    enableForms(false);
    updateDeregisterControlsEnabled();
    updateDeactivateControlsEnabled();
    resetTokenProposalState();
    resetOwnerGuardMessage();
    connectBtn.disabled = false;
    setActionStatus('Disconnected.', 'info', true);
  }
});

if (deactivateListingIdInput) {
  deactivateListingIdInput.addEventListener('input', () => {
    scheduleDeactivateListingCheck();
  });
  deactivateListingIdInput.addEventListener('blur', () => {
    evaluateDeactivateListingId();
  });
}

if (deregisterListingAddressInput) {
  deregisterListingAddressInput.addEventListener('input', () => {
    evaluateDeregisterAddressInput();
  });
}

if (deregisterLookupBtn) {
  deregisterLookupBtn.addEventListener('click', () => {
    lookupDeregisterListingById();
  });
}

if (tokenRefreshBtn) {
  tokenRefreshBtn.addEventListener('click', () => {
    loadTokenisationProposals().catch((err) => {
      console.error('Failed to refresh tokenisation proposals', err);
    });
  });
}

if (depositLoadBtn) {
  depositLoadBtn.addEventListener('click', () => {
    loadDepositDetails();
  });
}

if (depositConfirmForm && confirmDepositBtn) {
  depositConfirmForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentDepositContext) {
      setDepositStatus('Load a booking before confirming the deposit split.', 'error');
      return;
    }
    const hasPending = toBool(currentDepositContext.pending?.exists);
    if (!hasPending) {
      setDepositStatus('No pending deposit split to confirm for this booking.', 'warning');
      return;
    }
    if (toBool(currentDepositContext.booking?.depositReleased)) {
      setDepositStatus('Deposit already released for this booking.', 'warning');
      return;
    }
    try {
      const cancellationContext = currentDepositContext
        ? {
            listingAddress: currentDepositContext.listingAddress,
            bookingId: currentDepositContext.bookingId,
          }
        : null;
      const success = await withSigner(
        'Confirming deposit release',
        () =>
          platformWrite.confirmDepositSplit(
            currentDepositContext.listingId,
            currentDepositContext.bookingId,
            '0x',
          ),
        confirmDepositBtn,
      );
      if (success) {
        await loadDepositDetails({ quiet: true });
        setDepositStatus('Deposit release confirmed on-chain. Attempting booking cancellation…', 'success');
        await cancelBookingAfterDepositRelease(cancellationContext);
      }
    } catch (err) {
      console.error('Failed to confirm deposit release', err);
      const { message, severity } = interpretError(err);
      setDepositStatus(`Failed to confirm deposit release: ${message}`, severity);
    }
  });
}

refreshSnapshotBtn.addEventListener('click', () => {
  refreshSnapshot();
});

if (toggleDevConsoleBtn) {
  toggleDevConsoleBtn.addEventListener('click', () => {
    if (!ownerAccessGranted) {
      return;
    }
    const manager = window.r3ntDevConsole;
    if (!manager || typeof manager.setEnabled !== 'function') {
      setActionStatus('Dev console controller unavailable.', 'error', true);
      return;
    }
    let currentlyEnabled = false;
    try {
      if (typeof manager.isEnabled === 'function') {
        currentlyEnabled = Boolean(manager.isEnabled());
      } else if (typeof manager.isActive === 'function') {
        currentlyEnabled = Boolean(manager.isActive());
      }
    } catch (err) {
      console.error('Failed to determine dev console status', err);
    }
    const nextState = !currentlyEnabled;
    try {
      manager.setEnabled(nextState);
      updateDevConsoleStatus();
      setActionStatus(nextState ? 'Dev console enabled.' : 'Dev console disabled.', 'success', true);
    } catch (err) {
      console.error('Failed to toggle dev console', err);
      const { message, severity } = interpretError(err);
      setActionStatus(`Failed to toggle dev console: ${message}`, severity, true);
    }
  });
}

function bindForm(form, label, handler) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"], button:not([type])');
    try {
      const txFunc = await handler();
      await withSigner(label, txFunc, submitButton);
    } catch (err) {
      if (submitButton) submitButton.disabled = false;
      console.error(err);
      const { message, severity } = interpretError(err);
      setActionStatus(message, severity);
    }
  });
}

bindForm(document.getElementById('formUpdateUsdc'), 'Updating USDC', () => {
  const address = normalizeAddress(document.getElementById('usdcAddress').value, 'USDC address');
  return async () => platformWrite.setUsdc(address);
});

bindForm(document.getElementById('formUpdateTreasury'), 'Updating treasury', () => {
  const address = normalizeAddress(document.getElementById('treasuryAddress').value, 'Treasury address');
  return async () => platformWrite.setTreasury(address);
});

bindForm(document.getElementById('formUpdateModules'), 'Updating modules', () => {
  const factory = normalizeAddress(document.getElementById('moduleFactory').value, 'ListingFactory address');
  const registry = normalizeAddress(document.getElementById('moduleRegistry').value, 'BookingRegistry address');
  const sqmu = normalizeAddress(document.getElementById('moduleSqmu').value, 'r3nt-SQMU address');
  return async () => platformWrite.setModules(factory, registry, sqmu);
});

bindForm(document.getElementById('formUpdateFees'), 'Updating platform fees', () => {
  const tenantBps = parseBps(document.getElementById('tenantFee').value, 'Tenant fee');
  const landlordBps = parseBps(document.getElementById('landlordFee').value, 'Landlord fee');
  if (tenantBps + landlordBps > 10_000) {
    throw new Error('Tenant + landlord fee exceeds 10,000 bps.');
  }
  return async () => platformWrite.setFees(tenantBps, landlordBps);
});

bindForm(document.getElementById('formUpdatePricing'), 'Updating pricing', () => {
  const listingFee = parseUsdc(document.getElementById('listingFee').value, 'Listing fee');
  const viewPrice = parseUsdc(document.getElementById('viewPrice').value, 'View pass price');
  const viewDuration = parseHours(document.getElementById('viewDuration').value, 'View pass duration');
  return async () => platformWrite.setListingPricing(listingFee, viewPrice, viewDuration);
});

bindForm(document.getElementById('formAgentImplementation'), 'Updating agent implementation', () => {
  const implementation = normalizeAddress(document.getElementById('agentImplementation').value, 'Implementation address');
  return async () => platformWrite.setAgentImplementation(implementation);
});

bindForm(document.getElementById('formAgentMaxFee'), 'Updating max agent fee', () => {
  const maxFee = parseBps(document.getElementById('agentMaxFee').value, 'Max agent fee');
  return async () => platformWrite.setMaxAgentFeeBps(maxFee);
});

bindForm(document.getElementById('formAgentDeployer'), 'Updating deployer access', () => {
  const account = normalizeAddress(document.getElementById('agentDeployerAddress').value, 'Account address');
  const flag = document.getElementById('agentDeployerFlag').value === 'true';
  return async () => platformWrite.setAgentDeployer(account, flag);
});

bindForm(document.getElementById('formAgentOperator'), 'Updating operator access', () => {
  const account = normalizeAddress(document.getElementById('agentOperatorAddress').value, 'Operator address');
  const flag = document.getElementById('agentOperatorFlag').value === 'true';
  return async () => platformWrite.setAgentOperator(account, flag);
});

bindForm(deactivateListingForm, 'Deactivating listing', async () => {
  if (!deactivateListingIdInput) {
    throw new Error('Listing ID input unavailable.');
  }
  let listingId;
  try {
    listingId = parseListingId(deactivateListingIdInput.value);
  } catch (err) {
    setDeactivateListingStatus(err.message, 'error');
    throw err;
  }

  let listingAddressRaw;
  try {
    listingAddressRaw = await platformRead.listingById(listingId);
  } catch (err) {
    console.error('Failed to load listing before deactivation', err);
    const { message, severity } = interpretError(err);
    setDeactivateListingStatus(`Failed to load listing: ${message}`, severity);
    throw new Error(message);
  }

  if (!listingAddressRaw || listingAddressRaw === constants.AddressZero) {
    setDeactivateListingStatus('Listing not found for that ID.', 'error');
    deactivateListingContext = {
      listingId,
      listingAddress: null,
      exists: false,
      loading: false,
      active: false,
    };
    updateDeactivateControlsEnabled();
    throw new Error('Listing not found for that ID.');
  }

  const listingAddress = utils.getAddress(listingAddressRaw);
  let isActive = false;
  try {
    const activeRaw = await platformRead.listingActive(listingId);
    isActive = toBool(activeRaw);
  } catch (err) {
    console.error('Failed to load listing active status before deactivation', err);
    const { message, severity } = interpretError(err);
    deactivateListingContext = {
      listingId,
      listingAddress,
      exists: true,
      loading: false,
      active: false,
    };
    setDeactivateListingStatus(`Failed to load listing status: ${message}`, severity);
    updateDeactivateControlsEnabled();
    throw new Error(message);
  }

  if (!isActive) {
    deactivateListingContext = {
      listingId,
      listingAddress,
      exists: true,
      loading: false,
      active: false,
    };
    setDeactivateListingStatus(`Listing at ${listingAddress} is already inactive.`, 'warning');
    updateDeactivateControlsEnabled();
    throw new Error('Listing already inactive.');
  }

  deactivateListingContext = {
    listingId,
    listingAddress,
    exists: true,
    loading: false,
    active: true,
  };
  setDeactivateListingStatus(`Listing at ${listingAddress} is active.`, 'success');
  updateDeactivateControlsEnabled();

  return async () => platformWrite.deactivateListing(listingId);
});

bindForm(deregisterListingForm, 'Deregistering listing', async () => {
  if (!bookingRegistryAddress || !bookingRegistryWrite) {
    setDeregisterListingStatus(DEREGISTER_REGISTRY_WARNING, 'warning');
    throw new Error('Booking registry is not configured.');
  }

  let listingAddress = null;
  const addressValue = deregisterListingAddressInput ? deregisterListingAddressInput.value : '';
  const trimmedAddress = String(addressValue ?? '').trim();
  if (trimmedAddress) {
    try {
      listingAddress = normalizeAddress(trimmedAddress, 'Listing address');
      deregisterContext.address = listingAddress;
      deregisterContext.resolvedFromId = false;
    } catch (err) {
      setDeregisterListingStatus(err.message, 'error');
      throw err;
    }
  }

  let listingId = null;
  if (!listingAddress) {
    const idValue = deregisterListingIdInput ? deregisterListingIdInput.value : '';
    try {
      listingId = parseListingId(idValue);
    } catch (err) {
      setDeregisterListingStatus(err.message, 'error');
      throw err;
    }

    let listingAddressRaw;
    try {
      listingAddressRaw = await platformRead.listingById(listingId);
    } catch (err) {
      console.error('Failed to resolve listing before deregistering', err);
      const { message, severity } = interpretError(err);
      setDeregisterListingStatus(`Failed to resolve listing: ${message}`, severity);
      throw new Error(message);
    }
    if (!listingAddressRaw || listingAddressRaw === constants.AddressZero) {
      setDeregisterListingStatus('Listing not found for that ID.', 'error');
      deregisterContext.address = null;
      deregisterContext.resolvedFromId = false;
      updateDeregisterControlsEnabled();
      throw new Error('Listing not found for that ID.');
    }
    listingAddress = utils.getAddress(listingAddressRaw);
    deregisterContext = { listingId, address: listingAddress, resolvedFromId: true, loading: false };
    if (deregisterListingAddressInput) {
      deregisterListingAddressInput.value = listingAddress;
    }
    setDeregisterListingStatus(`Listing resolved to ${listingAddress}.`, 'success');
  } else {
    if (!deregisterContext) {
      deregisterContext = { listingId: null, address: listingAddress, resolvedFromId: false, loading: false };
    } else {
      deregisterContext.listingId = null;
      deregisterContext.address = listingAddress;
      deregisterContext.resolvedFromId = false;
      deregisterContext.loading = false;
    }
  }

  updateDeregisterControlsEnabled();

  const targetAddress = listingAddress;
  if (!bookingRegistryRead) {
    const error = new Error('Booking registry contract unavailable.');
    error.severity = 'error';
    setDeregisterListingStatus('Booking registry contract unavailable. Reload and try again.', 'error');
    throw error;
  }

  const contextRef =
    deregisterContext || { listingId: null, address: targetAddress, resolvedFromId: false, loading: false };
  contextRef.address = targetAddress;
  contextRef.loading = true;
  setDeregisterListingStatus(`Checking registration status for ${targetAddress}…`);
  updateDeregisterControlsEnabled();

  let isRegistered = false;
  try {
    isRegistered = await bookingRegistryRead.isListing(targetAddress);
  } catch (err) {
    console.error('Failed to check listing registration before deregistering', err);
    const { message, severity } = interpretError(err);
    setDeregisterListingStatus(`Failed to check listing registration: ${message}`, severity);
    const forwarded = new Error(message);
    forwarded.severity = severity;
    throw forwarded;
  } finally {
    contextRef.loading = false;
    deregisterContext = contextRef;
    updateDeregisterControlsEnabled();
  }

  if (!isRegistered) {
    const warningMessage = `Listing at ${targetAddress} is not registered in the booking registry.`;
    const warningError = new Error(warningMessage);
    warningError.severity = 'warning';
    setDeregisterListingStatus(warningMessage, 'warning');
    throw warningError;
  }

  setDeregisterListingStatus(
    `Listing at ${targetAddress} is currently registered in the booking registry.`,
    'success',
  );

  return async () => bookingRegistryWrite.deregisterListing(targetAddress);
});

bindForm(document.getElementById('formUpdateCastHash'), 'Updating listing cast hash', () => {
  const listingId = parseListingId(document.getElementById('castHashListingId').value);
  const castInput = document.getElementById('castHashInput').value;
  const castHash = normalizeCastInputToBytes32(castInput);
  return async () => platformWrite.updateListingCastHash(listingId, castHash);
});

bindForm(document.getElementById('formCreateAgent'), 'Creating agent', () => {
  const listing = normalizeAddress(document.getElementById('createAgentListing').value, 'Listing address');
  const bookingId = parseBookingId(document.getElementById('createAgentBooking').value);
  const wallet = normalizeAddress(document.getElementById('createAgentWallet').value, 'Agent wallet');
  const feeBps = parseBps(document.getElementById('createAgentFee').value, 'Agent fee');
  const recipient = normalizeAddress(document.getElementById('createAgentRecipient').value, 'Fee recipient', { optional: true });
  return async () => platformWrite.createAgent(listing, bookingId, wallet, feeBps, recipient);
});

setOwnerControlsEnabled(false);
resetOwnerGuardMessage();
loadOwnerAddress().catch(() => {});
setActionStatus('Connect the platform owner wallet to begin.');
