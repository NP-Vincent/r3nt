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

export async function connectWallet(statusId) {
  const ethereum = MMSDK.getProvider();
  const statusDiv = document.getElementById(statusId);
  statusDiv.innerText = 'Connecting to MetaMask...';

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
            statusDiv.innerHTML =
              '<span style="color:red;">Please switch to the Arbitrum One network manually in MetaMask Mobile.</span>';
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

    statusDiv.innerHTML =
      '<span style="color:green;">Connected to Arbitrum One</span>';
    return { provider, signer };
  } catch (err) {
    if (!err.handled) {
      if (err.code === -32002) {
        statusDiv.innerHTML =
          '<span style="color:red;">Request already pending. Check MetaMask.</span>';
      } else {
        statusDiv.innerHTML = `<span style="color:red;">${err.message}</span>`;
      }
    }
    throw err;
  }
}

export async function disconnectWallet(statusId) {
  const ethereum = MMSDK.getProvider();
  const statusDiv = document.getElementById(statusId);
  try {
    await ethereum.request({
      method: 'wallet_revokePermissions',
      params: [{ eth_accounts: {} }],
    });
    // Terminate the MetaMask SDK connection so the dapp fully disconnects
    MMSDK.terminate();
    statusDiv.innerHTML = '<span style="color:orange;">Disconnected</span>';
  } catch (err) {
    statusDiv.innerHTML = `<span style="color:red;">${err.message}</span>`;
  }
}
