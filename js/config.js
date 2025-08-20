export const CHAIN_ID = 42161; // Arbitrum One
export const RPC_URL = "https://arb1.arbitrum.io/rpc";

export const EXPLORER_URLS = {
  42161: "https://arbiscan.io",
};
export const EXPLORER = EXPLORER_URLS[CHAIN_ID];

export const R3NT_ADDRESS = "0x18Af5B8fFA27B8300494Aa1a8c4F6AE4ee087029";
export const FACTORY_ADDRESS = "0x7c67FDcebc883C1BACd03Ee7483e8E6300F4Df51";
export const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const PLATFORM_ADDRESS = "0x43F3f03d89290358034993aE3B3938D056D76De2";

export const VIEW_PASS_SECONDS = 72 * 3600; // 72h
export const FEE_BPS = 200;                 // 2% total (split 1%/1%)

export const APP_NAME = "r3nt";
export const APP_DOMAIN = "r3nt.sqmu.net"; // origin used in EIP-712 domain if needed
