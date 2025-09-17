# AGENTS.md

## Purpose
This repository hosts the Clean-Slate rebuild of the r3nt smart-contract suite. Use this document to
align any code or documentation changes with the new architecture so that future implementation
work remains consistent, upgradeable and easy to reason about.

## Clean-Slate Objectives
- Merge short-term bookings and tokenised bookings into a single `Listing` flow.
- Operate strictly on **USDC (6 decimals)** with tenant and landlord fee basis points applied by the
  platform.
- Keep deposits escrowed inside each listing and require platform (multi-sig) confirmation before
  releasing funds.
- Make ERC-1155 tokenisation optional for every booking through the r3nt-SQMU (SQMU-R) token.
- Stream rent to investors using an accumulator so the system never loops over all holders.
- Maintain a modular, upgradeable architecture built from `Platform`, `ListingFactory`,
  `Listing` clones, `BookingRegistry` and `r3nt-SQMU`.

## Contract Modules & Responsibilities
### Platform (`Platform.sol`)
- Owns global configuration: USDC token address, tenant/landlord fee basis points, listing/view
  pricing and other shared parameters.
- Stores module addresses (`ListingFactory`, `BookingRegistry`, `r3nt-SQMU`) and exposes them to
  the UI.
- Only the owner (platform multi-sig) can update configuration, set module addresses or approve
  upgrades via `_authorizeUpgrade` and owner-only setters (`setTreasury`, `setFees`,
  `setListingPricing`, `setModules`, `setUsdc`).
- View helpers like `modules()` and `fees()` expose the current configuration to off-chain
  consumers.
- Provides `createListing(address landlord, ListingParams params)` which delegates clone creation
  to the factory and emits `ListingCreated(listing, landlord)`.

### ListingFactory (`ListingFactory.sol`)
- Holds the address of the canonical `Listing` implementation.
- `createListing(landlord, params)` clones the implementation, calls
  `initialize(landlord, platform, bookingRegistry, sqmuToken, params)` and emits
  `ListingCreated` for indexers.
- Owner-only `updateImplementation(newImpl)` swaps the template used for future clones.

### BookingRegistry (`BookingRegistry.sol`)
- Maintains each listing’s reservation calendar (bitmap, mapping, etc.).
- Enforces access control so only an authorised listing can `reserve(start, end)` or
  `release(start, end)` for its own calendar, while the owner/platform may call
  `reserveFor`/`releaseFor` for emergency overrides.
- Optionally exposes `isAvailable` for off-chain reads.

### r3nt-SQMU (`r3nt-SQMU.sol`)
- ERC-1155 token contract (name: **r3nt-SQMU**, symbol: **SQMU-R**) where each booking id maps to a
  unique `tokenId`.
- Grants `MINTER_ROLE` to listing clones so they can mint and burn SQMU-R tokens, managed by
  MANAGER_ROLE holders (owner/platform).
- Owner can update metadata via `setBaseURI`, while token ids continue to match their
  corresponding booking ids.
- Allows a listing to `lockTransfers(tokenId)` after fundraising to simplify downstream rent
  streaming.
- Metadata is served from an off-chain URI template like `https://api.r3nt.xyz/booking/{id}.json`.

### Listing (`Listing.sol`)
- Cloneable per-property contract initialised with landlord, platform, registry and r3nt-SQMU
  token addresses plus pricing/metadata parameters via `initialize(landlord, platform,
  bookingRegistry, sqmuToken, params)`.
- Stores references to the platform, booking registry, r3nt-SQMU token and USDC token for
  subsequent fee pulls, registry access and SQMU-R issuance.
- Handles the full lifecycle: booking, deposit escrow, landlord/platform approvals, optional
  tokenisation, rent payments, investor claims, cancellations and defaults.
- Stores bookings in mappings keyed by `bookingId` to avoid gas-heavy iteration.
- Emits events for every significant action so the front-end/subgraph can rebuild state off-chain.

