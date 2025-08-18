# r3nt — On-Chain Property Rental for Farcaster Mini Apps

## Overview
**r3nt** is a minimal rental dApp designed to integrate with **Farcaster Mini Apps**.  
It enables landlords to list properties, tenants to book with USDC, and deposits to be held in escrow.  

- **Network**: Arbitrum One  
- **Token**: Canonical USDC (6 decimals)  
- **Upgradeable**: UUPS with OpenZeppelin v5  

---

## Features
- Landlords pay **$1 USDC** to list a property (title, short description, geohash, Farcaster link).  
- Tenants pay **$0.10 USDC** for a 72h view pass.  
- Tenants can **book rentals**: rent + deposit in USDC.  
  - Rent → landlord immediately.  
  - 1% commission → platform.  
  - Deposit → escrow until completion.  
- **Partial deposit release**: landlord proposes split, platform confirms.  
- **Minimal on-chain footprint**: all images, extended descriptions live off-chain in landlord’s Farcaster cast.  

---

## Architecture
- **Smart Contract**: `r3nt.sol` (Arbitrum One, upgradeable).  
- **Frontend**: Farcaster Mini App (HTML+JS).  
- **Storage**:  
  - On-chain: listing metadata (title, geohash, fid, castHash).  
  - Off-chain: images + long descriptions (Farcaster cast).  

---

## Contract Deployment
1. Deploy `r3nt` implementation.  
2. Deploy UUPS Proxy pointing to implementation.  
3. Call `initialize()` with:  
   - `_usdc`: Canonical USDC address on Arbitrum  
   - `_platform`: platform fee receiver  
   - `_feeBps`: 100 (1%)  
   - `_listFee`: `1_000_000` (=$1.00)  
   - `_viewFee`: `100_000` (=$0.10)  
   - `_viewPassSeconds`: `259200` (72h)  

---

## Frontend Integration (Farcaster Mini App)
### Reads
Use **public RPC client**:
```js
const pub = createPublicClient({ chain: arbitrum, transport: http("https://arb1.arbitrum.io/rpc") });
const listingsCount = await pub.readContract({ address, abi, functionName: "listingsCount" });
```

---

### Writes

Use **Mini App wallet provider**:

1. `approve(USDC, amount)`
2. Call contract function (`createListing`, `buyViewPass`, `book`, etc.)

Example booking flow:
```js
// 1. Tenant approves (rent + fee + deposit)
await usdc.approve(contractAddr, totalAmount);

// 2. Tenant books
await contract.book(listingId, rateType, units, startDate, endDate);
```

---

# Farcaster Mini App Development Best Practices

## General Practices
- Always call `await sdk.actions.ready()` on load to dismiss the splash screen.  
- Use `sdk.wallet.getEthereumProvider()` for write operations.  
- Detect host: if no provider is available, fall back to **read-only mode**.  
- Use the **canonical Arbitrum RPC** (`https://arb1.arbitrum.io/rpc`) for reads; never mix `eth_call` through the Mini App provider.  
- Always run `eth_estimateGas` before sending a transaction, and surface “Insufficient funds” gracefully.  
- Store only **minimal data on-chain**. All media and long descriptions should live in a Farcaster cast linked by `(fid, castHash)`.  

---

## Error Handling

**Common issues & fixes:**

- **“The provider does not support the requested method”**  
  → You attempted `eth_call` through the Mini App provider. Use a public RPC for reads.  

- **“Insufficient funds”**  
  → Tenant doesn’t hold enough ETH on Arbitrum for gas. Recommend ~0.0002–0.0005 ETH.  

- **“fee mismatch”**  
  → Tenant’s sent value didn’t equal `currentFee`. Always read the fee from RPC immediately before play/book.  

---

## Development & Testing

- **Smart Contract**  
  - Written in Solidity `0.8.26`.  
  - Uses OpenZeppelin Upgradeable base contracts.  
  - Upgrade with **UUPS**, with `_authorizeUpgrade` restricted to `onlyOwner`.  

- **Manual Testing**  
  - Uses **Remix**.  

- **Mini App Front-End**  
  - `@farcaster/miniapp-sdk`  
  - `viem@2.x`  
  - Arbitrum RPC: `https://arb1.arbitrum.io/rpc`  






