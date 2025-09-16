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
- **Integrated tokenisation** – ERC-1155 shares can be minted for any booking without a
  separate SQMU contract.
- **Transparent deposit handling** – deposits sit in the listing escrow until a multi-sig
  release is confirmed by the platform.
- **Scalable rent streaming** – recurring rent is distributed via an accumulator pattern that
  avoids iterating over every investor.
- **Modular architecture** – `Platform`, `ListingFactory`, `Listing` clones,
  `BookingRegistry` and `RentToken` each focus on a single concern and can be upgraded
  independently through UUPS proxies.

## Module Architecture
### Platform (`Platform.sol`)
The platform contract owns global configuration and orchestrates listing creation.
- Stores the USDC address, tenant/landlord fee basis points and any additional pricing
  configuration (listing fee, view-pass price, etc.).
- Holds the addresses of the `ListingFactory`, `BookingRegistry` and `RentToken` so the UI can
  route calls correctly.
- Only the platform multi-sig may update parameters or authorise upgrades.
- `createListing(address landlord, ListingParams params)` requests the factory to clone a new
  listing and emits `ListingCreated(listing, landlord)`.

### ListingFactory (`ListingFactory.sol`)
A minimal proxy factory that deploys listing clones on demand.
- Tracks the address of the current `Listing` implementation.
- `createListing(address landlord, ListingParams params)` deploys a clone, then calls
  `initialize(landlord, platform, bookingRegistry, rentToken, params)` on it.
- Emits `ListingCreated(listing, landlord)` for indexing.
- `updateImplementation(address newImpl)` (owner-only) swaps the template used for future
  clones.

### BookingRegistry (`BookingRegistry.sol`)
A shared calendar that enforces unit-level availability.
- Maintains per-listing reservations (bitmap, mapping, or similar structure).
- Exposes `reserve(listing, start, end)` and `release(listing, start, end)` for listings to
  block or free ranges.
- Restricts writes so only the listing (or the platform for admin overrides) can manage its
  calendar.
- Optionally exposes `isAvailable(listing, start, end)` for off-chain checks.

### RentToken (`RentToken.sol`)
An ERC-1155 representing investor shares in a booking.
- Each booking uses a unique `tokenId` for minted shares.
- `MINTER_ROLE` is granted to authorised listings so they can mint/burn for their bookings.
- `lockTransfers(tokenId)` lets a listing freeze secondary trading once funding is complete.
- Metadata is generated off-chain using a URI template such as `https://api.r3nt.xyz/booking/{id}.json`.

### Listing (`Listing.sol`)
The per-property clone that handles bookings, deposit escrow, tokenisation and rent streaming.
- Initialised with landlord, platform, registry and rent token addresses plus pricing params.
- Implements the full booking lifecycle, deposit split approvals, optional tokenisation,
  rent payments and investor claims.
- Stores booking information in mappings keyed by `bookingId` to avoid gas-heavy arrays.
- Emits events so the subgraph/front-end can reconstruct bookings, investor positions and rent
  flows without on-chain iteration.

## Booking Lifecycle
### Booking
- `book(RateType rt, uint256 units, uint64 start, uint64 end)` checks availability through
  `BookingRegistry.reserve`, calculates rent, applies tenant/landlord fee basis points and
  escrows the deposit in the listing contract.
- Booking data is stored against `bookingId` and `BookingCreated` is emitted.

### Deposit Escrow and Release
- After the stay, the landlord calls `proposeDepositSplit(bookingId, tenantBps)` to propose how
  the deposit should be divided.
- The platform (multi-sig) finalises via `confirmDepositSplit(bookingId, signature)`, releasing
  funds to tenant and landlord in the agreed proportions.

### Tokenisation (Optional)
- Landlord or tenant proposes tokenisation with `proposeTokenisation`, specifying
  `totalShares`, `pricePerShare`, `feeBps` and periodic rent cadence (`Period` enum).
- The platform approves via `approveTokenisation` to ensure the raise aligns with remaining
  rent expectations.
- Investors call `invest(bookingId, shares)`; USDC is collected, the proposer receives proceeds
  minus platform fees, and `RentToken` mints ERC-1155 shares for `tokenId = bookingId`.
- Once all shares sell, transfers can be locked to simplify future rent streaming.

### Rent Streaming
- Tenants make recurring payments with `payRent(bookingId, amount)`.
- The contract updates `accRentPerShare = accRentPerShare + amount * 1e18 / totalShares` and
  each investor’s debt checkpoint.
- Investors withdraw via `claim(bookingId)` without requiring iteration over every holder.

### Cancellations & Defaults
- `cancelBooking(bookingId)` (platform-only) refunds rent and deposit before funding occurs.
- `handleDefault(bookingId, seizedAmount)` lets the platform allocate seized deposits or
  penalties to investors by updating the accumulator if rent is unpaid.

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

Key events emitted by `Listing.sol` include `BookingCreated`, `DepositSplitProposed`,
`DepositReleased`, `TokenisationProposed`, `TokenisationApproved`, `SharesMinted`, `RentPaid`,
`Claimed`, `BookingCancelled` and `BookingCompleted`.

## Implementation Plan
1. Deploy `RentToken` and grant `MINTER_ROLE` to the entity that will authorise listing clones.
2. Deploy `BookingRegistry`, enabling it to record authorised listings.
3. Deploy the `Listing` implementation without initialising it.
4. Deploy `ListingFactory`, pointing it at the `Listing` implementation.
5. Deploy `Platform`, configuring the USDC address, fees and module addresses.
6. Have the platform call `createListing(landlord, params)` to clone and initialise new
   listings.
7. Update the front-end/subgraph to target the unified booking and tokenisation flows.

## Design Notes & Best Practices
- **USDC decimals** – all monetary values use 6 decimals to match the stablecoin.
- **UUPS upgradeability** – every upgradeable module must implement `_authorizeUpgrade`
  restricted to the platform owner/multi-sig and preserve storage gaps.
- **Multi-sig deposit release** – reuse ERC-7913 style signature verification to confirm
  deposit splits.
- **Roles & permissions** – tenants interact only with their bookings, landlords manage their
  listings, investors can invest and claim, and the platform executes administrative actions.
- **Off-chain metadata** – `RentToken` URIs point to JSON generated off-chain describing the
  booking; keep on-chain state minimal and index events for analytics.

For historical context, the legacy contracts (`r3nt.sol`, `r3nt-SQMU.sol`, `Listing.sol`,
`RentDistribution.sol`) can be referenced in the upstream repository, but the Clean-Slate
architecture replaces them with the modular suite described above.
