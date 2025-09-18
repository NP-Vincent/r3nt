import R3NTSQMUArtifact from './abi/r3nt-SQMU.json' assert { type: 'json' };
import BookingRegistryArtifact from './abi/BookingRegistry.json' assert { type: 'json' };
import ListingArtifact from './abi/Listing.json' assert { type: 'json' };
import ListingFactoryArtifact from './abi/ListingFactory.json' assert { type: 'json' };
import PlatformArtifact from './abi/Platform.json' assert { type: 'json' };

export const CHAIN_ID = 42161; // Arbitrum One
export const RPC_URL = 'https://arb1.arbitrum.io/rpc';

export const USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

export const R3NT_ADDRESS = '0xYourR3ntSQMUAddressHere'; // r3nt-SQMU (SQMU-R token)
export const R3NT_ABI = R3NTSQMUArtifact.abi;

export const REGISTRY_ADDRESS = '0xYourBookingRegistryAddressHere'; // BookingRegistry
export const REGISTRY_ABI = BookingRegistryArtifact.abi;

export const LISTING_ADDRESS = '0xYourListingImplementationAddressHere'; // Listing implementation
export const LISTING_ABI = ListingArtifact.abi;

export const FACTORY_ADDRESS = '0xYourListingFactoryAddressHere'; // ListingFactory
export const FACTORY_ABI = ListingFactoryArtifact.abi;

export const PLATFORM_ADDRESS = '0xYourPlatformAddressHere'; // Platform
export const PLATFORM_ABI = PlatformArtifact.abi;

export const APP_NAME = 'r3nt';
export const APP_DOMAIN = 'r3nt.sqmu.net'; // origin used in EIP-712 domain if needed
