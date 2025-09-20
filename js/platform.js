const ethersLib = window.ethers;
if (!ethersLib) {
  throw new Error('Ethers library not found. Ensure ethers UMD bundle is loaded before platform.js.');
}

import { PLATFORM_ADDRESS, PLATFORM_ABI, RPC_URL, APP_VERSION } from './config.js';
import { connectWallet, disconnectWallet } from './platform-only-metamask-wallet.js';
import { notify, mountNotificationCenter } from './notifications.js';

const { BigNumber, constants, utils, providers, Contract } = ethersLib;

const readProvider = new providers.JsonRpcProvider(RPC_URL);
const platformRead = new Contract(PLATFORM_ADDRESS, PLATFORM_ABI, readProvider);

let signer = null;
let provider = null;
let platformWrite = null;
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const refreshSnapshotBtn = document.getElementById('refreshSnapshotBtn');
const connectedAccountEl = document.getElementById('connectedAccount');
const snapshotOutputEl = document.getElementById('snapshotOutput');
const actionStatusEl = document.getElementById('actionStatus');

mountNotificationCenter(document.getElementById('notificationTray'), { role: 'platform' });

const versionTargets = document.querySelectorAll('[data-version]');
versionTargets.forEach((node) => {
  if (node) node.textContent = APP_VERSION || 'dev';
});
const navBadge = document.querySelector('nav .version-badge[data-version]');
if (navBadge) {
  navBadge.textContent = `Build ${APP_VERSION}`;
}

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

function formatUsdc(value) {
  const big = typeof value === 'bigint' ? value : BigInt(BigNumber.from(value || 0).toString());
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const units = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${units}${fraction ? `.${fraction}` : ''}`;
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

function enableForms(enabled) {
  document.querySelectorAll('form[data-requires-signer]').forEach((form) => {
    Array.from(form.elements).forEach((control) => {
      control.disabled = !enabled;
    });
  });
}

enableForms(false);

async function refreshSnapshot() {
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

    const lines = [
      `Owner:           ${owner}`,
      `Treasury:        ${treasury}`,
      `USDC:            ${usdc}`,
      '',
      'Modules:',
      `  • ListingFactory : ${listingFactory}`,
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
    return;
  }
  if (button) button.disabled = true;
  try {
    setActionStatus(`${label}…`);
    const tx = await action();
    setActionStatus(`${label} submitted. Waiting for confirmation (tx: ${tx.hash}).`);
    await tx.wait();
    setActionStatus(`${label} confirmed.`, 'success', true);
    await refreshSnapshot();
  } catch (err) {
    console.error(err);
    const { message, severity } = interpretError(err);
    setActionStatus(`${label} failed: ${message}`, severity, true);
  } finally {
    if (button) button.disabled = false;
  }
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

function parseBookingId(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') throw new Error('Booking ID is required.');
  if (!/^\d+$/.test(raw)) throw new Error('Booking ID must be an integer.');
  return BigNumber.from(raw);
}

connectBtn.addEventListener('click', async () => {
  try {
    connectBtn.disabled = true;
    const result = await connectWallet('walletStatus');
    provider = result.provider;
    signer = result.signer;
    const account = await signer.getAddress();
    connectedAccountEl.textContent = `Connected as ${account}`;
    disconnectBtn.disabled = false;
    platformWrite = new Contract(PLATFORM_ADDRESS, PLATFORM_ABI, signer);
    enableForms(true);
    setActionStatus('Wallet connected.', 'success', true);
  } catch (err) {
    console.error(err);
    const { message, severity } = interpretError(err);
    setActionStatus(`Connection failed: ${message}`, severity, true);
    connectBtn.disabled = false;
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
    connectedAccountEl.textContent = '';
    enableForms(false);
    connectBtn.disabled = false;
    setActionStatus('Disconnected.', 'info', true);
  }
});

refreshSnapshotBtn.addEventListener('click', () => {
  refreshSnapshot();
});

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

bindForm(document.getElementById('formCreateAgent'), 'Creating agent', () => {
  const listing = normalizeAddress(document.getElementById('createAgentListing').value, 'Listing address');
  const bookingId = parseBookingId(document.getElementById('createAgentBooking').value);
  const wallet = normalizeAddress(document.getElementById('createAgentWallet').value, 'Agent wallet');
  const feeBps = parseBps(document.getElementById('createAgentFee').value, 'Agent fee');
  const recipient = normalizeAddress(document.getElementById('createAgentRecipient').value, 'Fee recipient', { optional: true });
  return async () => platformWrite.createAgent(listing, bookingId, wallet, feeBps, recipient);
});

refreshSnapshot();
setActionStatus('Waiting for wallet connection.');
