const ethersLib = window.ethers;
if (!ethersLib) {
  throw new Error('Ethers library not found. Ensure ethers UMD bundle is loaded before platform.js.');
}

import { PLATFORM_ADDRESS, PLATFORM_ABI, RPC_URL, APP_VERSION } from './config.js';
import { connectWallet, disconnectWallet } from './platform-only-metamask-wallet.js';

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

const versionBadge = document.querySelector('[data-version]');
if (versionBadge) {
  versionBadge.textContent = APP_VERSION || 'dev';
}

function setActionStatus(message, type = 'info') {
  actionStatusEl.textContent = message;
  actionStatusEl.classList.remove('status-ok', 'status-error');
  if (type === 'success') {
    actionStatusEl.classList.add('status-ok');
  } else if (type === 'error') {
    actionStatusEl.classList.add('status-error');
  }
}

function describeError(err) {
  if (!err) return 'Unknown error';
  if (err.error && err.error.message) return err.error.message;
  if (err.data && err.data.message) return err.data.message;
  if (err.reason) return err.reason;
  if (err.message) return err.message;
  return String(err);
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
  } catch (error) {
    console.error('Failed to refresh snapshot', error);
    snapshotOutputEl.textContent = `Failed to load snapshot: ${describeError(error)}`;
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
    setActionStatus(`${label} confirmed.`, 'success');
    await refreshSnapshot();
  } catch (err) {
    console.error(err);
    setActionStatus(`${label} failed: ${describeError(err)}`, 'error');
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
    setActionStatus('Wallet connected.', 'success');
  } catch (err) {
    console.error(err);
    setActionStatus(`Connection failed: ${describeError(err)}`, 'error');
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
    setActionStatus('Disconnected.', 'info');
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
      setActionStatus(describeError(err), 'error');
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
