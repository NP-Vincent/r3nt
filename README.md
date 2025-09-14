# r3nt — On-Chain Property Rental for Farcaster Mini Apps

## Overview
**r3nt** is a minimal rental dApp designed to integrate with **Farcaster Mini Apps**.  
It enables landlords to list properties, tenants to book with USDC, and deposits to be held in escrow.  

- **Network**: Arbitrum One
- **Token**: Canonical USDC (6 decimals)
- **Upgradeable**: UUPS with OpenZeppelin v5

For developer and debugging guidance, see the [Farcaster Mini App Agents Checklist](https://miniapps.farcaster.xyz/docs/guides/agents-checklist). More detailed information is available in `notes/Codex-minapp-farcaster-reference.txt`, a local copy of the upstream `llms-full.txt`.

## r3nt Functions and Services

### Core Rental Flow
- **Landlord listings** – Landlords pay a $2 USDC fee to register properties and define deposit and rate schedules. Listings are stored on-chain, with rich details kept in a linked Farcaster cast.
- **Tenant access** – Tenants purchase a 72‑hour view pass for $0.25 USDC before booking and then pay rent plus deposit in USDC when booking. The system splits fees between landlord and platform, and it records booking details for future reference.
- **Deposit escrow & release** – Deposits flow into a per‑listing vault. After a stay, landlords propose a tenant/landlord split and the platform confirms the release using multi-signature verification.

### Smart-Contract Services
- **ListingFactory** – Deploys deterministic Listing clones with a token allowlist, creating isolated deposit vaults for each property.
- **BookingRegistry** – Manages reservation calendars via month bitmasks with functions to reserve, release, and query availability for arbitrary date ranges.
- **R3NTSQMU (SQMU‑R token)** – Tokenizes long‑term bookings into ERC‑1155 shares, enabling proposals, approvals, investments, and fee distribution over weekly or monthly schedules.

### Front-End Utilities
- **Geolocation helpers** – Encode/decode geohashes and compute approximate cell sizes to map property coordinates.
- **Farcaster cast utilities** – Validate and normalize cast hashes and URLs for linking on-chain listings to off-chain content.

These components together provide a full-stack rental dApp: landlords create upgradeable listings with secure deposit handling, tenants book and pay in USDC, the platform manages calendars and deposit releases, and longer bookings can be tokenized for investors.

### Hosting
The static frontend references assets with relative paths, so it can be served from any directory. Hosting at the domain root is not required.

---

## Features
- Landlords pay **$2 USDC** to list a property (title, short description, geohash, Farcaster link).  
- Tenants pay **$0.25 USDC** for a 72h view pass.  
- Tenants can **book rentals**: rent + deposit in USDC.  
  - Rent → landlord immediately.  
  - 2% commission → platform.  
  - Deposit → escrow until completion.  
- **Partial deposit release**: landlord proposes split, platform confirms.
- **Minimal on-chain footprint**: all images, extended descriptions live off-chain in landlord’s Farcaster cast.

### r3nt-SQMU.sol
`r3nt-SQMU.sol` mints the **SQMU-R** ERC-1155 token. Landlords or tenants can tokenise bookings longer than three weeks and choose a weekly or monthly rent schedule, creating tradable rent shares for investors.

---

## Architecture
- **Contracts**:
  - `Listing.sol`: cloneable per-property deposit vault.
  - `ListingFactory.sol`: UUPS factory that deploys deterministic `Listing` clones and manages a token allowlist.
  - `r3nt.sol`: upgradeable core that wires bookings and deposit handling to the factory.
  - `BookingRegistry.sol`: calendar registry used for booking/reservation tracking.
  - `r3nt-SQMU.sol`: UUPS ERC-1155 that tokenises square-metre bookings, reserves dates via `BookingRegistry`, and reads USDC and platform settings from `r3nt`.
- **Frontend**: Farcaster Mini App (HTML+JS).
- **Storage**:
  - On-chain: listing metadata (title, geohash, fid, castHash).
  - Off-chain: images + long descriptions (Farcaster cast).

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
  - `viem@2.34.0`  
  - Arbitrum RPC: `https://arb1.arbitrum.io/rpc`  

---

# Deployment (Remix on Arbitrum One)

All deployments and upgrades are executed manually in **Remix**.

## Steps
1. **Listing implementation** – deploy `Listing.sol` (non-upgradeable).
2. **ListingFactory** – deploy implementation and UUPS proxy.
   - Call `initialize(listingImpl)`.
   - Call `setAllowedToken(USDC, true)` to whitelist your payment token.
3. **BookingRegistry** – deploy implementation and UUPS proxy.
   - Call `initialize(admin, address(0))`.
4. **r3nt** – deploy implementation and UUPS proxy.
   - Call `initialize(_usdc, _platform, _feeBps, _listFee, _viewFee, _viewPassSeconds, factoryAddress, bookingRegistryAddress)`.
   - On `BookingRegistry`, grant `R3NT_ROLE` to the r3nt proxy so it can `reserve`/`release`.
5. **r3nt-SQMU** – deploy implementation and UUPS proxy.
   - Call `initialize(r3ntProxy, bookingRegistryAddress, uri)`.
   - On `BookingRegistry`, grant `R3NT_ROLE` to the r3nt-SQMU proxy so it can `reserve`/`release`.

### Post-Deployment Flow
- From the landlord wallet, call `r3nt.createListing(...)` passing ERC-7913 signers and threshold.
- Verify `getListing(id).vault` returns a non-zero address to confirm clone creation.
- Tenant approves `r3nt` for `(rent + fee + deposit)` in the listing token and calls `book(...)`; the deposit moves into the vault.
- To close: landlord `markCompleted` → landlord `proposeDepositSplit` → platform `confirmDepositRelease(bookingId, signature)`.

### Tiny Checks
- `platform` should be your multisig/owner.
- Factory `ADMIN_ROLE` is granted to the deployer in `initialize`.
- To update `Listing`, deploy a new implementation and call `setImplementation(newImpl)` on the factory (existing clones stay unchanged).

## Initializer Parameters
- **ListingFactory.initialize**: `listingImpl`
- **r3nt.initialize**:
  - `_usdc`: Canonical USDC address on Arbitrum
  - `_platform`: fee receiver / owner
  - `_feeBps`: e.g., `200` for 2%
  - `_listFee`: `2_000_000` (=$2)
  - `_viewFee`: `250_000` (=$0.25)
  - `_viewPassSeconds`: `259200` (72h)
  - `_factory`: ListingFactory proxy address
  - `_bookingRegistry`: BookingRegistry proxy address
- **r3nt-SQMU.initialize**:
  - `_core`: r3nt proxy address
  - `_registry`: BookingRegistry proxy address
  - `uri`: base metadata URI

## Investor Flow
1. Landlord or tenant proposes tokenisation for a booking longer than three weeks and selects a weekly or monthly distribution schedule.
2. After platform approval, investors mint **SQMU-R** tokens representing the tokenised rent.
3. Rent is streamed to SQMU-R holders according to the chosen schedule; tokens are burned when the stay concludes.

---


## Mini App “Write” Flow
The pattern mirrors a working dApp:

1. `approve(USDC, listFee)` → `createListing(...)`  
2. `approve(USDC, viewFee)` → `buyViewPass()`  
3. For booking:  
   - `approve(listing.USDC, rent + platformFee + deposit)`  
   - `book(...)`  

### Booking Lifecycle
- **Landlord:** `markCompleted(bookingId)`  
- **Landlord:** `proposeDepositSplit(bookingId, toTenant, toLandlord)`  
- **Platform/Owner:** `confirmDepositRelease(bookingId)`  

---

## View Pass UX
- Store and display `viewPassExpiry[user]`.  
- Hide results if the pass is expired.  
- Note: This is a **soft gate** — raw RPC reads can still access listings. The gate is only enforced in the Mini App UI/UX.  

---

## Farcaster Link
- Store `(fid, castHash)` on-chain.  
- Client-side, build the **“View full details on Farcaster”** URL.  









