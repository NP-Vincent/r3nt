// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {SafeERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Minimal interface exposed by the listing factory.
interface IListingFactory {
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
    ) external returns (address listing);
}

/// @dev Minimal interface exposed by the booking registry.
interface IBookingRegistry {
    function registerListing(address listing) external;
}

/// @dev Minimal interface exposed by the agent implementation for initializer encoding.
interface IAgent {
    function initialize(
        address listing,
        uint256 bookingId,
        address agent,
        uint16 agentFeeBps,
        address agentFeeRecipient
    ) external;
}

/// @dev Minimal interface for registering an agent against a listing booking.
interface IListingWithAgents {
    function registerAgent(uint256 bookingId, address agent) external;
}

/// @dev Minimal interface exposed by the listing for deposit confirmations.
interface IListingDeposits {
    function confirmDepositSplit(uint256 bookingId, bytes calldata signature) external;
}

/// @dev Minimal interface exposed by the listing for tokenisation approvals/rejections.
interface IListingTokenisation {
    function approveTokenisation(uint256 bookingId) external;

    function rejectTokenisation(uint256 bookingId) external;
}

/// @dev Minimal interface exposed by the listing for updating its cast hash reference.
interface IListingCastHash {
    function updateCastHash(bytes32 newCastHash) external;
}

/// @dev Minimal subset of the r3nt-SQMU manager interface used to grant minting rights.
interface IR3ntSQMUManager {
    function grantListingMinter(address listing) external;
}

/**
 * @title Platform
 * @notice Holds global configuration for the r3nt protocol and orchestrates listing creation.
 * @dev Upgradeable through the UUPS proxy pattern. The owner is expected to be a platform
 *      multi-sig which controls configuration updates and authorises upgrades.
 */
