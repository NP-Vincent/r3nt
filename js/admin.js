import { sdk } from 'https://esm.sh/@farcaster/miniapp-sdk';
import { createPublicClient, http, encodeFunctionData, parseUnits, getAddress, keccak256, encodePacked, stringToHex, concatHex } from 'https://esm.sh/viem@2.9.32';
import { arbitrum } from 'https://esm.sh/viem/chains';

// -------------------- Config --------------------
const ARBITRUM_HEX   = '0xa4b1';
const R3NT_ADDRESS   = '0x18Af5B8fFA27B8300494Aa1a8c4F6AE4ee087029';
const USDC_DECIMALS  = 6;
const RELEASE_PREFIX = stringToHex('DEPOSIT_RELEASE', { size: 32 });

// Minimal ABIs
const r3ntAbi = await fetch('./js/abi/r3nt.json').then(r => r.json()).then(j => j.abi);
const listingAbi = [
  { type:'function', name:'tenant',       stateMutability:'view', inputs:[], outputs:[{type:'address'}] },
  { type:'function', name:'landlord',     stateMutability:'view', inputs:[], outputs:[{type:'address'}] },
  { type:'function', name:'propTenant',   stateMutability:'view', inputs:[], outputs:[{type:'uint96'}] },
  { type:'function', name:'propLandlord', stateMutability:'view', inputs:[], outputs:[{type:'uint96'}] },
  { type:'function', name:'nonce',        stateMutability:'view', inputs:[], outputs:[{type:'uint256'}] },
];

// -------------------- UI --------------------
const els = {
  contextBar: document.getElementById('contextBar'),
  connect:    document.getElementById('connect'),
  bookingId:  document.getElementById('bookingId'),
  amtTenant:  document.getElementById('amtTenant'),
  amtLandlord:document.getElementById('amtLandlord'),
  propose:    document.getElementById('propose'),
  sign:       document.getElementById('sign'),
  sigLandlord:document.getElementById('sigLandlord'),
  sigPlatform:document.getElementById('sigPlatform'),
  confirm:    document.getElementById('confirm'),
  status:     document.getElementById('status'),
};
const info = (t) => els.status.textContent = t;

// -------------------- Boot --------------------
let provider;
const pub = createPublicClient({ chain: arbitrum, transport: http('https://arb1.arbitrum.io/rpc') });
(async () => {
  try { await sdk.actions.ready(); } catch {}
  try {
    const { token } = await sdk.quickAuth.getToken();
    const [, payloadB64] = token.split('.');
    const payloadJson = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    els.contextBar.textContent = `FID: ${payloadJson.sub} · Signed in`;
  } catch {
    els.contextBar.textContent = 'QuickAuth failed. Open inside a Farcaster client.';
    return;
  }
  els.connect.disabled = false;
})();

async function ensureArbitrum(p) {
  const id = await p.request({ method:'eth_chainId' });
  if (id !== ARBITRUM_HEX) {
    try {
      await p.request({ method:'wallet_switchEthereumChain', params:[{ chainId: ARBITRUM_HEX }] });
    } catch {
      await p.request({ method:'wallet_addEthereumChain', params:[{ chainId: ARBITRUM_HEX, chainName:'Arbitrum One', nativeCurrency:{ name:'Ether', symbol:'ETH', decimals:18 }, rpcUrls:['https://arb1.arbitrum.io/rpc'], blockExplorerUrls:['https://arbiscan.io'] }] });
    }
  }
}

els.connect.onclick = async () => {
  try {
    provider = await sdk.wallet.getEthereumProvider();
    await provider.request({ method:'eth_requestAccounts' });
    await ensureArbitrum(provider);
    els.connect.textContent = 'Wallet Connected';
    els.connect.style.background = '#10b981';
    els.propose.disabled = false;
    els.sign.disabled = false;
    els.confirm.disabled = false;
    info('Wallet ready.');
  } catch (e) {
    info(e?.message || 'Wallet connection failed.');
  }
};

