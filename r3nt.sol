// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

/**
 * @title r3nt (Upgradeable, UUPS)
 * @notice Minimal rental listings + escrow for Farcaster Mini Apps.
 *         - Listings: short fields + Farcaster pointer (fid + castHash).
 *         - Fees: $1 list (USDC), $0.10 view-pass (72h), 1% platform fee on rent.
 *         - Booking: rent -> landlord immediately (minus fee); deposit held in contract.
 *         - Partial deposit release: landlord proposes split; platform (owner) confirms.
 *
 * All dollar values in 6 decimals (USDC).
 */
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
    }

    struct Booking {
        address tenant;
        address landlord;
        uint256 listingId;
        uint64  startDate;        // unix ts
        uint64  endDate;          // unix ts
        uint96  rentAmount;       // paid to landlord at book
        uint96  feeAmount;        // paid to platform at book
        uint96  depositAmount;    // held for resolution
        BookingStatus status;
        // deposit split proposal (by landlord)
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

    // Events
    event Listed(uint256 indexed id, address indexed owner);
    event ListingActive(uint256 indexed id, bool active);
    event ViewPassBought(address indexed user, uint96 fee, uint256 expiresAt);
    event Booked(
        uint256 indexed bookingId,
        uint256 indexed listingId,
        address indexed tenant,
        uint96 rentAmount,
        uint96 feeAmount,
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
     */
    function initialize(
        address _usdc,
        address _platform,
        uint16  _feeBps,
        uint96  _listFee,
        uint96  _viewFee,
        uint32  _viewPassSeconds
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

    function _calcRent(Listing storage L, RateType rtype, uint256 units) internal view returns (uint96) {
        uint256 rate;
        if (rtype == RateType.Daily)       rate = L.rateDaily;
        else if (rtype == RateType.Weekly) rate = L.rateWeekly;
        else                               rate = L.rateMonthly;
        require(units > 0, "units=0");
        require(rate > 0, "rate not offered");
        uint256 rent = rate * units;
        require(rent <= type(uint96).max, "rent overflow");
        return uint96(rent);
    }

    function _hasActiveViewPass(address user) internal view returns (bool) {
        return viewPassExpiry[user] >= block.timestamp;
    }

    // -----------------------
    // Landlord flows
    // -----------------------

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
        string calldata shortDesc
    ) external nonReentrant returns (uint256 id) {
        require(usdc != address(0), "usdc zero");
        require(geolen >= 4 && geolen <= 10, "bad geolen");
        require(bytes(geohashStr).length == geolen, "bad geohash");

        // Pull $1 list fee in canonical USDC
        USDC.safeTransferFrom(msg.sender, platform, listFee);

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
            shortDesc: shortDesc
        }));
        id = listings.length - 1;
        emit Listed(id, msg.sender);
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
        // If user already has time remaining, extend to max(current, now) + 72h
        uint256 current = viewPassExpiry[msg.sender];
        if (current > block.timestamp) {
            newExpiry = current + uint256(viewPassSeconds);
        }
        viewPassExpiry[msg.sender] = newExpiry;
        emit ViewPassBought(msg.sender, viewFee, newExpiry);
    }

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

        // compute rent & fee
        uint96 rent = _calcRent(L, rtype, units);
        uint96 fee  = uint96((uint256(rent) * feeBps) / 10_000);
        uint96 dep  = L.deposit;

        // pull total from tenant: rent + fee + deposit (in listing's USDC)
        uint256 total = uint256(rent) + uint256(fee) + uint256(dep);
        L.usdc.safeTransferFrom(msg.sender, address(this), total);

        // immediate payouts
        if (rent > 0) { L.usdc.safeTransfer(L.owner, rent); }
        if (fee  > 0) { L.usdc.safeTransfer(platform, fee); }

        bookings.push(Booking({
            tenant: msg.sender,
            landlord: L.owner,
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
        }));
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
    // Deposit partial release
    // -----------------------

    /// @notice Landlord proposes a split of the deposit (must sum to deposited amount).
    function proposeDepositSplit(
        uint256 bookingId,
        uint96 toTenant,
        uint96 toLandlord
    ) external {
        Booking storage B = bookings[bookingId];
        require(msg.sender == B.landlord, "not landlord");
        require(B.status == BookingStatus.Completed, "not completed");
        require(!B.proposalSet, "already proposed");
        require(uint256(toTenant) + uint256(toLandlord) == uint256(B.depositAmount), "sum != deposit");

        B.propTenant   = toTenant;
        B.propLandlord = toLandlord;
        B.proposalSet  = true;

        emit DepositProposed(bookingId, toTenant, toLandlord);
    }

    /// @notice Platform confirms and releases deposit as proposed (multisig-ish).
    function confirmDepositRelease(uint256 bookingId) external onlyOwner nonReentrant {
        Booking storage B = bookings[bookingId];
        require(B.status == BookingStatus.Completed, "not completed");
        require(B.proposalSet, "no proposal");

        uint96 toT = B.propTenant;
        uint96 toL = B.propLandlord;

        // zero state before external calls
        B.status = BookingStatus.Resolved;
        B.depositAmount = 0;
        B.propTenant = 0;
        B.propLandlord = 0;

        Listing storage L = listings[B.listingId];
        if (toT > 0) { L.usdc.safeTransfer(B.tenant, toT); }
        if (toL > 0) { L.usdc.safeTransfer(B.landlord, toL); }

        emit DepositResolved(bookingId, B.tenant, toT, B.landlord, toL);
    }

    // -----------------------
    // Admin
    // -----------------------

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
    // Views
    // -----------------------

    function listingsCount() external view returns (uint256) { return listings.length; }
    function bookingsCount() external view returns (uint256) { return bookings.length; }

    function getListing(uint256 id) external view returns (Listing memory) { return listings[id]; }
    function getBooking(uint256 id) external view returns (Booking memory) { return bookings[id]; }

    // -----------------------
    // Storage gap (UUPS)
    // -----------------------
    uint256[45] private __gap;
}
