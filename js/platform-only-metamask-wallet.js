// wallet.js - shared wallet helpers for SQMU widgets
// This module relies on ethers.js and MetaMask SDK loaded via CDN.

const MMSDK = new MetaMaskSDK.MetaMaskSDK({
  dappMetadata: { name: 'SQMU Wallet', url: window.location.href },
  infuraAPIKey: '822e08935dea4fb48f668ff353ac863a',
});

const SCROLL_CHAIN_ID = '0x82750';

const SCROLL_PARAMS = {
  chainId: SCROLL_CHAIN_ID,
  chainName: 'Scroll',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.scroll.io'],
  blockExplorerUrls: ['https://scrollscan.com'],
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
    if (chainId !== SCROLL_CHAIN_ID) {
      try {
        await ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: SCROLL_CHAIN_ID }],
        });
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [SCROLL_PARAMS],
          });
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: SCROLL_CHAIN_ID }],
          });
        } else {
          const isWalletConnect =
            MMSDK.isWalletConnect || ethereum.isWalletConnect || ethereum.wc;
          const unsupportedMethod =
            switchErr.code === 4200 || switchErr.code === -32601;
          if (isWalletConnect && unsupportedMethod) {
            statusDiv.innerHTML =
              '<span style="color:red;">Please switch to the Scroll network manually in MetaMask Mobile.</span>';
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
      '<span style="color:green;">Connected to Scroll</span>';
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
