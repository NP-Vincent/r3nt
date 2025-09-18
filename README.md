# r3nt — Clean-Slate Smart-Contract Suite

## Overview
The **Clean-Slate** rebuild of r3nt replaces the legacy split between booking, deposits and
SQMU tokenisation with a single, modular suite of Solidity contracts. The goal is to deliver a
unified booking flow for Farcaster Mini App users while keeping deposits transparent, rent
streams scalable and investor tokenisation optional on every stay. All value transfers are
settled in canonical **USDC (6 decimals)** and every upgradeable module relies on the
OpenZeppelin UUPS pattern.

## High-Level Goals
- **Unified booking flow** – every reservation (short-term or tokenised) is handled by the
  same per-property `Listing` clone.
- **Per-unit booking** – listings manage their own calendars; tenants reserve entire units,
  not square metres.
- **Integrated tokenisation** – ERC-1155 SQMU-R tokens (via the r3nt-SQMU contract) can be
  minted for any booking without a separate deployment.
- **Transparent deposit handling** – deposits sit in the listing escrow until a multi-sig
  release is confirmed by the platform.
- **Scalable rent streaming** – recurring rent is distributed via an accumulator pattern that
  avoids iterating over every investor.
- **Modular architecture** – `Platform`, `ListingFactory`, `Listing` clones,
  `BookingRegistry` and `r3nt-SQMU` each focus on a single concern and can be upgraded
  independently through UUPS proxies.

## Module Architecture
### Platform (`Platform.sol`)
The platform contract owns global configuration and orchestrates listing creation.
- Stores the USDC address, tenant/landlord fee basis points and any additional pricing
  configuration (listing fee, view-pass price, etc.).
- Holds the addresses of the `ListingFactory`, `BookingRegistry` and `r3nt-SQMU` so the UI can
  route calls correctly.
- Only the platform multi-sig may update parameters or authorise upgrades via setters such as
  `setTreasury`, `setFees`, `setListingPricing` and `setModules`.
- Read helpers like `modules()` and `fees()` surface the active configuration to off-chain
  consumers.
- `createListing(address landlord, uint256 fid, bytes32 castHash, bytes32 geohash, uint8 geohashPrecision,
  uint32 areaSqm, uint256 baseDailyRate, uint256 depositAmount, uint64 minBookingNotice,
  uint64 maxBookingWindow, string metadataURI)` requests the factory to clone a new listing and emits
  `ListingCreated(listing, landlord)`.

### ListingFactory (`ListingFactory.sol`)
A minimal proxy factory that deploys listing clones on demand.
- Tracks the address of the current `Listing` implementation.
- `createListing(address landlord, uint256 fid, bytes32 castHash, bytes32 geohash, uint8 geohashPrecision,
  uint32 areaSqm, uint256 baseDailyRate, uint256 depositAmount, uint64 minBookingNotice,
  uint64 maxBookingWindow, string metadataURI)` deploys a clone, then calls
  `initialize(landlord, platform, bookingRegistry, sqmuToken, fid, castHash, geohash, geohashPrecision,
  areaSqm, baseDailyRate, depositAmount, minBookingNotice, maxBookingWindow, metadataURI)` on it.
- Emits `ListingCreated(listing, landlord)` for indexing.
- `updateImplementation(address newImpl)` (owner-only) swaps the template used for future
  clones.

### BookingRegistry (`BookingRegistry.sol`)
A shared calendar that enforces unit-level availability.
- Maintains per-listing reservations (bitmap, mapping, or similar structure).
- Authorised listings call `reserve(start, end)` / `release(start, end)` to block or free ranges.
- The platform owner can register listings and use `reserveFor` / `releaseFor` for administrative
  overrides, while non-whitelisted callers are rejected.
- Optionally exposes `isAvailable(listing, start, end)` for off-chain checks.

### r3nt-SQMU (`r3nt-SQMU.sol`)
An ERC-1155 collection (name: **r3nt-SQMU**, symbol: **SQMU-R**) representing investor positions in
each booking.
- Each booking uses a unique `tokenId` for minted SQMU-R tokens.
- `MINTER_ROLE` is granted to authorised listings so they can mint/burn SQMU-R for their bookings
  while `grantListingMinter`/`revokeListingMinter` stay restricted to MANAGER_ROLE holders (owner or
  platform).
- `setBaseURI` updates the metadata template and `lockTransfers(tokenId)` lets a listing freeze
  secondary trading once fundraising is complete.
- Metadata is generated off-chain using a URI template such as `https://api.r3nt.xyz/booking/{id}.json`.