function parseDec6(s) {
  const v = String(s ?? '').trim();
  if (v === '') throw new Error('Missing numeric value.');
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error('Use up to 6 decimals.');
  return parseUnits(v, USDC_DECIMALS);
}

els.propose.onclick = async () => {
  try {
    if (!provider) throw new Error('Connect wallet first.');
    const [from] = await provider.request({ method:'eth_accounts' }) || [];
    if (!from) throw new Error('No wallet account.');
    await ensureArbitrum(provider);
    const bookingId = BigInt(els.bookingId.value);
    const toTenant = parseDec6(els.amtTenant.value);
    const toLandlord = parseDec6(els.amtLandlord.value);
    const data = encodeFunctionData({
      abi: r3ntAbi,
      functionName: 'proposeDepositSplit',
      args: [bookingId, toTenant, toLandlord]
    });
    const txHash = await provider.request({ method:'eth_sendTransaction', params:[{ from, to:R3NT_ADDRESS, data }] });
    info(`Propose tx sent: ${txHash}`);
  } catch (e) {
    info(`Error: ${e?.message || e}`);
  }
};

async function buildReleaseHash(bookingId) {
  const b = await pub.readContract({ address:R3NT_ADDRESS, abi:r3ntAbi, functionName:'getBooking', args:[bookingId] });
  const listing = await pub.readContract({ address:R3NT_ADDRESS, abi:r3ntAbi, functionName:'getListing', args:[b.listingId] });
  const vault = listing.vault;
  const [tenant, landlord, propTenant, propLandlord, nonce] = await Promise.all([
    pub.readContract({ address:vault, abi:listingAbi, functionName:'tenant' }),
    pub.readContract({ address:vault, abi:listingAbi, functionName:'landlord' }),
    pub.readContract({ address:vault, abi:listingAbi, functionName:'propTenant' }),
    pub.readContract({ address:vault, abi:listingAbi, functionName:'propLandlord' }),
    pub.readContract({ address:vault, abi:listingAbi, functionName:'nonce' })
  ]);
  return keccak256(encodePacked(
    ['bytes32','address','address','address','uint96','uint96','uint256'],
    [RELEASE_PREFIX, vault, tenant, landlord, propTenant, propLandlord, nonce]
  ));
}

els.sign.onclick = async () => {
  try {
    if (!provider) throw new Error('Connect wallet first.');
    const [from] = await provider.request({ method:'eth_accounts' }) || [];
    if (!from) throw new Error('No wallet account.');
    await ensureArbitrum(provider);
    const bookingId = BigInt(els.bookingId.value);
    const hash = await buildReleaseHash(bookingId);
    const sig = await provider.request({ method:'eth_sign', params:[from, hash] });
    // store depending on role
    const addr = getAddress(from);
    if (!els.sigLandlord.value) {
      els.sigLandlord.value = sig;
    } else if (!els.sigPlatform.value) {
      els.sigPlatform.value = sig;
    }
    info('Signature generated.');
  } catch (e) {
    info(`Error: ${e?.message || e}`);
  }
};

els.confirm.onclick = async () => {
  try {
    if (!provider) throw new Error('Connect wallet first.');
    const [from] = await provider.request({ method:'eth_accounts' }) || [];
    if (!from) throw new Error('No wallet account.');
    await ensureArbitrum(provider);
    const bookingId = BigInt(els.bookingId.value);
    const sig1 = els.sigLandlord.value.trim();
    const sig2 = els.sigPlatform.value.trim();
    if (!sig1 || !sig2) throw new Error('Both signatures required.');
    const combined = concatHex([sig1, sig2]);
    const data = encodeFunctionData({ abi:r3ntAbi, functionName:'confirmDepositRelease', args:[bookingId, combined] });
    const txHash = await provider.request({ method:'eth_sendTransaction', params:[{ from, to:R3NT_ADDRESS, data }] });
    info(`Confirm tx sent: ${txHash}`);
  } catch (e) {
    info(`Error: ${e?.message || e}`);
  }
};

