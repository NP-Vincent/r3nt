// wallet.js - shared wallet helpers for SQMU widgets
// This module relies on ethers.js and MetaMask SDK loaded via CDN.

const metaMaskNamespace = window.MetaMaskSDK;
if (!metaMaskNamespace || !metaMaskNamespace.MetaMaskSDK) {
  throw new Error('MetaMask SDK not found. Ensure the UMD bundle is loaded before wallet helpers.');
}

const MMSDK = new metaMaskNamespace.MetaMaskSDK({
  dappMetadata: { name: 'SQMU Wallet', url: window.location.href },
  infuraAPIKey: '822e08935dea4fb48f668ff353ac863a',
});

const ARBITRUM_CHAIN_ID = '0xa4b1';

const ARBITRUM_PARAMS = {
  chainId: ARBITRUM_CHAIN_ID,
  chainName: 'Arbitrum One',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://arb1.arbitrum.io/rpc'],
  blockExplorerUrls: ['https://arbiscan.io'],
};

const STATUS_CLASS_MAP = {
  info: 'status-info',
  success: 'status-success',
  warning: 'status-warning',
  error: 'status-error',
};

const STATUS_CLASSES = Object.values(STATUS_CLASS_MAP);

function applyStatus(statusNode, message, variant = 'info') {
  if (!statusNode) {
    return;
  }
  statusNode.textContent = message;
  statusNode.classList.add('status');
  STATUS_CLASSES.forEach((className) => {
    statusNode.classList.remove(className);
  });
  statusNode.classList.remove('status-ok');
  const className = STATUS_CLASS_MAP[variant] || null;
  if (className) {
    statusNode.classList.add(className);
  }
}

export async function connectWallet(statusId) {
  const ethereum = MMSDK.getProvider();
  const statusDiv = document.getElementById(statusId);
  if (!statusDiv) {
    throw new Error(`Status element with id "${statusId}" not found.`);
  }
  applyStatus(statusDiv, 'Connecting to MetaMask...');

  try {
    const accounts = await MMSDK.connect();
    // MMSDK.connect already exposes the account; no additional eth_accounts
    // request is made to prevent duplicate MetaMask popups
    let chainId = await ethereum.request({ method: 'eth_chainId', params: [] });
    if (chainId !== ARBITRUM_CHAIN_ID) {
      try {
        await ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: ARBITRUM_CHAIN_ID }],
        });
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [ARBITRUM_PARAMS],
          });
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: ARBITRUM_CHAIN_ID }],
          });
        } else {
          const isWalletConnect =
            MMSDK.isWalletConnect || ethereum.isWalletConnect || ethereum.wc;
          const unsupportedMethod =
            switchErr.code === 4200 || switchErr.code === -32601;
          if (isWalletConnect && unsupportedMethod) {
            applyStatus(
              statusDiv,
              'Please switch to the Arbitrum One network manually in MetaMask Mobile.',
              'warning',
            );
            switchErr.handled = true;
            throw switchErr;
          }
          throw switchErr;
        }
      }
      chainId = await ethereum.request({ method: 'eth_chainId', params: [] });
    }

    const provider = new ethers.providers.Web3Provider(ethereum);
    const signer = provider.getSigner();

    applyStatus(statusDiv, 'Connected to Arbitrum One', 'success');
    return { provider, signer };
  } catch (err) {
    if (!err.handled) {
      if (err.code === -32002) {
        applyStatus(statusDiv, 'Request already pending. Check MetaMask.', 'warning');
      } else {
        applyStatus(statusDiv, err?.message || 'MetaMask connection failed.', 'error');
      }
    }
    throw err;
  }
}

export async function disconnectWallet(statusId) {
  const ethereum = MMSDK.getProvider();
  const statusDiv = document.getElementById(statusId);
  if (!statusDiv) {
    throw new Error(`Status element with id "${statusId}" not found.`);
  }
  try {
    await ethereum.request({
      method: 'wallet_revokePermissions',
      params: [{ eth_accounts: {} }],
    });
    // Terminate the MetaMask SDK connection so the dapp fully disconnects
    MMSDK.terminate();
    applyStatus(statusDiv, 'Disconnected', 'info');
  } catch (err) {
    applyStatus(statusDiv, err?.message || 'Failed to disconnect MetaMask.', 'error');
  }
}