### Listing (`Listing.sol`)
The per-property clone that handles bookings, deposit escrow, tokenisation and rent streaming.
- Initialised via `initialize(landlord, platform, bookingRegistry, sqmuToken, fid, castHash, geohash,
  geohashPrecision, areaSqm, baseDailyRate, depositAmount, minBookingNotice, maxBookingWindow,
  metadataURI)` which pulls USDC, module and metadata configuration from the platform.
- Stores references to the platform, booking registry, r3nt-SQMU token and USDC token alongside the
  landlord, deposit amount and base daily rate that drives rent calculations.
- Implements the full booking lifecycle, deposit split approvals, optional tokenisation,
  rent payments and investor claims.
- Persists rich property metadata including the landlord’s Farcaster fid, the canonical cast
  hash, a geohash of the coordinates, and the total property area in whole square metres for
  later tokenisation splits.
- Stores booking information in mappings keyed by `bookingId` to avoid gas-heavy arrays.
- Emits events so the subgraph/front-end can reconstruct bookings, investor positions and rent
  flows without on-chain iteration.

### Farcaster linkage & property metadata
- Listings keep the `(fid, castHash)` pair so the UI can build a "View full details on Farcaster"
  link using `buildFarcasterCastUrl(fid, castHash)`.
- Property size is captured during listing creation (`areaSqm`) to enable downstream sq.m based
  tokenisation math.
- Geohash strings are derived client-side from latitude/longitude and stored on-chain alongside
  their precision.

## Booking Lifecycle
### Booking
- `book(uint64 start, uint64 end)` checks availability through `BookingRegistry.reserve`,
  multiplies the configured daily rate by the stay duration, applies tenant/landlord fee basis
  points for reference and escrows the deposit in the listing contract.
- Booking data is stored against `bookingId` and `BookingCreated` is emitted.

### Deposit Escrow and Release
- After the stay, the landlord calls `proposeDepositSplit(bookingId, tenantBps)` to propose how
  the deposit should be divided.
- The platform (multi-sig) finalises via `confirmDepositSplit(bookingId, signature)`, releasing
  funds to tenant and landlord in the agreed proportions.

### Tokenisation (Optional)
- Landlord or tenant proposes tokenisation with `proposeTokenisation`, specifying
  `totalSqmu`, `pricePerSqmu`, `feeBps` and periodic rent cadence (`Period` enum).
- The platform approves via `approveTokenisation` to ensure the raise aligns with remaining
  rent expectations.
- Investors call `invest(bookingId, sqmuAmount)`; USDC is collected, the landlord receives
  proceeds minus platform fees, and `r3nt-SQMU` mints ERC-1155 SQMU-R tokens for
  `tokenId = bookingId`.
- Once all SQMU-R tokens sell, transfers can be locked to simplify future rent streaming.

### Rent Streaming
- Tenants make recurring payments with `payRent(bookingId, grossAmount)`, which collects tenant
  and landlord fees, forwards treasury fees when configured and accrues net rent to investors or
  the landlord.
- The contract updates `accRentPerSqmu = accRentPerSqmu + netAmount * 1e18 / totalSqmu` and
  each investor’s debt checkpoint.
- Investors withdraw via `claim(bookingId)` without requiring iteration over every holder.

### Cancellations & Defaults
- `cancelBooking(bookingId)` (landlord or platform) refunds the deposit when no rent has been
  paid and releases the calendar back to the registry.
- `handleDefault(bookingId)` lets the platform mark a stay as defaulted and route any escrowed
  deposit to investors/landlord through the existing accrual logic.

## State and Events
Bookings track tenant, start/end dates, rent, deposit, status, tokenisation parameters,
accumulator state and per-investor checkpoints:
```
enum Status { NONE, ACTIVE, COMPLETED, CANCELLED, DEFAULTED }
enum Period { NONE, WEEK, MONTH }
struct Booking {
    address tenant;
    uint64 start;
    uint64 end;
    uint256 rent;
    uint256 deposit;
    Status status;
    bool tokenised;
    uint256 totalSqmu;
    uint256 soldSqmu;
    uint256 pricePerSqmu;
    uint16 feeBps;
    Period period;
    address proposer;
    uint256 accRentPerSqmu;
    mapping(address => uint256) userDebt;
}
```

Key events emitted by `Listing.sol` include `BookingCreated`, `DepositSplitProposed`,
`DepositReleased`, `TokenisationProposed`, `TokenisationApproved`, `SQMUTokensMinted`,
`RentPaid`, `Claimed`, `BookingCancelled` and `BookingCompleted`.

