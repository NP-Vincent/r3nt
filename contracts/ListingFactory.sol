// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ClonesUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/ClonesUpgradeable.sol";

import {Platform} from "./Platform.sol";

/**
 * @title ListingFactory
 * @notice Deploys clone instances of the Listing contract and wires them to protocol modules.
 * @dev Upgradeable through the UUPS pattern. The factory is owned by the platform multi-sig which
 *      may update the Listing implementation or the authorised platform caller.
 */
contract ListingFactory is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    using ClonesUpgradeable for address;

    /// @dev Minimal interface for Listing clones.
    interface IListing {
        function initialize(
            address landlord,
            address platform,
            address bookingRegistry,
            address sqmuToken,
            Platform.ListingParams calldata params
        ) external;
    }

    /// @notice Initialization arguments for the factory.
    struct InitializeParams {
        address owner; // Platform multi-sig controlling upgrades and configuration
        address platform; // Platform contract authorised to request new listings
        address implementation; // Canonical Listing implementation to clone
    }

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
     * @param params Struct bundling the initial configuration values.
     */
    function initialize(InitializeParams calldata params) external initializer {
        require(params.owner != address(0), "owner=0");
        require(params.platform != address(0), "platform=0");
        require(params.implementation != address(0), "impl=0");

        __Ownable_init();
        __UUPSUpgradeable_init();

        platform = params.platform;
        listingImplementation = params.implementation;

        _transferOwnership(params.owner);

        emit PlatformUpdated(address(0), params.platform);
        emit ListingImplementationUpdated(address(0), params.implementation);
        emit ListingFactoryInitialized(params.owner, params.platform, params.implementation);
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
     * @param params Listing configuration parameters forwarded to the clone.
     * @return listing Address of the freshly deployed listing clone.
     */
    function createListing(address landlord, Platform.ListingParams calldata params)
        external
        returns (address listing)
    {
        require(msg.sender == platform, "only platform");
        require(landlord != address(0), "landlord=0");

        address implementation = listingImplementation;
        require(implementation != address(0), "impl=0");

        listing = implementation.clone();

        (address currentFactory, address bookingRegistry, address sqmuToken) = Platform(platform).modules();
        require(currentFactory == address(this), "factory mismatch");
        require(bookingRegistry != address(0), "registry=0");
        require(sqmuToken != address(0), "sqmuToken=0");

        IListing(listing).initialize(landlord, platform, bookingRegistry, sqmuToken, params);

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