## Booking & Tokenisation Flow
1. **Book** – `book(start, end)` verifies availability via the `BookingRegistry`, multiplies the
   configured daily rate by the stay duration, records expected net rent after platform fees and
   escrows the deposit within the listing.
2. **Deposit management** – landlord proposes a split with `proposeDepositSplit(bookingId, tenantBps)`;
   the platform multi-sig finalises it through `confirmDepositSplit(bookingId, signature)`.
3. **Tokenisation (optional)** – landlord or tenant proposes parameters (`totalSqmu`,
   `pricePerSqmu`, `feeBps`, `Period`); the platform approves; investors `invest` and receive
   ERC-1155 SQMU-R tokens minted by the listing while proceeds (minus platform fee) flow to the landlord.
4. **Rent streaming** – tenants call `payRent(bookingId, grossAmount)` which deducts tenant and
   landlord platform fees, forwards treasury fees when configured and updates the accumulator
   `accRentPerSqmu = accRentPerSqmu + netAmount * 1e18 / totalSqmu`. Investors call
   `claim(bookingId)` to withdraw accrued rent without loops.
5. **Cancellations & defaults** – the landlord or platform can `cancelBooking` before any rent is
   paid (refunding the tenant’s deposit), while the platform can `handleDefault` to mark a stay as
   defaulted and route deposits through the same accrual mechanism used for rent.

## Booking State & Events
Bookings use the following core structure and status enums:
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

Key events to retain/emit: `BookingCreated`, `DepositSplitProposed`, `DepositReleased`,
`TokenisationProposed`, `TokenisationApproved`, `SQMUTokensMinted`, `RentPaid`, `Claimed`,
`BookingCancelled`, `BookingCompleted`.

## Implementation Plan Snapshot
1. Deploy `r3nt-SQMU`; grant `MINTER_ROLE` to the authority that will register listings.
2. Deploy `BookingRegistry` and wire allow-lists for authorised listings.
3. Deploy the `Listing` implementation (uninitialised).
4. Deploy `ListingFactory` pointing to the implementation.
5. Deploy `Platform`, configure USDC and module addresses.
6. Platform calls `createListing(landlord, params)` to initialise each property clone.
7. Update front-end/subgraph integrations to the new module addresses.

## Design Notes & Constraints
- **Upgradeability** – every upgradeable module must inherit from `UUPSUpgradeable`, protect
  `_authorizeUpgrade` with `onlyOwner` and maintain storage gaps.
- **Deposits** – continue to use multi-sig/ERC-7913 signature verification when confirming splits.
- **Roles** – enforce permissions for landlord, tenant, investor and platform flows as described
  above; never expose unrestricted reserve/release/tokenisation endpoints.
- **Data hygiene** – keep on-chain storage minimal and rely on events + off-chain metadata for rich
  detail. All monetary values stay in 6-decimal USDC.
- **Testing** – there are no automated scripts in this repository. Run targeted Foundry/Hardhat
  tests locally when you modify Solidity contracts, or provide reasoning if tests are not run.
- **Farcaster linkage** – listings must retain the landlord’s fid and cast hash. Front-end helpers
  (`tools.js`) normalise incoming hashes and build the "View full details on Farcaster" deep-link
  via `buildFarcasterCastUrl` so Mini App users can jump back to the canonical cast.
- **Geospatial metadata** – derive/stash geohashes for every listing and leverage the helper
  functions to encode/decode them or estimate cell sizes when mapping properties.
- **Square metre area** – capture `areaSqm` during listing creation to support sq.m-driven
  tokenisation strategies on future upgrades.

## Reference Materials
For legacy background, consult the historical contracts referenced in the Clean-Slate plan
(`r3nt-ignore-deprecated.sol`, `r3nt-SQMU-ignore-deprecated.sol`, `Listing-ignore-deprecated.sol`, `RentDistribution-ignore-deprecated.sol`, `BookingRegistry-ignore-deprecated.sol`). The
Clean-Slate architecture supersedes them with the modular suite described above.
