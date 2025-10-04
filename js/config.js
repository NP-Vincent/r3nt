async function loadArtifact(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`Failed to load artifact: ${url.pathname}`, error);
    return { abi: [] };
  }
}

const [
  R3NTSQMUArtifact,
  BookingRegistryArtifact,
  ListingArtifact,
  ListingFactoryArtifact,
  PlatformArtifact,
  AgentArtifact,
] = await Promise.all([
  loadArtifact('./abi/r3nt-SQMU.json'),
  loadArtifact('./abi/BookingRegistry.json'),
  loadArtifact('./abi/Listing.json'),
  loadArtifact('./abi/ListingFactory.json'),
  loadArtifact('./abi/Platform.json'),
  loadArtifact('./abi/Agent.json'),
]);

export const CHAIN_ID = 42161; // Arbitrum One
export const RPC_URL = 'https://arb1.arbitrum.io/rpc';

export const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

export const R3NT_ADDRESS = '0xCb9aBFeF8d3c63848C0676a2B8F9d4FAf96B396B'; // r3nt-SQMU (SQMU-R token)
export const R3NT_ABI = R3NTSQMUArtifact.abi || [];

export const REGISTRY_ADDRESS = '0xa863B419d947e77888C25329011fDEF1d355d24D'; // BookingRegistry
export const REGISTRY_ABI = BookingRegistryArtifact.abi || [];

export const LISTING_ADDRESS = '0x0C27402c0ab01e00B370771BDb08Fd48330E65be'; // Listing implementation
export const LISTING_ABI = ListingArtifact.abi || [];

export const FACTORY_ADDRESS = '0x4CC6c3B30DAf5473919a943B67B83a23B87bAe87'; // ListingFactory
export const FACTORY_ABI = ListingFactoryArtifact.abi || [];

export const PLATFORM_ADDRESS = '0x572891eB77CFe11bB61e970a64604fED524d7792'; // Platform
export const PLATFORM_ABI = PlatformArtifact.abi || [];

export const AGENT_ABI = AgentArtifact.abi || [];

export const APP_NAME = 'r3nt';
export const APP_DOMAIN = 'r3nt.sqmu.net'; // origin used in EIP-712 domain if needed
export const APP_VERSION = '0.6.0';
