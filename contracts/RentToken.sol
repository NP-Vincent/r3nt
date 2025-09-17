// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC1155Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import {ERC1155SupplyUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/extensions/ERC1155SupplyUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title RentToken
 * @notice ERC-1155 token representing fractional investor ownership in r3nt bookings.
 * @dev Upgradeable through UUPS. Listings granted the MINTER_ROLE may mint/burn their booking
 *      shares and optionally lock transfers once fundraising completes to simplify rent streaming.
 */
contract RentToken is
    Initializable,
    ERC1155Upgradeable,
    ERC1155SupplyUpgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    OwnableUpgradeable
{
    /// @notice Role allowed to administer minter permissions (owner + platform).
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    /// @notice Role granted to listing clones so they can mint/burn their booking shares.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Human readable token collection name (off-chain convenience).
    string public name;

    /// @notice Human readable token collection symbol (off-chain convenience).
    string public symbol;

    /// @notice Platform contract authorised to manage listing roles.
    address public platform;

    /// @dev Tracks whether transfers are locked for a given booking tokenId.
    mapping(uint256 => bool) private _transferLocked;

    /// @notice Initialization arguments for the rent token.
    struct InitializeParams {
        address owner; // Platform multi-sig controlling upgrades/configuration
        address platform; // Platform contract allowed to manage listing minters
        string name; // Collection name used off-chain
        string symbol; // Collection symbol used off-chain
        string baseURI; // Metadata URI template (expects {id} replacement)
    }

    event RentTokenInitialized(address indexed owner, address indexed platform, string uri);
    event PlatformUpdated(address indexed previousPlatform, address indexed newPlatform);
    event BaseURISet(string uri);
    event ListingMinterGranted(address indexed listing, address indexed caller);
    event ListingMinterRevoked(address indexed listing, address indexed caller);
    event TransferLocked(uint256 indexed tokenId, address indexed locker);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the rent token with admin authority and metadata URI template.
     * @param params Struct bundling initial configuration values.
     */
    function initialize(InitializeParams calldata params) external initializer {
        require(params.owner != address(0), "owner=0");

        __ERC1155_init(params.baseURI);
        __ERC1155Supply_init();
        __AccessControl_init();
        __Ownable_init();
        __UUPSUpgradeable_init();

        _transferOwnership(params.owner);

        name = params.name;
        symbol = params.symbol;

        _setRoleAdmin(MINTER_ROLE, MANAGER_ROLE);

        _grantRole(DEFAULT_ADMIN_ROLE, params.owner);
        _grantRole(MANAGER_ROLE, params.owner);

        address initialPlatform = params.platform;
        if (initialPlatform != address(0)) {
            platform = initialPlatform;
            _grantRole(MANAGER_ROLE, initialPlatform);
            emit PlatformUpdated(address(0), initialPlatform);
        }

        emit RentTokenInitialized(params.owner, initialPlatform, params.baseURI);
    }

    // -------------------------------------------------
    // Manager configuration
    // -------------------------------------------------

    /**
     * @notice Update the platform authority allowed to manage listing minters.
     * @param newPlatform Address of the platform contract (or zero to disable).
     */
    function setPlatform(address newPlatform) external onlyOwner {
        address previous = platform;
        if (previous != address(0)) {
            _revokeRole(MANAGER_ROLE, previous);
        }

        platform = newPlatform;

        if (newPlatform != address(0)) {
            _grantRole(MANAGER_ROLE, newPlatform);
        }

        emit PlatformUpdated(previous, newPlatform);
    }

    /**
     * @notice Update the base metadata URI template used for token ids.
     * @dev Uses the standard ERC-1155 {id} replacement format.
     * @param newURI New URI template string.
     */
    function setBaseURI(string calldata newURI) external onlyOwner {
        _setURI(newURI);
        emit BaseURISet(newURI);
    }

    // -------------------------------------------------
    // Listing minting permissions
    // -------------------------------------------------

    /**
     * @notice Grant minting rights to a listing clone so it can issue booking shares.
     * @param listing Listing contract address receiving MINTER_ROLE.
     */
    function grantListingMinter(address listing) external onlyRole(MANAGER_ROLE) {
        require(listing != address(0), "listing=0");
        grantRole(MINTER_ROLE, listing);
        emit ListingMinterGranted(listing, msg.sender);
    }

    /**
     * @notice Revoke minting rights from a listing clone.
     * @param listing Listing contract address losing MINTER_ROLE.
     */
    function revokeListingMinter(address listing) external onlyRole(MANAGER_ROLE) {
        require(listing != address(0), "listing=0");
        revokeRole(MINTER_ROLE, listing);
        emit ListingMinterRevoked(listing, msg.sender);
    }

    // -------------------------------------------------
    // Minting & burning
    // -------------------------------------------------

    /**
     * @notice Mint booking shares to an investor or distribution address.
     * @param to Recipient of the minted shares.
     * @param id Booking identifier used as the ERC-1155 token id.
     * @param amount Number of shares to mint.
     * @param data Optional calldata forwarded to the receiver hook.
     */
    function mint(address to, uint256 id, uint256 amount, bytes calldata data) external onlyRole(MINTER_ROLE) {
        require(!_transferLocked[id], "transfers locked");
        _mint(to, id, amount, data);
    }

    /**
     * @notice Mint multiple booking share ids in a single transaction.
     * @param to Recipient of the minted shares.
     * @param ids Array of booking identifiers.
     * @param amounts Array of share amounts corresponding to each id.
     * @param data Optional calldata forwarded to the receiver hook.
     */
    function mintBatch(
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external onlyRole(MINTER_ROLE) {
        for (uint256 i = 0; i < ids.length; ++i) {
            require(!_transferLocked[ids[i]], "transfers locked");
        }
        _mintBatch(to, ids, amounts, data);
    }

    /**
     * @notice Burn booking shares from an account. Callable by listing clones with MINTER_ROLE.
     * @param from Address holding the shares to burn.
     * @param id Booking identifier (token id).
     * @param amount Number of shares to burn.
     */
    function burn(address from, uint256 id, uint256 amount) external onlyRole(MINTER_ROLE) {
        _burn(from, id, amount);
    }

    /**
     * @notice Burn multiple booking share ids from an account.
     * @param from Address holding the shares to burn.
     * @param ids Array of booking identifiers.
     * @param amounts Array of amounts corresponding to each id.
     */
    function burnBatch(address from, uint256[] calldata ids, uint256[] calldata amounts)
        external
        onlyRole(MINTER_ROLE)
    {
        _burnBatch(from, ids, amounts);
    }

    // -------------------------------------------------
    // Transfer locking
    // -------------------------------------------------

    /**
     * @notice Permanently lock secondary transfers for a booking token id.
     * @dev Minting is disallowed once locked but burning remains permitted.
     * @param tokenId Booking identifier whose transfers are being locked.
     */
    function lockTransfers(uint256 tokenId) external onlyRole(MINTER_ROLE) {
        require(!_transferLocked[tokenId], "already locked");
        _transferLocked[tokenId] = true;
        emit TransferLocked(tokenId, msg.sender);
    }

    /**
     * @notice Returns whether transfers are locked for a given booking token id.
     * @param tokenId Booking identifier to inspect.
     */
    function isTransferLocked(uint256 tokenId) external view returns (bool) {
        return _transferLocked[tokenId];
    }

    // -------------------------------------------------
    // Internal hooks
    // -------------------------------------------------

    function _beforeTokenTransfer(
        address operator,
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory amounts,
        bytes memory data
    ) internal override(ERC1155Upgradeable, ERC1155SupplyUpgradeable) {
        if (from != address(0) && to != address(0)) {
            for (uint256 i = 0; i < ids.length; ++i) {
                require(!_transferLocked[ids[i]], "transfers locked");
            }
        }
        super._beforeTokenTransfer(operator, from, to, ids, amounts, data);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155Upgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    uint256[44] private __gap;
}
