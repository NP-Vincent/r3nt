// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title BookingRegistry
 * @notice Maintains per-listing reservation calendars for the r3nt platform.
 * @dev Upgradeable through the UUPS proxy pattern. Listings are expected to call `reserve`
 *      and `release` for their own calendar while the platform (or owner) can perform
 *      administrative overrides via the `*_For` helpers.
 */
contract BookingRegistry is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    /// @notice Number of seconds that compose a single booking day.
    uint64 public constant SECONDS_PER_DAY = 86_400;

    // -------------------------------------------------
    // Storage
    // -------------------------------------------------

    /// @notice Platform contract authorised to manage listings and perform overrides.
    address public platform;

    /// @dev Tracks whether a given address corresponds to an authorised listing clone.
    mapping(address => bool) public isListing;

    /// @dev Reservation bitmap keyed by listing address and day index since Unix epoch.
    mapping(address => mapping(uint64 => bool)) private _reservedDays;

    // -------------------------------------------------
    // Events
    // -------------------------------------------------

    event BookingRegistryInitialized(address indexed owner, address indexed platform);
    event PlatformUpdated(address indexed previousPlatform, address indexed newPlatform);
    event ListingRegistered(address indexed listing, address indexed caller);
    event ListingDeregistered(address indexed listing, address indexed caller);
    event RangeReserved(
        address indexed listing,
        uint64 indexed startDay,
        uint64 indexed endDayExclusive,
        uint64 start,
        uint64 end
    );
    event RangeReleased(
        address indexed listing,
        uint64 indexed startDay,
        uint64 indexed endDayExclusive,
        uint64 start,
        uint64 end
    );

    // -------------------------------------------------
    // Constructor / Initializer
    // -------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the booking registry with the owning multi-sig and platform contract.
     * @param owner_ Platform multi-sig controlling upgrades/configuration.
     * @param platform_ Platform contract authorised for overrides.
     */
    function initialize(address owner_, address platform_) external initializer {
        require(owner_ != address(0), "owner=0");

        __Ownable_init(owner_);
        __UUPSUpgradeable_init();

        address initialPlatform = platform_;
        platform = initialPlatform;
        if (initialPlatform != address(0)) {
            emit PlatformUpdated(address(0), initialPlatform);
        }

        emit BookingRegistryInitialized(owner_, initialPlatform);
    }

    // -------------------------------------------------
    // Modifiers
    // -------------------------------------------------

    modifier onlyManager() {
        require(msg.sender == owner() || msg.sender == platform, "not authorised");
        _;
    }

    modifier onlyListingCaller() {
        require(isListing[msg.sender], "not listing");
        _;
    }

    // -------------------------------------------------
    // Configuration
    // -------------------------------------------------

    function setPlatform(address newPlatform) external onlyOwner {
        address previous = platform;
        platform = newPlatform;
        emit PlatformUpdated(previous, newPlatform);
    }

    function registerListing(address listing) external onlyManager {
        require(listing != address(0), "listing=0");
        require(!isListing[listing], "already registered");

        isListing[listing] = true;

        emit ListingRegistered(listing, msg.sender);
    }

    function deregisterListing(address listing) external onlyManager {
        require(isListing[listing], "not registered");

        delete isListing[listing];

        emit ListingDeregistered(listing, msg.sender);
    }

    // -------------------------------------------------
    // Booking management (listing callers)
    // -------------------------------------------------

    function reserve(uint64 start, uint64 end) external onlyListingCaller returns (uint64, uint64) {
        return _reserveRange(msg.sender, start, end);
    }

    function release(uint64 start, uint64 end) external onlyListingCaller returns (uint64, uint64) {
        return _releaseRange(msg.sender, start, end);
    }

    // -------------------------------------------------
    // Booking management (platform/owner overrides)
    // -------------------------------------------------

    function reserveFor(address listing, uint64 start, uint64 end)
        external
        onlyManager
        returns (uint64, uint64)
    {
        require(isListing[listing], "not registered");
        return _reserveRange(listing, start, end);
    }

    function releaseFor(address listing, uint64 start, uint64 end)
        external
        onlyManager
        returns (uint64, uint64)
    {
        require(isListing[listing], "not registered");
        return _releaseRange(listing, start, end);
    }

    // -------------------------------------------------
    // View helpers
    // -------------------------------------------------

    function isAvailable(address listing, uint64 start, uint64 end) external view returns (bool) {
        require(isListing[listing], "not registered");
        (uint64 startDay, uint64 endDayExclusive) = _normalizeRange(start, end);
        return _isRangeAvailable(listing, startDay, endDayExclusive);
    }

    function isDayReserved(address listing, uint64 day) external view returns (bool) {
        return _reservedDays[listing][day];
    }

    // -------------------------------------------------
    // Internal helpers
    // -------------------------------------------------

    function _reserveRange(address listing, uint64 start, uint64 end)
        internal
        returns (uint64 startDay, uint64 endDayExclusive)
    {
        (startDay, endDayExclusive) = _normalizeRange(start, end);
        _markRange(listing, startDay, endDayExclusive, true);
        emit RangeReserved(listing, startDay, endDayExclusive, start, end);
    }

    function _releaseRange(address listing, uint64 start, uint64 end)
        internal
        returns (uint64 startDay, uint64 endDayExclusive)
    {
        (startDay, endDayExclusive) = _normalizeRange(start, end);
        _markRange(listing, startDay, endDayExclusive, false);
        emit RangeReleased(listing, startDay, endDayExclusive, start, end);
    }

    function _normalizeRange(uint64 start, uint64 end)
        internal
        pure
        returns (uint64 startDay, uint64 endDayExclusive)
    {
        require(start < end, "invalid range");

        uint256 startDay256 = uint256(start) / SECONDS_PER_DAY;
        uint256 endDayExclusive256 = (uint256(end) + SECONDS_PER_DAY - 1) / SECONDS_PER_DAY;

        require(endDayExclusive256 <= type(uint64).max, "range too long");

        startDay = uint64(startDay256);
        endDayExclusive = uint64(endDayExclusive256);
    }

    function _markRange(address listing, uint64 startDay, uint64 endDayExclusive, bool reserveDays) internal {
        mapping(uint64 => bool) storage calendar = _reservedDays[listing];
        for (uint64 day = startDay; day < endDayExclusive; ) {
            bool currentlyReserved = calendar[day];
            if (reserveDays) {
                require(!currentlyReserved, "day unavailable");
                calendar[day] = true;
            } else {
                require(currentlyReserved, "day free");
                delete calendar[day];
            }

            unchecked {
                ++day;
            }
        }
    }

    function _isRangeAvailable(address listing, uint64 startDay, uint64 endDayExclusive)
        internal
        view
        returns (bool)
    {
        mapping(uint64 => bool) storage calendar = _reservedDays[listing];
        for (uint64 day = startDay; day < endDayExclusive; ) {
            if (calendar[day]) {
                return false;
            }

            unchecked {
                ++day;
            }
        }

        return true;
    }

    // -------------------------------------------------
    // UUPS authorization hook
    // -------------------------------------------------

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // -------------------------------------------------
    // Storage gap for upgradeability
    // -------------------------------------------------

    uint256[45] private __gap;
}
