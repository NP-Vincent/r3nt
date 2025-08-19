// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * r3nt (UUPS) wired to ListingFactory/Listing clones
 * - On landlord createListing(): pays list fee, stores listing, asks ListingFactory to clone a per-listing vault,
 *   and stores the vault address on the Listing.
 * - On book(): implements a 1% platform fee split as:
 *      • Tenant pays: 100% rent + 0.5% (tenant half of fee) + deposit
 *      • Landlord receives: 100% rent − 0.5% (landlord half of fee)
 *      • Platform receives: 1.0% of rent (tenant half + landlord half)
 *   Arms the vault with (tenant, deposit) and transfers the deposit to the vault.
 * - Deposit split/release is forwarded to the per-listing vault (Listing) instead of handled in r3nt.
 *
 * Notes:
 * - All monetary values use 6 decimals (USDC).
 * - Platform is the fee receiver and contract owner (can be an OZ multisig you control).
 */

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

// For ListingFactory interface arg types
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { RentCalculator } from "./RentCalculator.sol";

/* ----------------------------- External Interfaces ----------------------------- */

interface IListing {
    function arm(address _tenant, uint96 _deposit) external;
    function propose(uint96 toTenant, uint96 toLandlord) external;
    function confirmRelease(bytes calldata signature) external;
}

interface IListingFactory {
    function createListing(
        address core,
        address landlord,
        address platformAdmin,
        IERC20 token,
        bytes[] calldata signers,
        uint256 threshold,
        uint256 listingId
    ) external returns (address listing);

    function predict(address core, uint256 listingId) external view returns (address predicted);
}

/* ------------------------------------ Core ------------------------------------- */

