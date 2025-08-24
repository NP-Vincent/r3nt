# Deposit Release Flow

This document outlines how the r3nt contracts handle security deposit distribution after a booking completes.

## 1. Marking the Booking Complete
After the stay, the landlord calls `markCompleted` on the core `r3nt` contract. This sets the booking status to `Completed`, enabling further deposit actions.

## 2. Landlord Proposes a Split
The landlord suggests how the escrowed deposit should be split between tenant and landlord via `proposeDepositSplit(bookingId, toTenant, toLandlord)` on `r3nt`:

- Only the booking's landlord can call it.
- The booking must be marked `Completed`.
- The call forwards the proposal to the associated `Listing` vault.

The `Listing` contract's `propose` function enforces:
- The vault has not already released the deposit.
- `toTenant + toLandlord` equals the recorded deposit.
- The vault balance covers the deposit amount.

## 3. Platform Confirms and Releases
To finalize the release, the platform (contract owner) calls `confirmDepositRelease(bookingId, signature)` on `r3nt`:

- Only the platform owner can call it.
- Booking must still be `Completed`.
- The call forwards an ERC-7913 multisig `signature` to the `Listing` vault's `confirmRelease`.

In the `Listing` contract, `confirmRelease`:
- Verifies the provided signature against the proposed split.
- Transfers funds to tenant and landlord according to the proposal.
- Resets proposal data and marks the deposit as released.

Finally, `r3nt` marks the booking `Resolved` so the process cannot be repeated.

## Summary
1. **Landlord** marks booking complete and proposes a split.
2. **Platform** validates the proposal with an ERC-7913 signature and releases funds.
3. **Booking** transitions to `Resolved` and the deposit vault zeroes out its tracked deposit.
