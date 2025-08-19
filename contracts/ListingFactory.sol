// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * ListingFactory (UUPS, clone factory; upgradeable-style deps)
 *
 * - Deploys minimal proxy clones of `Listing` (the per-property deposit vault).
 * - Deterministic clone addresses using salt = keccak256(core, listingId).
 * - Maintains an allowlist of ERC-20 tokens (e.g., canonical USDC on Arbitrum).
 * - Intended to be called by your r3nt core when a landlord creates a listing.
 *
 * Remix flow:
 *   1) Deploy `Listing` (implementation) from Listing.sol
 *   2) Deploy `ListingFactory` proxy and call `initialize(impl)` with the Listing implementation address
 *   3) `setAllowedToken(USDC, true)`
 *   4) r3nt calls `createListing(...)` per property
 */

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {AccessControlEnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
// Imported for parity with your stack (not used directly here but kept for consistency):
import {MultiSignerERC7913Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/signers/MultiSignerERC7913Upgradeable.sol";

interface IListing {
    /**
     * Initialize the per-listing vault clone.
     * @param admin          Factory address (admin/pause/sweep authority).
     * @param core           r3nt core contract (authorized to arm/reset).
     * @param landlord       Listing owner (LANDLORD_ROLE).
     * @param platformAdmin  Platform controller (kept for parity; identities come via signers).
     * @param token          ERC-20 token used for deposits (e.g., USDC).
     * @param signers        ERC-7913 encoded signer identities.
     * @param threshold      Multisig threshold (e.g., 2).
     */
    function initialize(
        address admin,
        address core,
        address landlord,
        address platformAdmin,
        address token,
        bytes[] calldata signers,
        uint256 threshold
    ) external;
}

contract ListingFactory is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable
{
    using Clones for address;

    // -----------------------------
    // Roles
    // -----------------------------
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // -----------------------------
    // Storage
    // -----------------------------
    address public implementation;                      // Listing implementation (logic) to clone
    address[] private _listings;                        // All clones created
    mapping(address => bool) public allowedTokens;      // token allowlist (address(token) => allowed)
    mapping(bytes32 => address) public listingByKey;    // salt(core, listingId) => clone

    // -----------------------------
    // Events
    // -----------------------------
    event ListingCreated(
        address indexed listing,
        address indexed core,
        address indexed landlord,
        IERC20Upgradeable token,
        uint256 listingId
    );
    event ImplementationChanged(address implementation);
    event AllowedTokenSet(IERC20Upgradeable token, bool allowed);
    event ListingFactoryUpgraded(address newImplementation);

    // -----------------------------
    // Constructor / Initializer
    // -----------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initialize the factory with the Listing implementation address.
     */
    function initialize(address impl) external initializer {
        require(impl != address(0), "impl=0");
        __UUPSUpgradeable_init();
        __AccessControlEnumerable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        implementation = impl;

        // Admin setup
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);

        // Self-admin model
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    }

    // -----------------------------
    // Create / Predict
    // -----------------------------

    /**
     * @notice Predict the clone address for a given (core, listingId).
     */
    function predict(address core, uint256 listingId) external view returns (address predicted) {
        bytes32 salt = _salt(core, listingId);
        predicted = Clones.predictDeterministicAddress(implementation, salt, address(this));
    }

    /**
     * @notice Create a new Listing (vault) clone for a landlord's property.
     * Access: ADMIN_ROLE (typically your r3nt core’s privileged deployer/ops).
     *
     * @param core            r3nt core contract
     * @param landlord        listing owner
     * @param platformAdmin   platform controller (parity arg; not stored by Listing)
     * @param token           allowed deposit token (e.g., canonical USDC)
     * @param signers         ERC-7913 signer identities (for platform multisig)
     * @param threshold       signature threshold (>=1)
     * @param listingId       unique listing id (salt component)
     */
    function createListing(
        address core,
        address landlord,
        address platformAdmin,
        IERC20Upgradeable token,
        bytes[] calldata signers,
        uint256 threshold,
        uint256 listingId
    ) external whenNotPaused onlyRole(ADMIN_ROLE) nonReentrant returns (address listing) {
        require(core != address(0) && landlord != address(0) && platformAdmin != address(0), "zero addr");
        require(address(token) != address(0), "token=0");
        require(allowedTokens[address(token)], "token !allowed");
        require(threshold >= 1, "bad threshold");

        bytes32 salt = _salt(core, listingId);
        require(listingByKey[salt] == address(0), "exists");

        listing = implementation.cloneDeterministic(salt);

        IListing(listing).initialize(
            address(this),  // admin = factory
            core,
            landlord,
            platformAdmin,
            address(token),
            signers,
            threshold
        );

        _listings.push(listing);
        listingByKey[salt] = listing;

        emit ListingCreated(listing, core, landlord, token, listingId);
    }

    // -----------------------------
    // Admin ops
    // -----------------------------

    function setImplementation(address impl) external onlyRole(ADMIN_ROLE) {
        require(impl != address(0), "impl=0");
        implementation = impl;
        emit ImplementationChanged(impl);
    }

    function setAllowedToken(IERC20Upgradeable token, bool allowed) external onlyRole(ADMIN_ROLE) {
        allowedTokens[address(token)] = allowed;
        emit AllowedTokenSet(token, allowed);
    }

    function pause() external onlyRole(ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(ADMIN_ROLE) { _unpause(); }

    // -----------------------------
    // Views
    // -----------------------------

    function allListings() external view returns (address[] memory) {
        return _listings;
    }

    function listingOf(address core, uint256 listingId) external view returns (address) {
        return listingByKey[_salt(core, listingId)];
    }

    // -----------------------------
    // Internal
    // -----------------------------

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(ADMIN_ROLE) {
        emit ListingFactoryUpgraded(newImplementation);
    }

    function _salt(address core, uint256 listingId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(core, listingId));
    }
}
