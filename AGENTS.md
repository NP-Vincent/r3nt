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
- Make ERC-1155 tokenisation optional for every booking; there is no separate SQMU contract.
- Stream rent to investors using an accumulator so the system never loops over all holders.
- Maintain a modular, upgradeable architecture built from `Platform`, `ListingFactory`,
  `Listing` clones, `BookingRegistry` and `RentToken`.

## Contract Modules & Responsibilities
### Platform (`Platform.sol`)
- Owns global configuration: USDC token address, tenant/landlord fee basis points, listing/view
  pricing and other shared parameters.
- Stores module addresses (`ListingFactory`, `BookingRegistry`, `RentToken`) and exposes them to
  the UI.
- Only the owner (platform multi-sig) can update configuration, set module addresses or approve
  upgrades via `_authorizeUpgrade`.
- Provides `createListing(address landlord, ListingParams params)` which delegates clone creation
  to the factory and emits `ListingCreated(listing, landlord)`.

### ListingFactory (`ListingFactory.sol`)
- Holds the address of the canonical `Listing` implementation.
- `createListing(landlord, params)` clones the implementation, calls
  `initialize(landlord, platform, bookingRegistry, rentToken, params)` and emits
  `ListingCreated` for indexers.
- Owner-only `updateImplementation(newImpl)` swaps the template used for future clones.

### BookingRegistry (`BookingRegistry.sol`)
- Maintains each listing’s reservation calendar (bitmap, mapping, etc.).
- Enforces access control so only an authorised listing (or the platform for emergency overrides)
  can `reserve` or `release` a range.
- Optionally exposes `isAvailable` for off-chain reads.

### RentToken (`RentToken.sol`)
- ERC-1155 token contract where each booking id maps to a unique `tokenId`.
- Grants `MINTER_ROLE` to listing clones so they can mint and burn shares.
- Allows a listing to `lockTransfers(tokenId)` after fundraising to simplify downstream rent
  streaming.
- Metadata is served from an off-chain URI template like `https://api.r3nt.xyz/booking/{id}.json`.

### Listing (`Listing.sol`)
- Cloneable per-property contract initialised with landlord, platform, registry and rent token
  addresses plus rate/deposit parameters.
- Handles the full lifecycle: booking, deposit escrow, landlord/platform approvals, optional
  tokenisation, rent payments, investor claims, cancellations and defaults.
- Stores bookings in mappings keyed by `bookingId` to avoid gas-heavy iteration.
- Emits events for every significant action so the front-end/subgraph can rebuild state off-chain.

## Booking & Tokenisation Flow
1. **Book** – `book(rt, units, start, end)` verifies availability via the `BookingRegistry`,
   calculates rent, applies tenant/landlord fees and escrows the deposit within the listing.
2. **Deposit management** – landlord proposes a split with `proposeDepositSplit(bookingId, tenantBps)`;
   the platform multi-sig finalises it through `confirmDepositSplit(bookingId, signature)`.
3. **Tokenisation (optional)** – landlord or tenant proposes parameters (`totalShares`,
   `pricePerShare`, `feeBps`, `Period`); the platform approves; investors `invest` and receive
   ERC-1155 shares minted by the listing.
4. **Rent streaming** – tenants call `payRent(bookingId, amount)` which updates the accumulator
   `accRentPerShare = accRentPerShare + amount * 1e18 / totalShares`. Investors call
   `claim(bookingId)` to withdraw accrued rent without loops.
5. **Cancellations & defaults** – the platform can `cancelBooking` before funding or
   `handleDefault` to allocate seized deposits/penalties to investors.

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
    uint256 totalShares;
    uint256 soldShares;
    uint256 pricePerShare;
    uint16 feeBps;
    Period period;
    address proposer;
    uint256 accRentPerShare;
    mapping(address => uint256) userDebt;
}
```

Key events to retain/emit: `BookingCreated`, `DepositSplitProposed`, `DepositReleased`,
`TokenisationProposed`, `TokenisationApproved`, `SharesMinted`, `RentPaid`, `Claimed`,
`BookingCancelled`, `BookingCompleted`.

## Implementation Plan Snapshot
1. Deploy `RentToken`; grant `MINTER_ROLE` to the authority that will register listings.
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

## Reference Materials
For legacy background, consult the historical contracts referenced in the Clean-Slate plan
(`r3nt.sol`, `r3nt-SQMU.sol`, `Listing.sol`, `RentDistribution.sol`, `BookingRegistry.sol`). The
Clean-Slate architecture supersedes them with the modular suite described above.
