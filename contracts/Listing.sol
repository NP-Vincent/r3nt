// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * Listing (per-property deposit vault; clone target, upgradeable-style deps)
 *
 * Lifecycle (called by your r3nt core):
 *  - r3nt.book(): r3nt calls `arm(tenant, deposit)` then transfers `deposit` USDC to this vault.
 *  - Landlord proposes split via `propose(toTenant, toLandlord)` (sum must equal `deposit`).
 *  - Platform multisig confirms via `confirmRelease(signature)` (ERC-7913), vault pays out and resets.
 *
 * Roles:
 *  - DEFAULT_ADMIN_ROLE / ADMIN_ROLE: factory admin (can pause/sweep).
 *  - CORE_ROLE: r3nt core (allowed to arm/reset).
 *  - LANDLORD_ROLE: listing owner (allowed to propose).
 */

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {AccessControlEnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {SafeERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import {MultiSignerERC7913Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/signers/MultiSignerERC7913Upgradeable.sol";

contract Listing is
    Initializable,
    ReentrancyGuardUpgradeable,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    MultiSignerERC7913Upgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // -----------------------
    // Roles
    // -----------------------
    bytes32 public constant ADMIN_ROLE    = keccak256("ADMIN_ROLE");     // factory admin
    bytes32 public constant CORE_ROLE     = keccak256("CORE_ROLE");      // r3nt core
    bytes32 public constant LANDLORD_ROLE = keccak256("LANDLORD_ROLE");  // listing owner

    // -----------------------
    // State
    // -----------------------
    IERC20Upgradeable public token;   // USDC (or other allowed ERC-20)
    address public landlord;          // cached landlord
    address public tenant;            // active tenant for current booking
    uint96  public deposit;           // deposit expected/held (6d)

    // Proposal state
    uint96  public propTenant;
    uint96  public propLandlord;
    bool    public proposalSet;
    bool    public released;

    // Multisig replay guard
    uint256 public nonce;

    // -----------------------
    // Events
    // -----------------------
    event Initialized(address admin, address core, address landlord, address token);
    event Armed(address indexed tenant, uint96 deposit);
    event Proposed(uint96 toTenant, uint96 toLandlord);
    event Released(address indexed tenant, uint96 amtTenant, address indexed landlord, uint96 amtLandlord);
    event Swept(address to, uint256 amount);

    // -----------------------
    // Errors
    // -----------------------
    error ZeroAddress();
    error AlreadyReleased();
    error BadSum();
    error NoProposal();
    error NotFunded();
    error NotCore();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice One-time init by factory right after clone creation.
     * @param _admin   Factory address (gets DEFAULT_ADMIN_ROLE & ADMIN_ROLE).
     * @param _core    r3nt core address (gets CORE_ROLE).
     * @param _landlord Listing owner (gets LANDLORD_ROLE).
     * @param _platformAdmin Unused on-chain; platform signer identities are in `_signers`.
     * @param _token   ERC-20 token used for deposits (USDC).
     * @param _signers Platform multisig signer identities (ERC-7913 encoded).
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

        // Role setup
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(LANDLORD_ROLE, ADMIN_ROLE);
        _setRoleAdmin(CORE_ROLE, ADMIN_ROLE);

        _grantRole(CORE_ROLE, _core);
        _grantRole(LANDLORD_ROLE, _landlord);

        // Core params
        token    = IERC20Upgradeable(_token);
        landlord = _landlord;

        emit Initialized(_admin, _core, _landlord, _token);
        _platformAdmin; // silence unused param warning
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

        // reset proposal/release state
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

        // Ensure vault is funded with at least the deposit
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
        (d); // silence warning for some builds
    }

    // -----------------------
    // Admin
    // -----------------------

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