contract r3nt is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // -----------------------
    // Types / Storage
    // -----------------------

    enum RateType { Daily, Weekly, Monthly }
    enum BookingStatus { Booked, Completed, Resolved }

    struct Listing {
        address owner;
        bool    active;
        IERC20Upgradeable usdc;   // token used for this listing (USDC on Arbitrum)
        uint96  deposit;          // 6d
        uint96  rateDaily;        // 6d (0 allowed if not offered)
        uint96  rateWeekly;       // 6d
        uint96  rateMonthly;      // 6d
        bytes32 geohash;          // ASCII left-aligned
        uint8   geolen;           // 4..10
        uint256 fid;              // Farcaster landlord FID
        bytes32 castHash;         // Farcaster cast hash
        string  title;            // short
        string  shortDesc;        // short
        address vault;            // per-listing deposit vault (clone)
    }

    struct Booking {
        address tenant;
        address landlord;
        uint256 listingId;
        uint64  startDate;        // unix ts
        uint64  endDate;          // unix ts
        uint96  rentAmount;       // gross rent for this booking (for reference)
        uint96  feeAmount;        // total platform fee (tenant+landlord halves)
        uint96  depositAmount;    // recorded for reference (custodied in vault)
        BookingStatus status;
        // kept for backward-compatibility, not used when vault handles proposal
        uint96  propTenant;
        uint96  propLandlord;
        bool    proposalSet;
    }

    // Listings & Bookings
    Listing[] public listings;
    Booking[] public bookings;

    // View pass: address => expiry timestamp (0 = none)
    mapping(address => uint256) public viewPassExpiry;

    // Platform / Fees
    IERC20Upgradeable public USDC;        // canonical USDC (used for list/view fees)
    address public platform;              // fee receiver (also contract owner)
    uint16  public feeBps;                // platform fee on rent (basis points)
    uint96  public listFee;               // $1.00 in 6d
    uint96  public viewFee;               // $0.10 in 6d
    uint32  public viewPassSeconds;       // e.g. 72h

    // External factory
    IListingFactory public listingFactory;

    // Events
    event Listed(uint256 indexed id, address indexed owner, address vault);
    event ListingActive(uint256 indexed id, bool active);
    event ViewPassBought(address indexed user, uint96 fee, uint256 expiresAt);
    event Booked(
        uint256 indexed bookingId,
        uint256 indexed listingId,
        address indexed tenant,
        uint96 rentAmount,       // gross rent
        uint96 feeAmount,        // total platform fee (both halves)
        uint96 depositAmount
    );
    event Completed(uint256 indexed bookingId);
    event DepositProposed(uint256 indexed bookingId, uint96 toTenant, uint96 toLandlord);
    event DepositResolved(
        uint256 indexed bookingId,
        address toTenant,
        uint96 amtTenant,
        address toLandlord,
        uint96 amtLandlord
    );
    event PlatformUpdated(address indexed platform);
    event FeesUpdated(uint16 feeBps, uint96 listFee, uint96 viewFee, uint32 viewPassSeconds);
    event ListingFactoryUpdated(address factory);

    // -----------------------
    // Initializer (UUPS)
    // -----------------------

    /**
     * @param _usdc      Canonical USDC address on Arbitrum
     * @param _platform  Platform fee receiver & initial owner
     * @param _feeBps    e.g. 100 = 1%
     * @param _listFee   e.g. 1_000_000 (=$1)
     * @param _viewFee   e.g.   100_000 (=$0.10)
     * @param _viewPassSeconds e.g. 72*3600
     * @param _factory   ListingFactory address
     */
    function initialize(
        address _usdc,
        address _platform,
        uint16  _feeBps,
        uint96  _listFee,
        uint96  _viewFee,
        uint32  _viewPassSeconds,
        address _factory
    ) public initializer {
        require(_usdc != address(0) && _platform != address(0), "zero addr");
        __UUPSUpgradeable_init();
        __Ownable_init(_platform);        // OZ v5: pass initial owner
        __ReentrancyGuard_init();

        USDC = IERC20Upgradeable(_usdc);
        platform = _platform;
        feeBps = _feeBps;                  // default 100 (1%)
        listFee = _listFee;                // default $1
        viewFee = _viewFee;                // default $0.10
        viewPassSeconds = _viewPassSeconds; // default 72h

        if (_factory != address(0)) {
            listingFactory = IListingFactory(_factory);
            emit ListingFactoryUpdated(_factory);
        }
    }

    // UUPS auth
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // -----------------------
    // Internal utils
    // -----------------------

    function _toBytes32(string memory s) internal pure returns (bytes32 out) {
        bytes memory b = bytes(s);
        require(b.length <= 32, "geohash too long");
        assembly { out := mload(add(b, 32)) }
    }

    function _hasActiveViewPass(address user) internal view returns (bool) {
        return viewPassExpiry[user] >= block.timestamp;
    }

    function _calculateFee(uint96 rent) internal view returns (uint96) {
        return uint96((uint256(rent) * feeBps) / 10_000);
    }

    function _transferFunds(
        Listing storage L,
        address tenant,
        uint96 rent,
        uint96 fee,
        uint96 dep
    ) internal {
        uint96 feeTenant = fee / 2;
        uint96 feeLandlord = fee - feeTenant;

        uint256 totalFromTenant = uint256(rent) + uint256(feeTenant) + uint256(dep);
        L.usdc.safeTransferFrom(tenant, address(this), totalFromTenant);

        uint96 toLandlord = rent > feeLandlord ? rent - feeLandlord : 0;
        if (toLandlord > 0) {
            L.usdc.safeTransfer(L.owner, toLandlord);
        }

        if (fee > 0) {
            L.usdc.safeTransfer(platform, fee);
        }

        if (dep > 0) {
            IListing(L.vault).arm(tenant, dep);
            L.usdc.safeTransfer(L.vault, dep);
        }
    }

    function _createBooking(
        address tenant,
        address landlord,
        uint256 listingId,
        uint64 startDate,
        uint64 endDate,
        uint96 rent,
        uint96 fee,
        uint96 dep
    ) internal returns (Booking memory B) {
        B = Booking({
            tenant: tenant,
            landlord: landlord,
            listingId: listingId,
            startDate: startDate,
            endDate: endDate,
            rentAmount: rent,
            feeAmount: fee,
            depositAmount: dep,
            status: BookingStatus.Booked,
            propTenant: 0,
            propLandlord: 0,
            proposalSet: false
        });
        bookings.push(B);
    }

    // -----------------------
    // Admin wiring
    // -----------------------

    function setListingFactory(address _factory) external onlyOwner {
        require(_factory != address(0), "zero");
        listingFactory = IListingFactory(_factory);
        emit ListingFactoryUpdated(_factory);
    }

    function setPlatform(address p) external onlyOwner {
        require(p != address(0), "zero");
        platform = p;
        emit PlatformUpdated(p);
    }

    function setFees(
        uint16 _feeBps,
        uint96 _listFee,
        uint96 _viewFee,
        uint32 _viewPassSeconds
    ) external onlyOwner {
        require(_feeBps <= 1000, "max 10%");
        feeBps = _feeBps;
        listFee = _listFee;
        viewFee = _viewFee;
        viewPassSeconds = _viewPassSeconds;
        emit FeesUpdated(_feeBps, _listFee, _viewFee, _viewPassSeconds);
    }

    // -----------------------
    // Landlord flows
    // -----------------------

    /**
     * @dev Creates a listing and its per-listing vault via ListingFactory.
     * @param usdc Listing token (e.g., canonical USDC address)
     * @param deposit Security deposit (6d)
     * @param rateDaily/Weekly/Monthly Price schedule (6d)
     * @param geohashStr ASCII geohash string (length == geolen)
     * @param geolen 4..10 inclusive
     * @param fid/castHash Farcaster pointer
     * @param title/shortDesc Short metadata strings
     * @param signers ERC-7913 signer identities for platform multisig
     * @param threshold Multisig threshold (>=1)
     */
    function createListing(
        address usdc,
        uint96  deposit,
        uint96  rateDaily,
        uint96  rateWeekly,
        uint96  rateMonthly,
        string calldata geohashStr,
        uint8   geolen,
        uint256 fid,
        bytes32 castHash,
        string calldata title,
        string calldata shortDesc,
        bytes[] calldata signers,
        uint256 threshold
    ) external nonReentrant returns (uint256 id) {
        require(address(listingFactory) != address(0), "factory not set");
        require(usdc != address(0), "usdc zero");
        require(geolen >= 4 && geolen <= 10, "bad geolen");
        require(bytes(geohashStr).length == geolen, "bad geohash");

        // Pull $1 list fee in canonical USDC
        USDC.safeTransferFrom(msg.sender, platform, listFee);

        // Store listing
        listings.push(Listing({
            owner: msg.sender,
            active: true,
            usdc: IERC20Upgradeable(usdc),
            deposit: deposit,
            rateDaily: rateDaily,
            rateWeekly: rateWeekly,
            rateMonthly: rateMonthly,
            geohash: _toBytes32(geohashStr),
            geolen: geolen,
            fid: fid,
            castHash: castHash,
            title: title,
            shortDesc: shortDesc,
            vault: address(0)
        }));
        id = listings.length - 1;

        // Ask factory to clone per-listing vault (deterministic by (address(this), id))
        address vault = listingFactory.createListing(
            address(this),
            msg.sender,
            platform,                           // platform admin/controller (parity arg)
            IERC20(usdc),                       // token allowlist enforced at factory
            signers,
            threshold,
            id
        );
        listings[id].vault = vault;

        emit Listed(id, msg.sender, vault);
    }

    function setActive(uint256 listingId, bool active_) external {
        Listing storage L = listings[listingId];
        require(msg.sender == L.owner, "not owner");
        L.active = active_;
        emit ListingActive(listingId, active_);
    }

    // -----------------------
    // Tenant flows
    // -----------------------

    function buyViewPass() external nonReentrant {
        // Pull $0.10 in canonical USDC
        USDC.safeTransferFrom(msg.sender, platform, viewFee);

        uint256 newExpiry = block.timestamp + uint256(viewPassSeconds);
        uint256 current = viewPassExpiry[msg.sender];
        if (current > block.timestamp) {
            newExpiry = current + uint256(viewPassSeconds);
        }
        viewPassExpiry[msg.sender] = newExpiry;
        emit ViewPassBought(msg.sender, viewFee, newExpiry);
    }

    /**
     * @dev Booking with fee split:
     *      tenant pays (rent + fee/2 + deposit),
     *      landlord receives (rent - fee/2),
     *      platform receives (fee = rent * feeBps / 10_000).
     */
    function book(
        uint256 listingId,
        RateType rtype,
        uint256 units,
        uint64  startDate,
        uint64  endDate
    ) external nonReentrant returns (uint256 bookingId) {
        require(_hasActiveViewPass(msg.sender), "no view pass");
        require(endDate > startDate, "bad dates");

        Listing storage L = listings[listingId];
        require(L.active, "inactive");
        require(L.vault != address(0), "no vault");

        uint96 rent = RentCalculator.calcRent(
            L.rateDaily,
            L.rateWeekly,
            L.rateMonthly,
            uint8(rtype),
            units
        );
        uint96 fee = _calculateFee(rent);
        uint96 dep = L.deposit;

        _transferFunds(L, msg.sender, rent, fee, dep);

        _createBooking(msg.sender, L.owner, listingId, startDate, endDate, rent, fee, dep);
        bookingId = bookings.length - 1;

        emit Booked(bookingId, listingId, msg.sender, rent, fee, dep);
    }

    function markCompleted(uint256 bookingId) external {
        Booking storage B = bookings[bookingId];
        require(msg.sender == B.landlord, "not landlord");
        require(B.status == BookingStatus.Booked, "bad status");
        B.status = BookingStatus.Completed;
        emit Completed(bookingId);
    }

    // -----------------------
    // Deposit partial release (FORWARDED TO VAULT)
    // -----------------------

    /// @notice Landlord proposes a split of the deposit (must sum to deposited amount). Forwarded to per-listing vault.
    function proposeDepositSplit(
        uint256 bookingId,
        uint96 toTenant,
        uint96 toLandlord
    ) external {
        Booking storage B = bookings[bookingId];
        require(msg.sender == B.landlord, "not landlord");
        require(B.status == BookingStatus.Completed, "not completed");

        address vault = listings[B.listingId].vault;
        require(vault != address(0), "no vault");

        // Forward to vault
        IListing(vault).propose(toTenant, toLandlord);
        emit DepositProposed(bookingId, toTenant, toLandlord);
    }

    /// @notice Platform confirms and releases deposit as proposed in the per-listing vault.
    /// @param bookingId Booking to resolve.
    /// @param signature Multi-signer (ERC-7913) signature collected by the platform off-chain.
    function confirmDepositRelease(uint256 bookingId, bytes calldata signature) external onlyOwner nonReentrant {
        Booking storage B = bookings[bookingId];
        require(B.status == BookingStatus.Completed, "not completed");

        address vault = listings[B.listingId].vault;
        require(vault != address(0), "no vault");

        // Call vault; vault enforces signature correctness & transfers to parties.
        IListing(vault).confirmRelease(signature);

        // Mark resolved locally
        B.status = BookingStatus.Resolved;

        // Emit a generic resolved event (amounts already logged by the vault; echoing here for convenience)
        emit DepositResolved(bookingId, B.tenant, 0, B.landlord, 0);
    }

    // -----------------------
    // Views
    // -----------------------

    function listingsCount() external view returns (uint256) { return listings.length; }
    function bookingsCount() external view returns (uint256) { return bookings.length; }

    function getListing(uint256 id) external view returns (Listing memory) { return listings[id]; }
    function getBooking(uint256 id) external view returns (Booking memory) { return bookings[id]; }

    // -----------------------
    // Storage gap (UUPS)
    // -----------------------
    uint256[44] private __gap; // reduced by 1 due to the added `vault` field
}