contract Platform is Initializable, UUPSUpgradeable, OwnableUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev Basis points denominator used for fee calculations.
    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @dev Number of decimals expected from the USDC token (informational helper).
    uint8 public constant USDC_DECIMALS = 6;

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

    /// @notice Duration that each purchased view pass remains valid for (in seconds).
    uint64 public viewPassDuration;

    /// @notice Expiration timestamp for each address that has purchased a view pass.
    mapping(address => uint256) public viewPassExpiry;

    /// @notice Total number of listings created through the platform.
    uint256 public listingCount;

    /// @dev Tracks whether an address corresponds to a registered listing clone.
    mapping(address => bool) public isListing;

    /// @dev Mapping from sequential listing identifier to the deployed listing address.
    mapping(uint256 => address) public listingById;

    /// @dev Reverse lookup from listing address to its sequential identifier.
    mapping(address => uint256) public listingIds;

    /// @notice Tracks whether a listing id remains active.
    mapping(uint256 => bool) public listingActive;

    /// @notice Timestamp when each listing was registered (unix epoch seconds).
    /// Listings created before this upgrade will return zero until manually backfilled.
    mapping(uint256 => uint256) public listingCreated;

    /// @dev Storage for iterating listings off-chain when necessary.
    address[] private _listings;

    /// @notice Agent implementation used when deploying new proxies.
    address public agentImplementation;

    /// @notice Maximum agent fee (basis points) allowed when initialising a proxy.
    uint16 public maxAgentFeeBps;

    /// @notice Tracks agent proxies deployed through the platform.
    mapping(address => bool) public isAgentProxy;

    /// @notice Registry mapping a listing + booking pair to its managing agent proxy.
    mapping(address => mapping(uint256 => address)) public agentForBooking;

    /// @notice Addresses authorised to request new agent proxy deployments.
    mapping(address => bool) public approvedAgentDeployers;

    /// @notice Wallets allowed to operate newly created agent proxies.
    mapping(address => bool) public approvedAgentOperators;

    /// @dev Storage for iterating registered agent proxies.
    address[] private _agents;

    // -------------------------------------------------
    // Events
    // -------------------------------------------------

    event PlatformInitialized(address indexed owner, address indexed usdc, address indexed treasury);
    event UsdcUpdated(address indexed previousUsdc, address indexed newUsdc);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event ModulesUpdated(address indexed listingFactory, address indexed bookingRegistry, address indexed sqmuToken);
    event FeesUpdated(uint16 tenantFeeBps, uint16 landlordFeeBps);
    event ListingPricingUpdated(uint256 listingCreationFee, uint256 viewPassPrice, uint64 viewPassDuration);
    event ListingRegistered(address indexed listing, address indexed landlord, uint256 indexed listingId);
    event ListingDeactivated(address indexed listing, uint256 indexed listingId);
    event ListingCastHashUpdated(
        uint256 indexed listingId,
        address indexed listing,
        bytes32 previousCastHash,
        bytes32 newCastHash
    );
    event ViewPassBought(address indexed buyer, uint256 expiry);
    event AgentImplementationUpdated(address indexed previousImplementation, address indexed newImplementation);
    event MaxAgentFeeUpdated(uint16 previousMaxFeeBps, uint16 newMaxFeeBps);
    event AgentDeployerStatusUpdated(address indexed account, bool approved);
    event AgentOperatorStatusUpdated(address indexed operator, bool approved);
    event AgentRegistered(
        address indexed listing,
        uint256 indexed bookingId,
        address indexed agentProxy,
        address operator,
        uint16 agentFeeBps,
        address feeRecipient
    );

    // -------------------------------------------------
    // Constructor / Initializer
    // -------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the platform configuration. Intended to be called exactly once through the proxy.
     * @param owner_ Platform multi-sig that controls upgrades/configuration.
     * @param treasury_ Fee sink receiving protocol fees.
     * @param usdc_ Canonical USDC token address used for settlements.
     * @param listingFactory_ Listing factory responsible for cloning listings.
     * @param bookingRegistry_ Shared registry maintaining booking availability.
     * @param sqmuToken_ ERC-1155 token contract handling investor SQMU-R positions.
     * @param tenantFeeBps_ Platform fee applied to tenants in basis points.
     * @param landlordFeeBps_ Platform fee applied to landlords in basis points.
     * @param listingCreationFee_ Fee charged for creating a listing (USDC, 6 decimals).
     * @param viewPassPrice_ Optional price for premium listing views (USDC, 6 decimals).
     * @param viewPassDuration_ Duration that each purchased view pass remains valid (seconds).
     */
    function initialize(
        address owner_,
        address treasury_,
        address usdc_,
        address listingFactory_,
        address bookingRegistry_,
        address sqmuToken_,
        uint16 tenantFeeBps_,
        uint16 landlordFeeBps_,
        uint256 listingCreationFee_,
        uint256 viewPassPrice_,
        uint64 viewPassDuration_
    ) external initializer {
        require(owner_ != address(0), "owner=0");
        require(usdc_ != address(0), "usdc=0");

        __Ownable_init(owner_);
        __UUPSUpgradeable_init();

        _setUsdc(usdc_);
        _setTreasury(treasury_);
        _setModules(listingFactory_, bookingRegistry_, sqmuToken_);
        _setFees(tenantFeeBps_, landlordFeeBps_);
        _setListingPricing(listingCreationFee_, viewPassPrice_, viewPassDuration_);

        maxAgentFeeBps = BPS_DENOMINATOR;

        emit PlatformInitialized(owner_, usdc_, treasury_);
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

    function setListingPricing(
        uint256 newListingCreationFee,
        uint256 newViewPassPrice,
        uint64 newViewPassDuration
    ) external onlyOwner {
        _setListingPricing(newListingCreationFee, newViewPassPrice, newViewPassDuration);
    }

    function setAgentImplementation(address newImplementation) external onlyOwner {
        address previous = agentImplementation;
        agentImplementation = newImplementation;
        emit AgentImplementationUpdated(previous, newImplementation);
    }

    function setMaxAgentFeeBps(uint16 newMaxAgentFeeBps) external onlyOwner {
        require(newMaxAgentFeeBps <= BPS_DENOMINATOR, "fee cap too high");
        uint16 previous = maxAgentFeeBps;
        maxAgentFeeBps = newMaxAgentFeeBps;
        emit MaxAgentFeeUpdated(previous, newMaxAgentFeeBps);
    }

    function setAgentDeployer(address account, bool approved) external onlyOwner {
        approvedAgentDeployers[account] = approved;
        emit AgentDeployerStatusUpdated(account, approved);
    }

    function setAgentOperator(address account, bool approved) external onlyOwner {
        approvedAgentOperators[account] = approved;
        emit AgentOperatorStatusUpdated(account, approved);
    }

    // -------------------------------------------------
    // Listing orchestration
    // -------------------------------------------------

    /**
     * @notice Create a new listing clone via the configured factory.
     * @param landlord Address of the landlord controlling the new listing.
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
     * @return listing Address of the newly deployed listing clone.
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
        require(landlord != address(0), "landlord=0");
        require(listingFactory != address(0), "factory=0");
        require(bookingRegistry != address(0), "registry=0");
        require(sqmuToken != address(0), "sqmuToken=0");

        address caller = _msgSender();
        if (caller != owner()) {
            require(caller == landlord, "caller not landlord");
        }

        _collectListingFee(caller);

        listing = IListingFactory(listingFactory).createListing(
            landlord,
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
        require(listing != address(0), "listing=0");
        require(!isListing[listing], "already registered");

        IBookingRegistry(bookingRegistry).registerListing(listing);

        uint256 listingId = ++listingCount;
        isListing[listing] = true;
        listingById[listingId] = listing;
        listingIds[listing] = listingId;
        listingActive[listingId] = true;
        _listings.push(listing);
        listingCreated[listingId] = block.timestamp;

        emit ListingRegistered(listing, landlord, listingId);
    }

    function deactivateListing(uint256 listingId) external onlyOwner {
        address listing = listingById[listingId];
        require(listing != address(0), "unknown listing");
        require(listingActive[listingId], "already inactive");

        listingActive[listingId] = false;

        emit ListingDeactivated(listing, listingId);
    }

    function createAgent(
        address listing,
        uint256 bookingId,
        address agentWallet,
        uint16 agentFeeBps,
        address agentFeeRecipient
    ) external returns (address agentProxy) {
        address caller = _msgSender();
        if (caller != owner()) {
            require(approvedAgentDeployers[caller], "not authorised");
        }

        address implementation = agentImplementation;
        require(implementation != address(0), "agent impl unset");
        require(listing != address(0), "listing=0");
        require(isListing[listing], "unregistered listing");
        require(bookingId != 0, "booking=0");
        require(agentWallet != address(0), "agent=0");
        require(approvedAgentOperators[agentWallet], "operator not approved");
        require(agentFeeBps <= BPS_DENOMINATOR, "fee bps too high");
        require(agentFeeBps <= maxAgentFeeBps, "fee above cap");
        require(agentForBooking[listing][bookingId] == address(0), "agent exists");

        (bool success, ) = listing.staticcall(abi.encodeWithSignature("bookingInfo(uint256)", bookingId));
        require(success, "unknown booking");

        bytes memory initData = abi.encodeWithSelector(
            IAgent.initialize.selector,
            listing,
            bookingId,
            agentWallet,
            agentFeeBps,
            agentFeeRecipient
        );

        agentProxy = address(new ERC1967Proxy(implementation, initData));

        isAgentProxy[agentProxy] = true;
        agentForBooking[listing][bookingId] = agentProxy;
        _agents.push(agentProxy);

        IListingWithAgents(listing).registerAgent(bookingId, agentProxy);

        address sqmuToken_ = sqmuToken;
        require(sqmuToken_ != address(0), "sqmuToken=0");
        IR3ntSQMUManager(sqmuToken_).grantListingMinter(agentProxy);

        address resolvedRecipient = agentFeeRecipient == address(0) ? agentWallet : agentFeeRecipient;

        emit AgentRegistered(listing, bookingId, agentProxy, agentWallet, agentFeeBps, resolvedRecipient);
    }

    /**
     * @notice Confirm a landlord-proposed deposit split for a specific booking.
     * @param listingId Identifier of the listing that holds the booking escrow.
     * @param bookingId Identifier of the booking whose deposit is being released.
     * @param signature Optional future-proofing for signature validation (currently unused).
     */
    function confirmDepositSplit(
        uint256 listingId,
        uint256 bookingId,
        bytes calldata signature
    ) external onlyOwner {
        address listing = listingById[listingId];
        require(listing != address(0), "listing not found");

        IListingDeposits(listing).confirmDepositSplit(bookingId, signature);
    }

    /**
     * @notice Approve a pending tokenisation proposal for a given listing booking.
     * @param listingId Identifier of the listing that owns the booking.
     * @param bookingId Identifier of the booking whose proposal is being approved.
     */
    function approveTokenisation(uint256 listingId, uint256 bookingId) external onlyOwner {
        address listing = listingById[listingId];
        require(listing != address(0), "listing not found");

        address sqmuToken_ = sqmuToken;
        require(sqmuToken_ != address(0), "sqmu=0");

        IR3ntSQMUManager(sqmuToken_).grantListingMinter(listing);

        IListingTokenisation(listing).approveTokenisation(bookingId);
    }

    /**
     * @notice Reject and clear a pending tokenisation proposal for a given listing booking.
     * @param listingId Identifier of the listing that owns the booking.
     * @param bookingId Identifier of the booking whose proposal is being rejected.
     */
    function rejectTokenisation(uint256 listingId, uint256 bookingId) external onlyOwner {
        address listing = listingById[listingId];
        require(listing != address(0), "listing not found");

        IListingTokenisation(listing).rejectTokenisation(bookingId);
    }

    function updateListingCastHash(uint256 listingId, bytes32 newCastHash) external onlyOwner {
        require(newCastHash != bytes32(0), "castHash=0");

        address listing = listingById[listingId];
        require(listing != address(0), "listing not found");
        require(listingActive[listingId], "listing inactive");

        (bool success, bytes memory data) = listing.staticcall(abi.encodeWithSignature("castHash()"));
        require(success && data.length >= 32, "castHash read failed");
        bytes32 previousCastHash = abi.decode(data, (bytes32));

        require(previousCastHash != newCastHash, "castHash unchanged");

        IListingCastHash(listing).updateCastHash(newCastHash);

        emit ListingCastHashUpdated(listingId, listing, previousCastHash, newCastHash);
    }

    function _collectListingFee(address payer) internal {
        uint256 fee = listingCreationFee;
        if (fee == 0) {
            return;
        }

        address usdc_ = usdc;
        address treasury_ = treasury;
        require(usdc_ != address(0), "usdc=0");
        require(treasury_ != address(0), "treasury=0");
        require(payer != address(0), "payer=0");

        IERC20Upgradeable(usdc_).safeTransferFrom(payer, treasury_, fee);
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

    function allListings() external view returns (address[] memory activeListings) {
        uint256 totalListings = _listings.length;
        uint256 activeCount;

        for (uint256 i = 0; i < totalListings; i++) {
            address listing = _listings[i];
            if (listing == address(0)) {
                continue;
            }
            uint256 listingId = listingIds[listing];
            if (listingId != 0 && listingActive[listingId]) {
                activeCount++;
            }
        }

        activeListings = new address[](activeCount);
        if (activeCount == 0) {
            return activeListings;
        }

        uint256 index;
        for (uint256 i = 0; i < totalListings; i++) {
            address listing = _listings[i];
            if (listing == address(0)) {
                continue;
            }
            uint256 listingId = listingIds[listing];
            if (listingId != 0 && listingActive[listingId]) {
                activeListings[index] = listing;
                index++;
            }
        }
    }

    /**
     * @notice Returns the block timestamp when a listing was registered.
     * @dev Listings that pre-date this helper will return zero until backfilled off-chain.
     */
    function listingRegisteredAt(uint256 listingId) external view returns (uint256) {
        return listingCreated[listingId];
    }

    function allAgents() external view returns (address[] memory) {
        return _agents;
    }

    function hasActiveViewPass(address account) external view returns (bool) {
        return _hasActiveViewPass(account);
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

    function _setListingPricing(
        uint256 newListingCreationFee,
        uint256 newViewPassPrice,
        uint64 newViewPassDuration
    ) internal {
        listingCreationFee = newListingCreationFee;
        viewPassPrice = newViewPassPrice;
        viewPassDuration = newViewPassDuration;
        emit ListingPricingUpdated(newListingCreationFee, newViewPassPrice, newViewPassDuration);
    }

    function _hasActiveViewPass(address account) internal view returns (bool) {
        if (viewPassDuration == 0) {
            return true;
        }
        if (account == address(0)) {
            return false;
        }
        return viewPassExpiry[account] >= block.timestamp;
    }

    function buyViewPass() external {
        uint64 duration = viewPassDuration;
        require(duration != 0, "view pass disabled");

        address buyer = _msgSender();
        uint256 price = viewPassPrice;
        if (price > 0) {
            address usdc_ = usdc;
            address treasury_ = treasury;
            require(usdc_ != address(0), "usdc=0");
            require(treasury_ != address(0), "treasury=0");
            IERC20Upgradeable(usdc_).safeTransferFrom(buyer, treasury_, price);
        }

        uint256 currentExpiry = viewPassExpiry[buyer];
        uint256 startingPoint = currentExpiry > block.timestamp ? currentExpiry : block.timestamp;
        uint256 newExpiry = startingPoint + uint256(duration);
        viewPassExpiry[buyer] = newExpiry;

        emit ViewPassBought(buyer, newExpiry);
    }

    // -------------------------------------------------
    // UUPS authorization hook
    // -------------------------------------------------

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // -------------------------------------------------
    // Storage gap for upgradeability
    // -------------------------------------------------

    uint256[29] private __gap;
}
