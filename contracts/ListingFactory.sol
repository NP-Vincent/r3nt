// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ClonesUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/ClonesUpgradeable.sol";

import {Platform} from "./Platform.sol";

/// @dev Minimal interface for Listing clones.
interface IListing {
    function initialize(
        address landlord,
        address platform,
        address bookingRegistry,
        address sqmuToken,
        uint256 fid,
        bytes32 castHash,
        bytes32 geohash,
        uint8 geohashPrecision,
        uint32 areaSqm,
        uint256 baseDailyRate,
        uint256 depositAmount,
        uint64 minBookingNotice,
        uint64 maxBookingWindow,
        string calldata metadataURI
    ) external;
}

/**
 * @title ListingFactory
 * @notice Deploys clone instances of the Listing contract and wires them to protocol modules.
 * @dev Upgradeable through the UUPS pattern. The factory is owned by the platform multi-sig which
 *      may update the Listing implementation or the authorised platform caller.
 */
contract ListingFactory is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    using ClonesUpgradeable for address;

    // -------------------------------------------------
    // Storage
    // -------------------------------------------------

    /// @notice Address of the canonical Listing implementation used for cloning.
    address public listingImplementation;

    /// @notice Platform contract authorised to call createListing.
    address public platform;

    // -------------------------------------------------
    // Events
    // -------------------------------------------------

    event ListingFactoryInitialized(address indexed owner, address indexed platform, address indexed implementation);
    event PlatformUpdated(address indexed previousPlatform, address indexed newPlatform);
    event ListingImplementationUpdated(address indexed previousImplementation, address indexed newImplementation);
    event ListingCreated(address indexed listing, address indexed landlord);

    // -------------------------------------------------
    // Constructor / Initializer
    // -------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the factory with the platform authority and Listing implementation.
     * @param owner_ Platform multi-sig controlling upgrades and configuration.
     * @param platform_ Platform contract authorised to request new listings.
     * @param implementation_ Canonical Listing implementation to clone.
     */
    function initialize(address owner_, address platform_, address implementation_) external initializer {
        require(owner_ != address(0), "owner=0");
        require(platform_ != address(0), "platform=0");
        require(implementation_ != address(0), "impl=0");

        __Ownable_init(owner_);
        __UUPSUpgradeable_init();

        platform = platform_;
        listingImplementation = implementation_;

        emit PlatformUpdated(address(0), platform_);
        emit ListingImplementationUpdated(address(0), implementation_);
        emit ListingFactoryInitialized(owner_, platform_, implementation_);
    }

    // -------------------------------------------------
    // Configuration (owner-only)
    // -------------------------------------------------

    function updatePlatform(address newPlatform) external onlyOwner {
        require(newPlatform != address(0), "platform=0");
        address previous = platform;
        platform = newPlatform;
        emit PlatformUpdated(previous, newPlatform);
    }

    function updateImplementation(address newImplementation) external onlyOwner {
        require(newImplementation != address(0), "impl=0");
        address previous = listingImplementation;
        listingImplementation = newImplementation;
        emit ListingImplementationUpdated(previous, newImplementation);
    }

    // -------------------------------------------------
    // Listing creation
    // -------------------------------------------------

    /**
     * @notice Deploy a new Listing clone for the provided landlord.
     * @param landlord Address that will control the newly created listing.
     * @param fid Landlord Farcaster identifier stored for deep links.
     * @param castHash Canonical Farcaster cast hash (32-byte normalized form).
     * @param geohash Geospatial hash encoded as bytes32 (left-aligned, zero padded).
     * @param geohashPrecision Number of significant characters in the geohash.
     * @param areaSqm Property area in whole square metres.
     * @param baseDailyRate Base price per day denominated in USDC (6 decimals).
     * @param depositAmount Security deposit denominated in USDC (6 decimals).
     * @param minBookingNotice Minimum notice required before booking start (seconds).
     * @param maxBookingWindow Maximum look-ahead window tenants can book (seconds).
     * @param metadataURI Off-chain metadata pointer (HTTPS).
     * @return listing Address of the freshly deployed listing clone.
     */
    function createListing(
        address landlord,
        uint256 fid,
        bytes32 castHash,
        bytes32 geohash,
        uint8 geohashPrecision,
        uint32 areaSqm,
        uint256 baseDailyRate,
        uint256 depositAmount,
        uint64 minBookingNotice,
        uint64 maxBookingWindow,
        string calldata metadataURI
    ) external returns (address listing) {
        require(msg.sender == platform, "only platform");
        require(landlord != address(0), "landlord=0");

        address implementation = listingImplementation;
        require(implementation != address(0), "impl=0");

        listing = implementation.clone();

        (address currentFactory, address bookingRegistry, address sqmuToken) = Platform(platform).modules();
        require(currentFactory == address(this), "factory mismatch");
        require(bookingRegistry != address(0), "registry=0");
        require(sqmuToken != address(0), "sqmuToken=0");

        IListing(listing).initialize(
            landlord,
            platform,
            bookingRegistry,
            sqmuToken,
            fid,
            castHash,
            geohash,
            geohashPrecision,
            areaSqm,
            baseDailyRate,
            depositAmount,
            minBookingNotice,
            maxBookingWindow,
            metadataURI
        );

        emit ListingCreated(listing, landlord);
    }

    // -------------------------------------------------
    // UUPS authorization hook
    // -------------------------------------------------

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // -------------------------------------------------
    // Storage gap for upgradeability
    // -------------------------------------------------

    uint256[48] private __gap;
}
