# Clean-Slate Contract Build Tasks

This checklist organises the work required to implement the new `Platform`, `ListingFactory`, `BookingRegistry`, `RentToken` and `Listing` contracts described in the Clean-Slate plan. Follow the items in order so shared dependencies (interfaces, libraries, mocks) are available before downstream modules are wired together.

## 0. Shared Foundations
- [ ] Finalise canonical interfaces (`IPlatform`, `IListingFactory`, `IBookingRegistry`, `IRentToken`, `IListing`).
- [ ] Create shared types library for enums/structs (`Booking`, `Status`, `Period`).
- [ ] Decide upgradeability pattern (UUPS via OpenZeppelin upgradeable packages) and scaffold base contracts with storage gaps.
- [ ] Configure Foundry/Hardhat environment (dependencies, linting, fmt) for iterative testing.
- [ ] Implement role and modifier helpers (platform owner, authorised listing, landlord, tenant, investor).

## 1. `Platform.sol`
- [ ] Define immutable constants (fee denominator, 6-decimal scaling factors).
- [ ] Store addresses for USDC, `ListingFactory`, `BookingRegistry`, `RentToken`.
- [ ] Implement owner-only setters for global configuration (fees, prices, module addresses).
- [ ] Emit configuration update events for off-chain consumers.
- [ ] Integrate UUPS upgrade guard (`_authorizeUpgrade`) restricted to owner/multi-sig.
- [ ] Implement `createListing(address landlord, ListingParams calldata params)` delegating to factory and surfacing events.
- [ ] Add emergency admin functions (pause listings, update booking availability via registry proxies).
- [ ] Write Foundry tests covering configuration, authorization and listing creation flow.

## 2. `ListingFactory.sol`
- [ ] Store platform address and canonical `Listing` implementation.
- [ ] Implement clone creation (EIP-1167 minimal proxy) with `initialize` call.
- [ ] Expose `updateImplementation(address newImplementation)` restricted to owner/platform.
- [ ] Emit `ListingCreated` and indexable metadata (landlord, geohash, fid).
- [ ] Register new listing with `BookingRegistry` during initialization handshake.
- [ ] Unit-test clone deployment, access control and reinitialization protections.

## 3. `BookingRegistry.sol`
- [ ] Design storage for availability (bitmap vs mapping) with 6 decimal rent alignment.
- [ ] Create modifier restricting `reserve`, `release` and overrides to authorised listings/platform.
- [ ] Implement reservation lifecycle: reserve range, release range, query availability.
- [ ] Integrate emergency overrides (platform can unblock stuck bookings).
- [ ] Emit reservation events for indexing.
- [ ] Add internal helpers for date validation and range normalization.
- [ ] Unit-test range maths, access control and conflict detection.

## 4. `RentToken.sol`
- [ ] Inherit from `ERC1155Upgradeable` with role-based access (use `AccessControlUpgradeable`).
- [ ] Implement `MINTER_ROLE`, `DEFAULT_ADMIN_ROLE`, and optional transfer locks per `tokenId`.
- [ ] Wire metadata URI template (`https://api.r3nt.xyz/booking/{id}.json`) with override support.
- [ ] Provide hooks for listings to mint/burn shares tied to booking IDs.
- [ ] Implement `lockTransfers(tokenId)` / `unlockTransfers(tokenId)` toggles with events.
- [ ] Enforce that only authorised listings can mint/burn/lock tokens.
- [ ] Unit-test mint/burn, URI, transfer lock and role administration flows.

## 5. `Listing.sol`
- [ ] Define storage layout for bookings map keyed by `bookingId` with struct from Clean-Slate plan.
- [ ] Implement `initialize` with landlord, platform, registry, rent token, rate/deposit parameters, geohash, areaSqm, fid/cast hash.
- [ ] Enforce initializer guard (`initializer` modifier) and UUPS upgrade controls.
- [ ] Integrate `BookingRegistry` during `book` to check availability and reserve slots.
- [ ] Calculate rent using 6-decimal USDC, tenant/landlord fees from platform and deposit escrow logic.
- [ ] Handle deposit proposal, platform confirmation and release flows (including events).
- [ ] Implement optional tokenisation proposal, approval and ERC-1155 share minting.
- [ ] Manage rent streaming accumulator (`accRentPerShare`) and investor claim logic.
- [ ] Provide cancellation/default routines with platform oversight.
- [ ] Expose read helpers (`getBooking`, `previewRent`, `isTokenised`).
- [ ] Unit-test end-to-end scenarios (booking lifecycle, tokenisation, rent streaming, cancellations).

## 6. Cross-Module Integration
- [ ] Create deployment scripts: deploy registry, rent token, listing implementation, factory, platform.
- [ ] Write integration tests covering Platform→Factory→Listing pipeline.
- [ ] Document upgrade process and multi-sig actions required at each step.
- [ ] Produce runbook for emergency operations (pauses, overrides, defaults).

## 7. Tooling & Verification
- [ ] Configure CI to run linting, tests and coverage reports on PRs.
- [ ] Prepare Etherscan verification scripts (constructor args, proxy metadata).
- [ ] Draft developer documentation describing contract responsibilities and events for the front-end/subgraph teams.
