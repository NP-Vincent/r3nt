// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * Single file containing:
 *  - Listing (per-property deposit vault; minimal clone target)
 *  - ListingFactory (UUPS; deploys deterministic clones of Listing)
 *
 * Remix flow:
 *   1) Compile this file.
 *   2) In the "Contract" dropdown you'll see BOTH `Listing` and `ListingFactory`.
 *   3) Deploy `Listing` first (this is the implementation).
 *   4) Deploy `ListingFactory` and pass the deployed `Listing` address to `initialize(impl)`.
 *   5) Call `setAllowedToken(USDC, true)` on the factory.
 *   6) Your r3nt core will then call `ListingFactory.createListing(...)` per new property.
 */

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {AccessControlEnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MultiSignerERC7913Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/signers/MultiSignerERC7913Upgradeable.sol";

/* =========================================================================
 *                                LISTING
 * =========================================================================
 *
 * Per-property deposit vault (clone target).
 * Lifecycle: r3nt.book() -> r3nt arms vault (tenant, deposit) & transfers deposit in;
 *            landlord proposes split -> platform multisig confirms (signature) -> funds released.
 */

contract Listing is
    Initializable,
    ReentrancyGuardUpgradeable,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    MultiSignerERC7913Upgradeable
{
    using SafeERC20 for IERC20;

    // Roles
    bytes32 public constant ADMIN_ROLE    = keccak256("ADMIN_ROLE");     // factory admin
    bytes32 public constant CORE_ROLE     = keccak256("CORE_ROLE");      // r3nt core
    bytes32 public constant LANDLORD_ROLE = keccak256("LANDLORD_ROLE");  // listing owner

    // State
    IERC20  public token;         // USDC (or allowed ERC-20)
    address public landlord;      // cached landlord
    address public tenant;        // active tenant (for current booking)
    uint96  public deposit;       // deposit expected/held

    // Proposal
    uint96  public propTenant;
    uint96  public propLandlord;
    bool    public proposalSet;
    bool    public released;

    // Multisig replay guard
    uint256 public nonce;

    // Events
    event Initialized(address admin, address core, address landlord, address token);
    event Armed(address indexed tenant, uint96 deposit);
    event Proposed(uint96 toTenant, uint96 toLandlord);
    event Released(address indexed tenant, uint96 amtTenant, address indexed landlord, uint96 amtLandlord);
    event Swept(address to, uint256 amount);

    // Errors
    error ZeroAddress();
    error AlreadyReleased();
    error BadSum();
    error NoProposal();
    error NotFunded();
    error NotCore();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /**
     * @notice One-time init by factory right after clone creation.
     * @param _admin   Factory address (gets DEFAULT_ADMIN_ROLE & ADMIN_ROLE).
     * @param _core    r3nt core address (gets CORE_ROLE).
     * @param _landlord Listing owner (gets LANDLORD_ROLE).
     * @param _platformAdmin (unused on-chain; your multisig identities are in `_signers`).
     * @param _token   ERC-20 token used for deposits (USDC).
     * @param _signers Multi-signer identities (ERC-7913 encoded) representing the platform.
     * @param _threshold Number of required signatures (e.g., 2).
     */
    function initialize(
        address _admin,
        address _core,
        address _landlord,
        address _platformAdmin, // kept for parity, not stored
        address _token,
        bytes[] calldata _signers,
        uint256 _threshold
    ) external initializer {
        if (_admin == address(0) || _core == address(0) || _landlord == address(0) || _token == address(0)) revert ZeroAddress();

        __ReentrancyGuard_init();
        __AccessControlEnumerable_init();
        __Pausable_init();
        __MultiSignerERC7913_init(_signers, _threshold);

        // Roles
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(LANDLORD_ROLE, ADMIN_ROLE);
        _setRoleAdmin(CORE_ROLE, ADMIN_ROLE);

        _grantRole(CORE_ROLE, _core);
        _grantRole(LANDLORD_ROLE, _landlord);

        // Core params
        token    = IERC20(_token);
        landlord = _landlord;

        emit Initialized(_admin, _core, _landlord, _token);
    }

    /**
     * @notice Arm the vault for a new booking (r3nt core only).
     *         Core must transfer `deposit` tokens to this vault separately.
     */
    function arm(address _tenant, uint96 _deposit) external {
        if (!hasRole(CORE_ROLE, msg.sender)) revert NotCore();
        if (_tenant == address(0)) revert ZeroAddress();

        tenant   = _tenant;
        deposit  = _deposit;

        // reset proposal/release state for the new booking
        propTenant = 0;
        propLandlord = 0;
        proposalSet = false;
        released = false;

        emit Armed(_tenant, _deposit);
    }

    /**
     * @notice Landlord proposes a split that must equal `deposit`.
     */
    function propose(uint96 toTenant, uint96 toLandlord) external onlyRole(LANDLORD_ROLE) whenNotPaused {
        if (released) revert AlreadyReleased();
        if (uint256(toTenant) + uint256(toLandlord) != uint256(deposit)) revert BadSum();
        if (token.balanceOf(address(this)) < uint256(deposit)) revert NotFunded();

        propTenant = toTenant;
        propLandlord = toLandlord;
        proposalSet = true;

        emit Proposed(toTenant, toLandlord);
    }

    /**
     * @notice Platform multisig confirms via ERC-7913 signature.
     * Anyone can submit as long as signatures are valid.
     *
     * Signed hash:
     *   keccak256(abi.encodePacked(
     *     bytes32("DEPOSIT_RELEASE"),
     *     address(this),
     *     tenant,
     *     landlord,
     *     propTenant,
     *     propLandlord,
     *     nonce
     *   ))
     */
    function confirmRelease(bytes calldata signature) external nonReentrant whenNotPaused {
        if (released) revert AlreadyReleased();
        if (!proposalSet) revert NoProposal();

        bytes32 h = keccak256(abi.encodePacked(
            bytes32("DEPOSIT_RELEASE"),
            address(this),
            tenant,
            landlord,
            propTenant,
            propLandlord,
            nonce
        ));
        require(_rawSignatureValidation(h, signature), "invalid signature");

        // Effects
        released = true;
        proposalSet = false;
        uint96 toT = propTenant;
        uint96 toL = propLandlord;
        uint96 d = deposit;
        propTenant = 0;
        propLandlord = 0;
        deposit = 0;
        nonce += 1;

        // Defensive balance check
        require(token.balanceOf(address(this)) >= uint256(toT) + uint256(toL), "insufficient vault bal");

        // Interactions
        if (toT > 0) token.safeTransfer(tenant, toT);
        if (toL > 0) token.safeTransfer(landlord, toL);

        emit Released(tenant, toT, landlord, toL);
        // Invariant: toT + toL == d
        (d); // silence warning if unused in builds
    }

    // Admin
    function pause() external onlyRole(ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(ADMIN_ROLE) { _unpause(); }

    /// @notice Emergency recovery; only while paused.
    function sweep(address to) external onlyRole(ADMIN_ROLE) whenPaused {
        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) {
            token.safeTransfer(to, bal);
            emit Swept(to, bal);
        }
    }
}

/* =========================================================================
 *                             LISTING FACTORY
 * =========================================================================
 *
 * UUPS upgradeable factory that deploys deterministic clones of `Listing`.
 * Salt = keccak256(core, listingId), so the address is predictable.
 */

interface IListing {
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

    using SafeERC20 for IERC20; // kept for parity/future use

    // Roles
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // Storage
    address public implementation;                      // Listing implementation to clone
    address[] private _listings;                        // All clones created
    mapping(address => bool) public allowedTokens;      // token allowlist
    mapping(bytes32 => address) public listingByKey;    // salt(core, listingId) => clone

    // Events
    event ListingCreated(
        address indexed listing,
        address indexed core,
        address indexed landlord,
        IERC20 token,
        uint256 listingId
    );
    event ImplementationChanged(address implementation);
    event AllowedTokenSet(IERC20 token, bool allowed);
    event ListingFactoryUpgraded(address newImplementation);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

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
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
    }

    // Predict
    function predict(address core, uint256 listingId) external view returns (address predicted) {
        bytes32 salt = _salt(core, listingId);
        predicted = Clones.predictDeterministicAddress(implementation, salt, address(this));
    }

    // Create
    function createListing(
        address core,
        address landlord,
        address platformAdmin,
        IERC20 token,
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

    // Admin ops
    function setImplementation(address impl) external onlyRole(ADMIN_ROLE) {
        require(impl != address(0), "impl=0");
        implementation = impl;
        emit ImplementationChanged(impl);
    }

    function setAllowedToken(IERC20 token, bool allowed) external onlyRole(ADMIN_ROLE) {
        allowedTokens[address(token)] = allowed;
        emit AllowedTokenSet(token, allowed);
    }

    function pause() external onlyRole(ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(ADMIN_ROLE) { _unpause(); }

    // Views
    function allListings() external view returns (address[] memory) { return _listings; }
    function listingOf(address core, uint256 listingId) external view returns (address) { return listingByKey[_salt(core, listingId)]; }

    // Internals
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(ADMIN_ROLE) {
        emit ListingFactoryUpgraded(newImplementation);
    }
    function _salt(address core, uint256 listingId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(core, listingId));
    }
}
