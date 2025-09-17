// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title Platform
 * @notice Holds global configuration for the r3nt protocol and orchestrates listing creation.
 * @dev Upgradeable through the UUPS proxy pattern. The owner is expected to be a platform
 *      multi-sig which controls configuration updates and authorises upgrades.
 */
contract Platform is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    /// @dev Basis points denominator used for fee calculations.
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @dev Number of decimals expected from the USDC token (informational helper).
    uint8 public constant USDC_DECIMALS = 6;

    /// @notice Parameters forwarded to listing clones during initialization.
    struct ListingParams {
        uint256 fid; // Landlord Farcaster identifier (stored for deep-links)
        bytes32 castHash; // Canonical Farcaster cast hash (32-byte normalized form)
        bytes32 geohash; // Geospatial hash encoded as bytes32 (left-aligned, 0 padded)
        uint8 geohashPrecision; // Number of significant characters in the geohash
        uint32 areaSqm; // Property area in whole square metres
        uint256 baseDailyRate; // Base price per day denominated in USDC (6 decimals)
        uint256 depositAmount; // Security deposit denominated in USDC (6 decimals)
        uint64 minBookingNotice; // Minimum notice required before booking start (seconds)
        uint64 maxBookingWindow; // Maximum look-ahead window tenants can book (seconds)
        string metadataURI; // Off-chain metadata pointer (IPFS/HTTPS)
    }

    /// @notice Initialization arguments for the platform contract.
    struct InitializeParams {
        address owner; // Platform multi-sig that controls upgrades/configuration
        address treasury; // Fee sink receiving protocol fees
        address usdc; // Canonical USDC token address used for settlements
        address listingFactory; // Listing factory responsible for cloning listings
        address bookingRegistry; // Shared registry maintaining booking availability
        address sqmuToken; // ERC-1155 token contract handling investor SQMU-R positions
        uint16 tenantFeeBps; // Platform fee applied to tenants in basis points
        uint16 landlordFeeBps; // Platform fee applied to landlords in basis points
        uint256 listingCreationFee; // Fee charged for creating a listing (USDC, 6 decimals)
        uint256 viewPassPrice; // Optional price for premium listing views (USDC, 6 decimals)
    }

    /// @dev Minimal interface exposed by the listing factory.
    interface IListingFactory {
        function createListing(address landlord, ListingParams calldata params)
            external
            returns (address listing);
    }

    // -------------------------------------------------
    // Storage
    // -------------------------------------------------

    /// @notice Canonical USDC token used across the protocol.
    address public usdc;

    /// @notice Destination for protocol fees (may match the owner multi-sig).
    address public treasury;

    /// @notice Address of the ListingFactory contract responsible for deploying clones.
    address public listingFactory;

    /// @notice Address of the BookingRegistry shared by all listings.
    address public bookingRegistry;

    /// @notice Address of the r3nt-SQMU ERC-1155 contract used for investor SQMU-R positions.
    address public sqmuToken;

    /// @notice Platform fee applied to tenant rent payments (in basis points).
    uint16 public tenantFeeBps;

    /// @notice Platform fee applied to landlord proceeds (in basis points).
    uint16 public landlordFeeBps;

    /// @notice Fee charged when onboarding a new listing (denominated in USDC 6 decimals).
    uint256 public listingCreationFee;

    /// @notice Optional price for purchasing premium listing views (denominated in USDC 6 decimals).
    uint256 public viewPassPrice;

    /// @notice Total number of listings created through the platform.
    uint256 public listingCount;

    /// @dev Tracks whether an address corresponds to a registered listing clone.
    mapping(address => bool) public isListing;

    /// @dev Mapping from sequential listing identifier to the deployed listing address.
    mapping(uint256 => address) public listingById;

    /// @dev Reverse lookup from listing address to its sequential identifier.
    mapping(address => uint256) public listingIds;

    /// @dev Storage for iterating listings off-chain when necessary.
    address[] private _listings;

    // -------------------------------------------------
    // Events
    // -------------------------------------------------

    event PlatformInitialized(address indexed owner, address indexed usdc, address indexed treasury);
    event UsdcUpdated(address indexed previousUsdc, address indexed newUsdc);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event ModulesUpdated(address indexed listingFactory, address indexed bookingRegistry, address indexed sqmuToken);
    event FeesUpdated(uint16 tenantFeeBps, uint16 landlordFeeBps);
    event ListingPricingUpdated(uint256 listingCreationFee, uint256 viewPassPrice);
    event ListingRegistered(address indexed listing, address indexed landlord, uint256 indexed listingId);

    // -------------------------------------------------
    // Constructor / Initializer
    // -------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the platform configuration. Intended to be called exactly once through the proxy.
     * @param params Struct bundling initial configuration values.
     */
    function initialize(InitializeParams calldata params) external initializer {
        require(params.owner != address(0), "owner=0");
        require(params.usdc != address(0), "usdc=0");

        __Ownable_init();
        __UUPSUpgradeable_init();

        _setUsdc(params.usdc);
        _setTreasury(params.treasury);
        _setModules(params.listingFactory, params.bookingRegistry, params.sqmuToken);
        _setFees(params.tenantFeeBps, params.landlordFeeBps);
        _setListingPricing(params.listingCreationFee, params.viewPassPrice);

        _transferOwnership(params.owner);

        emit PlatformInitialized(params.owner, params.usdc, params.treasury);
    }

    // -------------------------------------------------
    // External configuration setters (owner-only)
    // -------------------------------------------------

    function setUsdc(address newUsdc) external onlyOwner {
        require(newUsdc != address(0), "usdc=0");
        _setUsdc(newUsdc);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        _setTreasury(newTreasury);
    }

    function setModules(
        address newListingFactory,
        address newBookingRegistry,
        address newSqmuToken
    ) external onlyOwner {
        _setModules(newListingFactory, newBookingRegistry, newSqmuToken);
    }

    function setFees(uint16 newTenantFeeBps, uint16 newLandlordFeeBps) external onlyOwner {
        _setFees(newTenantFeeBps, newLandlordFeeBps);
    }

    function setListingPricing(uint256 newListingCreationFee, uint256 newViewPassPrice) external onlyOwner {
        _setListingPricing(newListingCreationFee, newViewPassPrice);
    }

    // -------------------------------------------------
    // Listing orchestration
    // -------------------------------------------------

    /**
     * @notice Create a new listing clone via the configured factory.
     * @param landlord Address of the landlord controlling the new listing.
     * @param params Listing configuration parameters forwarded to the clone.
     * @return listing Address of the newly deployed listing clone.
     */
    function createListing(address landlord, ListingParams calldata params)
        external
        onlyOwner
        returns (address listing)
    {
        require(landlord != address(0), "landlord=0");
        require(listingFactory != address(0), "factory=0");
        require(bookingRegistry != address(0), "registry=0");
        require(sqmuToken != address(0), "sqmuToken=0");

        listing = IListingFactory(listingFactory).createListing(landlord, params);
        require(listing != address(0), "listing=0");
        require(!isListing[listing], "already registered");

        uint256 listingId = ++listingCount;
        isListing[listing] = true;
        listingById[listingId] = listing;
        listingIds[listing] = listingId;
        _listings.push(listing);

        emit ListingRegistered(listing, landlord, listingId);
    }

    // -------------------------------------------------
    // View helpers
    // -------------------------------------------------

    function fees() external view returns (uint16 tenantBps, uint16 landlordBps) {
        return (tenantFeeBps, landlordFeeBps);
    }

    function modules()
        external
        view
        returns (
            address currentListingFactory,
            address currentBookingRegistry,
            address currentSqmuToken
        )
    {
        return (listingFactory, bookingRegistry, sqmuToken);
    }

    function allListings() external view returns (address[] memory) {
        return _listings;
    }

    // -------------------------------------------------
    // Internal setters (no access control)
    // -------------------------------------------------

    function _setUsdc(address newUsdc) internal {
        address previous = usdc;
        usdc = newUsdc;
        emit UsdcUpdated(previous, newUsdc);
    }

    function _setTreasury(address newTreasury) internal {
        address previous = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(previous, newTreasury);
    }

    function _setModules(
        address newListingFactory,
        address newBookingRegistry,
        address newSqmuToken
    ) internal {
        listingFactory = newListingFactory;
        bookingRegistry = newBookingRegistry;
        sqmuToken = newSqmuToken;
        emit ModulesUpdated(newListingFactory, newBookingRegistry, newSqmuToken);
    }

    function _setFees(uint16 newTenantFeeBps, uint16 newLandlordFeeBps) internal {
        require(newTenantFeeBps <= BPS_DENOMINATOR, "tenant bps too high");
        require(newLandlordFeeBps <= BPS_DENOMINATOR, "landlord bps too high");
        require(newTenantFeeBps + newLandlordFeeBps <= BPS_DENOMINATOR, "fee sum too high");
        tenantFeeBps = newTenantFeeBps;
        landlordFeeBps = newLandlordFeeBps;
        emit FeesUpdated(newTenantFeeBps, newLandlordFeeBps);
    }

    function _setListingPricing(uint256 newListingCreationFee, uint256 newViewPassPrice) internal {
        listingCreationFee = newListingCreationFee;
        viewPassPrice = newViewPassPrice;
        emit ListingPricingUpdated(newListingCreationFee, newViewPassPrice);
    }

    // -------------------------------------------------
    // UUPS authorization hook
    // -------------------------------------------------

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // -------------------------------------------------
    // Storage gap for upgradeability
    // -------------------------------------------------

    uint256[38] private __gap;
}