## Implementation Plan
1. Deploy `r3nt-SQMU` and grant `MINTER_ROLE` to the entity that will authorise listing clones.
2. Deploy `BookingRegistry`, enabling it to record authorised listings.
3. Deploy the `Listing` implementation without initialising it.
4. Deploy `ListingFactory`, pointing it at the `Listing` implementation.
5. Deploy `Platform`, configuring the USDC address, fees and module addresses.
6. Have the platform call `createListing(landlord, fid, castHash, geohash, geohashPrecision,
   areaSqm, baseDailyRate, depositAmount, minBookingNotice, maxBookingWindow, metadataURI)` to
   clone and initialise new listings.
7. Update the front-end/subgraph to target the unified booking and tokenisation flows.

## Deploying from Remix IDE
The contracts in this repository are written for the OpenZeppelin UUPS upgradeability pattern, so
deploying them directly (without a proxy) causes every `initialize` call to revert. When using
Remix you must deploy the upgradeable modules behind an `ERC1967Proxy` and pass the initializer
payload during proxy construction. The outline below mirrors what a Hardhat/Foundry script would
perform on your behalf.

### 1. Prepare the workspace
1. Import the repository into Remix (for example via **File > Clone a Git repository**).
2. Open the **Solidity Compiler** tab, select compiler version **0.8.26** and enable the same
   optimizer settings you intend to use on-chain.
3. Compile the contracts you plan to deploy: `Listing.sol` (implementation), `ListingFactory.sol`,
   `BookingRegistry.sol`, `r3nt-SQMU.sol`, `Platform.sol` and the OpenZeppelin
   `ERC1967Proxy.sol` located at `@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol`.

### 2. Deploy logic contracts (implementations)
For every upgradeable contract (factory, registry, SQMU token, platform) click **Deploy** in Remix
to create the implementation contract. Take note of each implementation address — they are passed
to the proxy constructor and should **not** be interacted with directly afterwards.

### 3. Encode initializer calldata
1. Expand the freshly deployed implementation in the **Deployed Contracts** list.
2. Fill in the `initialize` arguments in the exact order expected by each module:
   - `Platform.initialize(owner, treasury, usdc, listingFactory, bookingRegistry, sqmuToken,
     tenantFeeBps, landlordFeeBps, listingCreationFee, viewPassPrice, viewPassDuration)`
   - `ListingFactory.initialize(owner, temporaryPlatform, listingImplementation)`
   - `BookingRegistry.initialize(owner, temporaryPlatform)`
   - `R3ntSQMU.initialize(owner, temporaryPlatform, baseURI)`
   The `temporaryPlatform` value can be your deployer address and will be updated once the platform
   proxy goes live.
3. Click the clipboard icon next to the `transact` button to copy the ABI-encoded calldata. Do not
   send the transaction — it will revert because the implementation was locked by
   `_disableInitializers()`.

### 4. Deploy the proxies
For each module create an `ERC1967Proxy` instance by supplying the implementation address and the
encoded initializer bytes copied in the previous step. The recommended order is:

1. Deploy `Listing.sol` (implementation only, no proxy required — clones call `initialize` later).
2. Deploy `ListingFactory`, `BookingRegistry` and `r3nt-SQMU` proxies.
3. Deploy the `Platform` proxy, passing the configuration and module addresses in the order listed
   above for `Platform.initialize`.

After every proxy is created, interact with it using the relevant ABI by selecting the contract in
Remix and clicking **At Address**, then pasting the proxy address.

### 5. Wire the modules to the platform
Because the factory, registry and SQMU token were initialised with a temporary platform address, use
your owner account to point them to the platform proxy once it exists:

1. Call `updatePlatform(platformProxy)` on the `ListingFactory` proxy.
2. Call `setPlatform(platformProxy)` on the `BookingRegistry` proxy.
3. Call `setPlatform(platformProxy)` on the `r3nt-SQMU` proxy.

Finally, double-check that `Platform.modules()` returns the proxy addresses you expect. At this
point you can call `Platform.createListing` to start cloning listings and proceed with normal
operations.

## Design Notes & Best Practices
- **USDC decimals** – all monetary values use 6 decimals to match the stablecoin.
- **UUPS upgradeability** – every upgradeable module must implement `_authorizeUpgrade`
  restricted to the platform owner/multi-sig and preserve storage gaps.
- **Multi-sig deposit release** – reuse ERC-7913 style signature verification to confirm
  deposit splits.
- **Roles & permissions** – tenants interact only with their bookings, landlords manage their
  listings, investors can invest and claim, and the platform executes administrative actions.
- **Off-chain metadata** – `r3nt-SQMU` URIs point to JSON generated off-chain describing the
  booking; keep on-chain state minimal and index events for analytics.
- **Client utilities** – the Mini App uses `tools.js` helpers to encode/decode geohashes,
  estimate cell sizes, normalise Farcaster cast hashes/URLs and assemble the Farcaster deep-link
  that corresponds to each listing’s stored `(fid, castHash)` pair.
