export const MINIAPP_URL = 'https://farcaster.xyz/miniapps/ANe2hkmmO7G3/r3nt';
export const MINIAPP_REFERRAL_URL = 'https://farcaster.xyz/~/r/273k';

export async function showNonMiniAppPrompt({ sdk, container }) {
  if (!sdk || !container) {
    return;
  }

  let inMiniApp = false;
  if (typeof sdk.isInMiniApp === 'function') {
    try {
      inMiniApp = await sdk.isInMiniApp();
    } catch {
      inMiniApp = false;
    }
  }

  if (inMiniApp) {
    return;
  }

  container.innerHTML = `
    <p>
      r3nt works best inside the Farcaster Mini App.
      <a href="${MINIAPP_URL}" target="_blank" rel="noopener noreferrer">Launch the r3nt Mini App</a>
      to connect your wallet and unlock bookings.
    </p>
    <p>
      New to Farcaster?
      <a href="${MINIAPP_REFERRAL_URL}" target="_blank" rel="noopener noreferrer">Join with this referral link</a>.
    </p>
  `;
  container.hidden = false;
  container.removeAttribute('hidden');
}
