# AGENTS.md

## Purpose
This document is for Codex that develops & works on this repository.  
It describes the context, architecture, and interaction patterns so Codex can:
- Understand the role of each component.
- Suggest improvements without breaking the upgradeable contract design.
- Troubleshoot errors from the Farcaster Mini App, RPC calls, or contract execution.

---

## Contract Overview
- **Contract Name**: `r3nt`
- **Standard**: OpenZeppelin UUPS Upgradeable
- **Network**: Arbitrum One
- **Token**: Canonical USDC (6 decimals)
- **Core Concepts**:
  - **Listings**: Landlords register properties with minimal on-chain data. ($1 USDC listing fee)
  - **View Pass**: Tenants pay $0.10 USDC for a 72h pass to browse listings.
  - **Booking**: Tenant books with rent + deposit. Platform charges 1% commission on rent.
  - **Escrow**: Deposit held in contract, landlord proposes split, platform (owner) confirms release.
  - **Off-chain details**: Farcaster `(fid, castHash)` link points to rich metadata (images, text).

---

## Roles
- **Landlord**  
  - Calls `createListing()` (after approving $1 fee in USDC).  
  - Can toggle listing active/inactive.  
  - Calls `markCompleted()` after rental.  
  - Calls `proposeDepositSplit()` to suggest deposit distribution.  

- **Tenant**  
  - Calls `buyViewPass()` (after approving $0.10 USDC).  
  - Can book active listings with `book()`.  
  - Pays: rent + platform fee + deposit.  
  - Rent → landlord, fee → platform, deposit → escrow.  

- **Platform (Owner)**  
  - Receives listing/view fees + 1% commission.  
  - Confirms deposit release with `confirmDepositRelease()`.  
  - Manages upgrades via UUPS.  

---

## Error Classes & Debugging
- **Frontend Errors**  
  - `"eth_call not supported"` → ensure reads use **RPC client** not injected provider.  
  - `"insufficient funds for gas + fee"` → user must top up ETH (L2 gas + L1 data).  
  - `"ERC20: insufficient allowance"` → tenant/landlord must `approve()` USDC before action.  
  - `"no view pass"` → tenant must buy/renew pass before booking.

- **Contract Reverts**  
  - `"bad geohash"` → string must match `geolen`.  
  - `"sum != deposit"` → landlord’s split does not match escrowed deposit.  
  - `"not landlord / not completed / bad status"` → caller role mismatch.  

---

## Best Practices for Codex Iteration
1. **Do not remove upgradeability**. Always preserve `_authorizeUpgrade()` and `__gap`.
2. **Keep on-chain data minimal**. Images, long descriptions → Farcaster cast.
3. **Respect USDC decimals** (6). Never assume 18 decimals in UI.
4. **Frontend reads** should use RPC (`createPublicClient`) not the wallet provider, which may block `eth_call`.
5. **Frontend writes** (transactions) must first call `approve()` for exact USDC required.
6. **Always test** with small values on Arbitrum testnets before mainnet.

---

## Iteration Guidance
When Codex sees errors in frontend logs:
- Check **approve/allowance** first for ERC20 transfers.  
- If UI shows `"Viewing only"` → provider not injected → must run inside Farcaster Mini App host.  
- For upgrade proposals: ensure **new implementation preserves storage layout**.  

---

