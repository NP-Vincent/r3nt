// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {SafeERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import {Platform} from "./Platform.sol";

/// @notice Minimal interface for interacting with the booking registry.
interface IBookingRegistry {
    function reserve(uint64 start, uint64 end) external returns (uint64, uint64);

    function release(uint64 start, uint64 end) external returns (uint64, uint64);
}

/// @notice Minimal interface for interacting with the r3nt-SQMU token contract.
interface IR3ntSQMU {
    function mint(address to, uint256 id, uint256 amount, bytes calldata data) external;

    function burn(address from, uint256 id, uint256 amount) external;

    function lockTransfers(uint256 id) external;

    function balanceOf(address account, uint256 id) external view returns (uint256);

    function totalSupply(uint256 id) external view returns (uint256);
}

/**
 * @title Listing
 * @notice Cloneable per-property contract handling bookings, deposit escrow, optional tokenisation
 *         and rent streaming for the r3nt platform.
 */
contract Listing is Initializable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice Booking lifecycle statuses.
    enum Status {
        NONE,
        ACTIVE,
        COMPLETED,
        CANCELLED,
        DEFAULTED
    }

    /// @notice Supported rent payment intervals.
    enum Period {
        NONE,
        DAY,
        WEEK,
        MONTH
    }

    /// @notice Core booking storage structure.
    struct Booking {
        address tenant;
        uint64 start;
        uint64 end;
        uint256 rent;
        uint256 deposit;
        Status status;
        bool tokenised;
        uint256 totalSqmu;
        uint256 soldSqmu;
        uint256 pricePerSqmu;
        uint16 feeBps;
        Period period;
        address proposer;
        uint256 accRentPerSqmu;
        mapping(address => uint256) userDebt;
    }

    /// @notice View helper exposing booking details without mappings.
    struct BookingView {
        address tenant;
        uint64 start;
        uint64 end;
        uint256 grossRent;
        uint256 expectedNetRent;
        uint256 rentPaid;
        uint256 deposit;
        Status status;
        bool tokenised;
        uint256 totalSqmu;
        uint256 soldSqmu;
        uint256 pricePerSqmu;
        uint16 feeBps;
        Period period;
        address proposer;
        uint256 accRentPerSqmu;
        uint256 landlordAccrued;
        bool depositReleased;
        uint16 depositTenantBps;
        bool calendarReleased;
    }

    /// @notice Pending deposit split proposal awaiting platform confirmation.
    struct DepositSplitProposal {
        bool exists;
        uint16 tenantBps;
        address proposer;
    }

    /// @notice Pending tokenisation proposal awaiting platform approval.
    struct TokenisationProposal {
        bool exists;
        address proposer;
        uint256 totalSqmu;
        uint256 pricePerSqmu;
        uint16 feeBps;
        Period period;
    }

    /// @notice Snapshot of a deposit split proposal for off-chain consumers.
    struct DepositSplitView {
        bool exists;
        uint16 tenantBps;
        address proposer;
    }

    /// @notice Snapshot of a tokenisation proposal for off-chain consumers.
    struct TokenisationView {
        bool exists;
        address proposer;
        uint256 totalSqmu;
        uint256 pricePerSqmu;
        uint16 feeBps;
        Period period;
    }

    uint256 internal constant RENT_PRECISION = 1e18;
    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint64 internal constant SECONDS_PER_DAY = 86_400;
    uint256 internal constant DAYS_PER_WEEK = 7;
    uint256 internal constant DAYS_PER_MONTH = 30;

    /// @notice Address of the platform orchestrating this listing.
    address public platform;

    /// @notice Address controlling landlord actions for the property.
    address public landlord;

    /// @notice Booking registry responsible for availability management.
    address public bookingRegistry;

    /// @notice r3nt-SQMU token used for investor SQMU-R issuance.
    address public sqmuToken;

    /// @notice USDC token used for all monetary settlements.
    address public usdc;

    /// @notice Farcaster identifier for the landlord (off-chain linkage).
    uint256 public fid;

    /// @notice Canonical Farcaster cast hash (normalized 32-byte form).
    bytes32 public castHash;

    /// @notice Geospatial geohash stored as bytes32 (left aligned, zero padded).
    bytes32 public geohash;

    /// @notice Significant characters in the stored geohash.
    uint8 public geohashPrecision;

    /// @notice Property area in whole square metres.
    uint32 public areaSqm;

    /// @notice Base price per day denominated in USDC (6 decimals).
    uint256 public baseDailyRate;

    /// @notice Security deposit denominated in USDC (6 decimals).
    uint256 public depositAmount;

    /// @notice Minimum notice required before the booking start (seconds).
    uint64 public minBookingNotice;

    /// @notice Maximum look-ahead window tenants can book (seconds).
    uint64 public maxBookingWindow;

    /// @notice Off-chain metadata pointer (HTTPS).
    string public metadataURI;

    /// @notice Counter used to allocate sequential booking identifiers.
    uint256 public nextBookingId;

    /// @dev Mapping of booking id to booking storage structure.
    mapping(uint256 => Booking) private _bookings;

    /// @dev Gross rent paid so far for each booking (pre-fees).
    mapping(uint256 => uint256) private _grossRentPaid;

    /// @dev Expected net rent (after landlord fee) for each booking.
    mapping(uint256 => uint256) private _expectedNetRent;

    /// @dev Landlord proceeds accrued for non-tokenised bookings.
    mapping(uint256 => uint256) private _landlordAccruals;

    /// @dev Tracks whether the reservation range has been released back to the registry.
    mapping(uint256 => bool) private _rangeReleased;

    /// @dev Tracks whether the deposit has been fully released for a booking.
    mapping(uint256 => bool) private _depositReleased;

    /// @dev Stores the confirmed tenant share of the deposit split (in basis points).
    mapping(uint256 => uint16) private _confirmedDepositTenantBps;

    /// @dev Pending deposit split proposals keyed by booking id.
    mapping(uint256 => DepositSplitProposal) private _depositSplitProposals;

    /// @dev Pending tokenisation proposals keyed by booking id.
    mapping(uint256 => TokenisationProposal) private _tokenisationProposals;

    /// @dev Tracks the agent proxy registered to manage a booking (if any).
    mapping(uint256 => address) private _bookingAgents;

    // -------------------------------------------------
    // Events
    // -------------------------------------------------

    event ListingInitialized(address indexed landlord, address indexed platform, uint256 fid);
    event CastHashUpdated(bytes32 previousCastHash, bytes32 newCastHash);
    event BookingCreated(
        uint256 indexed bookingId,
        address indexed tenant,
        uint64 start,
        uint64 end,
        uint256 grossRent,
        uint256 expectedNetRent,
        uint256 deposit
    );
    event DepositSplitProposed(uint256 indexed bookingId, uint16 tenantBps, address indexed proposer);
    event DepositReleased(
        uint256 indexed bookingId,
        address indexed confirmer,
        uint256 tenantAmount,
        uint256 landlordAmount
    );
    event TokenisationProposed(
        uint256 indexed bookingId,
        address indexed proposer,
        uint256 totalSqmu,
        uint256 pricePerSqmu,
        uint16 feeBps,
        Period period
    );
    event TokenisationApproved(
        uint256 indexed bookingId,
        address indexed approver,
        uint256 totalSqmu,
        uint256 pricePerSqmu,
        uint16 feeBps,
        Period period
    );
    event TokenisationRejected(uint256 indexed bookingId, address indexed rejector, address indexed proposer);
    event SQMUTokensMinted(
        uint256 indexed bookingId,
        address indexed investor,
        uint256 sqmuAmount,
        uint256 cost,
        uint256 platformFee
    );
    event RentPaid(uint256 indexed bookingId, address indexed payer, uint256 grossAmount, uint256 netAmount);
    event Claimed(uint256 indexed bookingId, address indexed account, uint256 amount);
    event LandlordWithdrawal(uint256 indexed bookingId, address indexed recipient, uint256 amount);
    event BookingCancelled(uint256 indexed bookingId, address indexed caller);
    event BookingCompleted(uint256 indexed bookingId, address indexed caller);
    event BookingDefaulted(uint256 indexed bookingId, address indexed caller);
    event BookingAgentUpdated(uint256 indexed bookingId, address indexed agent);

    // -------------------------------------------------
    // Modifiers
    // -------------------------------------------------

    modifier onlyLandlord() {
        require(msg.sender == landlord, "not landlord");
        _;
    }

    modifier onlyPlatform() {
        require(msg.sender == platform, "not platform");
        _;
    }

    modifier onlyLandlordOrPlatform() {
        require(msg.sender == landlord || msg.sender == platform, "not authorised");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // -------------------------------------------------
    // Initializer
    // -------------------------------------------------

    /**
     * @notice Initialise the listing clone with landlord, platform and metadata parameters.
     * @param landlord_ Address of the landlord controlling the listing.
     * @param platform_ Address of the platform contract orchestrating bookings.
     * @param bookingRegistry_ Booking registry handling availability.
     * @param sqmuToken_ r3nt-SQMU token used for investor SQMU-R issuance.
     * @param fid_ Landlord Farcaster identifier stored for deep links.
     * @param castHash_ Canonical Farcaster cast hash (32-byte normalized form).
     * @param geohash_ Geospatial hash encoded as bytes32 (left aligned, zero padded).
     * @param geohashPrecision_ Number of significant characters in the geohash.
     * @param areaSqm_ Property area in whole square metres.
     * @param baseDailyRate_ Base price per day denominated in USDC (6 decimals).
     * @param depositAmount_ Security deposit denominated in USDC (6 decimals).
     * @param minBookingNotice_ Minimum notice required before booking start (seconds).
     * @param maxBookingWindow_ Maximum look-ahead window tenants can book (seconds).
     * @param metadataURI_ Off-chain metadata pointer (HTTPS).
     */
    function initialize(
        address landlord_,
        address platform_,
        address bookingRegistry_,
        address sqmuToken_,
        uint256 fid_,
        bytes32 castHash_,
        bytes32 geohash_,
        uint8 geohashPrecision_,
        uint32 areaSqm_,
        uint256 baseDailyRate_,
        uint256 depositAmount_,
        uint64 minBookingNotice_,
        uint64 maxBookingWindow_,
        string calldata metadataURI_
    ) external initializer {
        require(landlord_ != address(0), "landlord=0");
        require(platform_ != address(0), "platform=0");
        require(bookingRegistry_ != address(0), "registry=0");
        require(sqmuToken_ != address(0), "sqmuToken=0");

        __ReentrancyGuard_init();

        landlord = landlord_;
        platform = platform_;
        bookingRegistry = bookingRegistry_;
        sqmuToken = sqmuToken_;

        address usdcToken = Platform(platform_).usdc();
        require(usdcToken != address(0), "usdc=0");
        usdc = usdcToken;

        (, address registryFromPlatform, address sqmuTokenFromPlatform) = Platform(platform_).modules();
        require(registryFromPlatform == bookingRegistry_, "registry mismatch");
        require(sqmuTokenFromPlatform == sqmuToken_, "sqmu token mismatch");

        fid = fid_;
        castHash = castHash_;
        geohash = geohash_;
        geohashPrecision = geohashPrecision_;
        areaSqm = areaSqm_;
        baseDailyRate = baseDailyRate_;
        depositAmount = depositAmount_;
        minBookingNotice = minBookingNotice_;
        maxBookingWindow = maxBookingWindow_;
        metadataURI = metadataURI_;

        emit ListingInitialized(landlord_, platform_, fid_);
    }

    // -------------------------------------------------
    // Platform-controlled metadata updates
    // -------------------------------------------------

    /**
     * @notice Update the canonical Farcaster cast hash reference for the listing.
     * @param newCastHash Canonical Farcaster cast hash (normalized bytes32 form).
     */
    function updateCastHash(bytes32 newCastHash) external onlyPlatform {
        require(newCastHash != bytes32(0), "castHash=0");

        bytes32 previousCastHash = castHash;
        require(previousCastHash != newCastHash, "castHash unchanged");

        castHash = newCastHash;

        emit CastHashUpdated(previousCastHash, newCastHash);
    }

    // -------------------------------------------------
    // Booking lifecycle
    // -------------------------------------------------

    /**
     * @notice Book the listing for the provided time range. Calculates expected rent, applies
     *         platform fees for reference and escrows the security deposit.
     * @param start Booking start timestamp (seconds).
     * @param end Booking end timestamp (seconds).
     * @param period Rent payment interval selected by the tenant.
     * @return bookingId Identifier assigned to the new booking.
     */
    function book(uint64 start, uint64 end, Period period) external nonReentrant returns (uint256 bookingId) {
        require(start < end, "invalid range");
        require(start >= block.timestamp + minBookingNotice, "notice too short");
        if (maxBookingWindow != 0) {
            require(start <= block.timestamp + maxBookingWindow, "beyond window");
        }

        require(period != Period.NONE, "period none");

        require(Platform(platform).hasActiveViewPass(msg.sender), "view pass required");

        uint256 grossRent = _calculateRent(start, end);
        (, uint16 landlordFeeBps) = Platform(platform).fees();
        uint256 landlordFeeAmount = (grossRent * landlordFeeBps) / BPS_DENOMINATOR;
        uint256 expectedNetRentAmount = grossRent - landlordFeeAmount;

        bookingId = ++nextBookingId;
        Booking storage booking = _bookings[bookingId];

        booking.tenant = msg.sender;
        booking.start = start;
        booking.end = end;
        booking.rent = grossRent;
        booking.deposit = depositAmount;
        booking.status = Status.ACTIVE;
        booking.tokenised = false;
        booking.totalSqmu = 0;
        booking.soldSqmu = 0;
        booking.pricePerSqmu = 0;
        booking.feeBps = 0;
        booking.period = period;
        booking.proposer = address(0);
        booking.accRentPerSqmu = 0;

        _grossRentPaid[bookingId] = 0;
        _expectedNetRent[bookingId] = expectedNetRentAmount;

        uint256 deposit = depositAmount;
        if (deposit > 0) {
            IERC20Upgradeable(usdc).safeTransferFrom(msg.sender, address(this), deposit);
        }

        IBookingRegistry(bookingRegistry).reserve(start, end);

        emit BookingCreated(
            bookingId,
            msg.sender,
            start,
            end,
            grossRent,
            expectedNetRentAmount,
            deposit
        );
    }

    /**
     * @notice Register an agent proxy as the manager for a booking. Callable by the platform only.
     * @param bookingId Identifier of the booking being delegated to an agent.
     * @param agent Address of the agent proxy deployed through the platform.
     */
    function registerAgent(uint256 bookingId, address agent) external onlyPlatform {
        require(agent != address(0), "agent=0");
        Booking storage booking = _bookings[bookingId];
        require(booking.status != Status.NONE, "unknown booking");
        require(_bookingAgents[bookingId] == address(0), "agent set");

        _bookingAgents[bookingId] = agent;

        emit BookingAgentUpdated(bookingId, agent);
    }

    /**
     * @notice Return the agent proxy (if any) associated with a booking.
     * @param bookingId Identifier of the booking.
     */
    function bookingAgent(uint256 bookingId) external view returns (address) {
        return _bookingAgents[bookingId];
    }

    /**
     * @notice Pay rent for an active booking. Applies platform tenant/landlord fees and accrues
     *         the net proceeds to the landlord or investors.
     * @param bookingId Identifier of the booking being paid.
     * @param grossAmount Gross rent amount being settled (before platform fees).
     * @return netAmount Net amount accrued to the landlord/investors after fees.
     */
    function payRent(uint256 bookingId, uint256 grossAmount)
        external
        nonReentrant
        returns (uint256 netAmount)
    {
        require(grossAmount > 0, "amount=0");
        Booking storage booking = _bookings[bookingId];
        require(booking.status == Status.ACTIVE, "inactive booking");
        require(msg.sender == booking.tenant, "not tenant");

        uint256 totalGrossPaid = _grossRentPaid[bookingId];
        require(totalGrossPaid < booking.rent, "rent settled");
        uint256 remainingBeforePayment = booking.rent - totalGrossPaid;
        require(grossAmount <= remainingBeforePayment, "exceeds rent");

        if (booking.period != Period.NONE) {
            uint256 maxInstallment = _maxInstallmentAmount(booking);
            if (remainingBeforePayment > maxInstallment) {
                require(grossAmount <= maxInstallment, "payment too large");
            }
        }

        totalGrossPaid += grossAmount;

        (uint16 tenantFeeBps, uint16 landlordFeeBps) = Platform(platform).fees();
        uint256 tenantFee = (grossAmount * tenantFeeBps) / BPS_DENOMINATOR;
        uint256 landlordFee = (grossAmount * landlordFeeBps) / BPS_DENOMINATOR;
        netAmount = grossAmount - landlordFee;

        IERC20Upgradeable token = IERC20Upgradeable(usdc);
        uint256 totalTransfer = grossAmount + tenantFee;
        token.safeTransferFrom(msg.sender, address(this), totalTransfer);

        address treasury = Platform(platform).treasury();
        if (tenantFee > 0 && treasury != address(0)) {
            token.safeTransfer(treasury, tenantFee);
        }
        if (landlordFee > 0 && treasury != address(0)) {
            token.safeTransfer(treasury, landlordFee);
        }

        _grossRentPaid[bookingId] = totalGrossPaid;
        if (netAmount > 0) {
            _handleLandlordIncome(bookingId, netAmount);
        }

        emit RentPaid(bookingId, msg.sender, grossAmount, netAmount);
    }

    /**
     * @notice Mark a booking as completed once the stay has finished.
     * @param bookingId Identifier of the booking being completed.
     */
    function completeBooking(uint256 bookingId) external onlyLandlordOrPlatform {
        Booking storage booking = _bookings[bookingId];
        require(booking.status == Status.ACTIVE, "not active");
        require(block.timestamp >= booking.end, "stay ongoing");

        booking.status = Status.COMPLETED;
        _releaseBookingRange(bookingId);

        emit BookingCompleted(bookingId, msg.sender);
    }

    /**
     * @notice Cancel an upcoming booking before it begins. Only callable by the landlord or platform
     *         when no rent has been paid.
     * @param bookingId Identifier of the booking being cancelled.
     */
    function cancelBooking(uint256 bookingId) external nonReentrant onlyLandlordOrPlatform {
        Booking storage booking = _bookings[bookingId];
        require(booking.status == Status.ACTIVE, "not active");
        require(block.timestamp < booking.start, "already started");
        require(!_depositReleased[bookingId], "deposit handled");
        require(_grossRentPaid[bookingId] == 0, "rent paid");
        require(!booking.tokenised && booking.soldSqmu == 0, "tokenised");

        _cancelUpcomingBooking(bookingId, booking, msg.sender);

        uint256 deposit = booking.deposit;
        if (deposit > 0) {
            booking.deposit = 0;
            _depositReleased[bookingId] = true;
            delete _depositSplitProposals[bookingId];
            _confirmedDepositTenantBps[bookingId] = BPS_DENOMINATOR;
            IERC20Upgradeable(usdc).safeTransfer(booking.tenant, deposit);
            emit DepositReleased(bookingId, msg.sender, deposit, 0);
        }
    }

    function _cancelUpcomingBooking(uint256 bookingId, Booking storage booking, address triggeredBy) internal {
        booking.status = Status.CANCELLED;
        _releaseBookingRange(bookingId);

        emit BookingCancelled(bookingId, triggeredBy);
    }

    /**
     * @notice Handle a tenant default by marking the booking accordingly and allocating the deposit
     *         to the landlord/investors.
     * @param bookingId Identifier of the booking in default.
     */
    function handleDefault(uint256 bookingId) external onlyPlatform {
        Booking storage booking = _bookings[bookingId];
        require(booking.status == Status.ACTIVE, "not active");

        booking.status = Status.DEFAULTED;
        _releaseBookingRange(bookingId);

        if (!_depositReleased[bookingId]) {
            uint256 deposit = booking.deposit;
            if (deposit > 0) {
                booking.deposit = 0;
                _depositReleased[bookingId] = true;
                delete _depositSplitProposals[bookingId];
                _confirmedDepositTenantBps[bookingId] = 0;
                _handleLandlordIncome(bookingId, deposit);
                emit DepositReleased(bookingId, msg.sender, 0, deposit);
            }
        }

        emit BookingDefaulted(bookingId, msg.sender);
    }

    // -------------------------------------------------
    // Deposit management
    // -------------------------------------------------

    /**
     * @notice Landlord proposes how the security deposit should be split between tenant and landlord.
     * @param bookingId Identifier of the booking whose deposit is being split.
     * @param tenantBps Portion allocated to the tenant in basis points.
     */
    function proposeDepositSplit(uint256 bookingId, uint16 tenantBps) external onlyLandlord {
        require(tenantBps <= BPS_DENOMINATOR, "bps too high");
        Booking storage booking = _bookings[bookingId];
        require(booking.status == Status.ACTIVE || booking.status == Status.COMPLETED, "invalid status");
        require(!booking.tokenised, "tokenised");
        require(booking.soldSqmu == 0, "sqmu sold");
        require(!_depositReleased[bookingId], "deposit handled");

        _depositSplitProposals[bookingId] = DepositSplitProposal({exists: true, tenantBps: tenantBps, proposer: msg.sender});

        emit DepositSplitProposed(bookingId, tenantBps, msg.sender);
    }

    /**
     * @notice Platform confirms the deposit split and releases funds to the tenant and landlord.
     * @param bookingId Identifier of the booking whose deposit is being released.
     * @param signature Reserved for future signature validation (currently unused).
     * @return tenantAmount Amount returned to the tenant.
     * @return landlordAmount Amount allocated to the landlord/investors.
     */
    function confirmDepositSplit(uint256 bookingId, bytes calldata signature)
        external
        nonReentrant
        onlyPlatform
        returns (uint256 tenantAmount, uint256 landlordAmount)
    {
        // Silence unused variable warning until signature-based approvals are implemented.
        if (signature.length == 0) {
            // no-op
        }
        Booking storage booking = _bookings[bookingId];
        require(booking.status == Status.ACTIVE || booking.status == Status.COMPLETED, "invalid status");
        require(!booking.tokenised, "tokenised");
        require(booking.soldSqmu == 0, "sqmu sold");
        require(!_depositReleased[bookingId], "deposit handled");

        DepositSplitProposal storage proposal = _depositSplitProposals[bookingId];
        require(proposal.exists, "no proposal");

        uint256 deposit = booking.deposit;
        require(deposit > 0, "no deposit");

        uint16 tenantBps = proposal.tenantBps;
        tenantAmount = (deposit * tenantBps) / BPS_DENOMINATOR;
        landlordAmount = deposit - tenantAmount;

        booking.deposit = 0;
        _depositReleased[bookingId] = true;
        _confirmedDepositTenantBps[bookingId] = tenantBps;
        delete _depositSplitProposals[bookingId];

        if (booking.status == Status.ACTIVE && block.timestamp < booking.start) {
            _cancelUpcomingBooking(bookingId, booking, msg.sender);
        }

        IERC20Upgradeable token = IERC20Upgradeable(usdc);
        if (tenantAmount > 0) {
            token.safeTransfer(booking.tenant, tenantAmount);
        }
        if (landlordAmount > 0) {
            _handleLandlordIncome(bookingId, landlordAmount);
        }

        emit DepositReleased(bookingId, msg.sender, tenantAmount, landlordAmount);
    }

    // -------------------------------------------------
    // Tokenisation lifecycle
    // -------------------------------------------------

    /**
     * @notice Landlord or tenant proposes tokenisation parameters for the booking.
     * @param bookingId Identifier of the booking to tokenise.
     * @param totalSqmu Total number of SQMU-R tokens that will be minted if approved.
     * @param pricePerSqmu Price per SQMU-R token denominated in USDC (6 decimals).
     * @param feeBps Platform fee applied to investments (basis points).
     * @param period Rent distribution interval for informational purposes.
     */
    function proposeTokenisation(
        uint256 bookingId,
        uint256 totalSqmu,
        uint256 pricePerSqmu,
        uint16 feeBps,
        Period period
    ) external {
        require(totalSqmu > 0, "sqmu=0");
        require(pricePerSqmu > 0, "price=0");
        require(feeBps <= BPS_DENOMINATOR, "fee bps too high");
        require(period != Period.NONE, "period none");

        Booking storage booking = _bookings[bookingId];
        require(booking.status == Status.ACTIVE, "not active");
        require(!booking.tokenised, "already tokenised");
        address caller = msg.sender;
        address agent = _bookingAgents[bookingId];
        require(caller == landlord || caller == booking.tenant || caller == agent, "unauthorised");

        if (booking.period != Period.NONE) {
            require(period == booking.period, "period mismatch");
        }

        _tokenisationProposals[bookingId] = TokenisationProposal({
            exists: true,
            proposer: msg.sender,
            totalSqmu: totalSqmu,
            pricePerSqmu: pricePerSqmu,
            feeBps: feeBps,
            period: period
        });

        booking.proposer = msg.sender;

        emit TokenisationProposed(bookingId, msg.sender, totalSqmu, pricePerSqmu, feeBps, period);
    }

    /**
     * @notice Platform approves a pending tokenisation proposal enabling fundraising.
     * @param bookingId Identifier of the booking being tokenised.
     */
    function approveTokenisation(uint256 bookingId) external onlyPlatform {
        Booking storage booking = _bookings[bookingId];
        require(booking.status == Status.ACTIVE, "not active");
        require(!booking.tokenised, "already tokenised");

        TokenisationProposal storage proposal = _tokenisationProposals[bookingId];
        require(proposal.exists, "no proposal");

        booking.tokenised = true;
        booking.totalSqmu = proposal.totalSqmu;
        booking.pricePerSqmu = proposal.pricePerSqmu;
        booking.feeBps = proposal.feeBps;
        if (booking.period == Period.NONE) {
            booking.period = proposal.period;
        } else {
            require(booking.period == proposal.period, "period mismatch");
        }
        booking.proposer = proposal.proposer;

        delete _tokenisationProposals[bookingId];

        emit TokenisationApproved(
            bookingId,
            msg.sender,
            booking.totalSqmu,
            booking.pricePerSqmu,
            booking.feeBps,
            booking.period
        );
    }

    /**
     * @notice Reject a pending tokenisation proposal and clear it from storage.
     * @param bookingId Identifier of the booking whose proposal should be cleared.
     */
    function rejectTokenisation(uint256 bookingId) external onlyPlatform {
        Booking storage booking = _bookings[bookingId];
        require(booking.status != Status.NONE, "unknown booking");
        require(!booking.tokenised, "already tokenised");

        TokenisationProposal storage proposal = _tokenisationProposals[bookingId];
        require(proposal.exists, "no proposal");

        address proposer = proposal.proposer;
        delete _tokenisationProposals[bookingId];
        booking.proposer = address(0);

        emit TokenisationRejected(bookingId, msg.sender, proposer);
    }

    /**
     * @notice Invest in a tokenised booking by purchasing SQMU-R tokens.
     * @param bookingId Identifier of the booking.
     * @param sqmuAmount Number of SQMU-R tokens to purchase.
     * @param recipient Address receiving the minted SQMU-R tokens (defaults to msg.sender when zero).
     * @return totalCost Total USDC transferred from the purchaser.
     */
    function invest(uint256 bookingId, uint256 sqmuAmount, address recipient)
        external
        nonReentrant
        returns (uint256 totalCost)
    {
        require(sqmuAmount > 0, "sqmu=0");
        Booking storage booking = _bookings[bookingId];
        require(booking.status == Status.ACTIVE, "not active");
        require(booking.tokenised, "not tokenised");
        require(booking.pricePerSqmu > 0, "price unset");
        require(booking.totalSqmu > 0, "sqmu unset");
        require(booking.soldSqmu + sqmuAmount <= booking.totalSqmu, "exceeds supply");

        address investor = recipient == address(0) ? msg.sender : recipient;

        totalCost = booking.pricePerSqmu * sqmuAmount;
        require(totalCost > 0, "cost=0");

        IERC20Upgradeable token = IERC20Upgradeable(usdc);
        token.safeTransferFrom(msg.sender, address(this), totalCost);

        uint256 platformFee = (totalCost * booking.feeBps) / BPS_DENOMINATOR;
        address treasury = Platform(platform).treasury();
        if (platformFee > 0 && treasury != address(0)) {
            token.safeTransfer(treasury, platformFee);
        }

        uint256 proceeds = totalCost - platformFee;
        if (proceeds > 0) {
            token.safeTransfer(landlord, proceeds);
        }

        uint256 tokenId = _sqmuTokenId(bookingId);
        IR3ntSQMU sqmu = IR3ntSQMU(sqmuToken);
        sqmu.mint(investor, tokenId, sqmuAmount, "");

        uint256 acc = booking.accRentPerSqmu;
        if (acc > 0) {
            booking.userDebt[investor] += (sqmuAmount * acc) / RENT_PRECISION;
        }

        booking.soldSqmu += sqmuAmount;

        emit SQMUTokensMinted(bookingId, investor, sqmuAmount, totalCost, platformFee);

        if (booking.soldSqmu == booking.totalSqmu) {
            // Best-effort attempt to lock transfers; ignore failures for backwards compatibility.
            try sqmu.lockTransfers(tokenId) {} catch {}
        }
    }

    /**
     * @notice Claim accrued rent for a tokenised booking based on SQMU-R ownership.
     * @param bookingId Identifier of the booking being claimed.
     * @return amount Amount of USDC transferred to the caller.
     */
    function claim(uint256 bookingId) external nonReentrant returns (uint256 amount) {
        Booking storage booking = _bookings[bookingId];
        require(booking.tokenised, "not tokenised");
        require(booking.soldSqmu > 0, "no sqmu minted");

        uint256 tokenId = _sqmuTokenId(bookingId);
        IR3ntSQMU sqmu = IR3ntSQMU(sqmuToken);
        uint256 sqmuBalance = sqmu.balanceOf(msg.sender, tokenId);
        require(sqmuBalance > 0, "no sqmu");

        uint256 acc = booking.accRentPerSqmu;
        uint256 accumulated = (sqmuBalance * acc) / RENT_PRECISION;
        uint256 debt = booking.userDebt[msg.sender];
        require(accumulated > debt, "nothing to claim");

        amount = accumulated - debt;
        booking.userDebt[msg.sender] = accumulated;

        IERC20Upgradeable(usdc).safeTransfer(msg.sender, amount);

        emit Claimed(bookingId, msg.sender, amount);
    }

    /**
     * @notice Preview the claimable rent for a given account without modifying state.
     * @param bookingId Identifier of the booking.
     * @param account Address holding booking SQMU-R tokens.
     * @return pending Amount of USDC currently claimable.
     */
    function previewClaim(uint256 bookingId, address account) external view returns (uint256 pending) {
        Booking storage booking = _bookings[bookingId];
        if (!booking.tokenised || booking.soldSqmu == 0) {
            return 0;
        }

        uint256 tokenId = _sqmuTokenId(bookingId);
        uint256 sqmuBalance = IR3ntSQMU(sqmuToken).balanceOf(account, tokenId);
        if (sqmuBalance == 0) {
            return 0;
        }

        uint256 acc = booking.accRentPerSqmu;
        uint256 accumulated = (sqmuBalance * acc) / RENT_PRECISION;
        uint256 debt = booking.userDebt[account];
        if (accumulated <= debt) {
            return 0;
        }

        pending = accumulated - debt;
    }

    /**
     * @notice Derive the ERC-1155 token id for a booking scoped to this listing instance.
     * @param bookingId Identifier of the booking.
     */
    function _sqmuTokenId(uint256 bookingId) internal view returns (uint256) {
        return (uint256(uint160(address(this))) << 96) | bookingId;
    }

    // -------------------------------------------------
    // Landlord proceeds
    // -------------------------------------------------

    /**
     * @notice Withdraw accrued rent for non-tokenised bookings.
     * @param bookingId Identifier of the booking whose proceeds are being withdrawn.
     * @param recipient Address receiving the funds (defaults to landlord when zero).
     * @return amount Amount transferred to the recipient.
     */
    function withdrawLandlord(uint256 bookingId, address recipient)
        external
        nonReentrant
        onlyLandlord
        returns (uint256 amount)
    {
        amount = _landlordAccruals[bookingId];
        require(amount > 0, "nothing accrued");
        _landlordAccruals[bookingId] = 0;

        address to = recipient == address(0) ? landlord : recipient;
        IERC20Upgradeable(usdc).safeTransfer(to, amount);

        emit LandlordWithdrawal(bookingId, to, amount);
    }

    // -------------------------------------------------
    // Views
    // -------------------------------------------------

    /**
     * @notice Return booking details excluding mapping fields.
     * @param bookingId Identifier of the booking to inspect.
     */
    function bookingInfo(uint256 bookingId) external view returns (BookingView memory info) {
        Booking storage booking = _bookings[bookingId];
        require(booking.status != Status.NONE, "unknown booking");

        info = BookingView({
            tenant: booking.tenant,
            start: booking.start,
            end: booking.end,
            grossRent: booking.rent,
            expectedNetRent: _expectedNetRent[bookingId],
            rentPaid: _grossRentPaid[bookingId],
            deposit: booking.deposit,
            status: booking.status,
            tokenised: booking.tokenised,
            totalSqmu: booking.totalSqmu,
            soldSqmu: booking.soldSqmu,
            pricePerSqmu: booking.pricePerSqmu,
            feeBps: booking.feeBps,
            period: booking.period,
            proposer: booking.proposer,
            accRentPerSqmu: booking.accRentPerSqmu,
            landlordAccrued: _landlordAccruals[bookingId],
            depositReleased: _depositReleased[bookingId],
            depositTenantBps: _confirmedDepositTenantBps[bookingId],
            calendarReleased: _rangeReleased[bookingId]
        });
    }

    /**
     * @notice Return a pending deposit split proposal (if any).
     * @param bookingId Identifier of the booking.
     */
    function pendingDepositSplit(uint256 bookingId) external view returns (DepositSplitView memory viewData) {
        DepositSplitProposal storage proposal = _depositSplitProposals[bookingId];
        viewData = DepositSplitView({exists: proposal.exists, tenantBps: proposal.tenantBps, proposer: proposal.proposer});
    }

    /**
     * @notice Return a pending tokenisation proposal (if any).
     * @param bookingId Identifier of the booking.
     */
    function pendingTokenisation(uint256 bookingId) external view returns (TokenisationView memory viewData) {
        TokenisationProposal storage proposal = _tokenisationProposals[bookingId];
        viewData = TokenisationView({
            exists: proposal.exists,
            proposer: proposal.proposer,
            totalSqmu: proposal.totalSqmu,
            pricePerSqmu: proposal.pricePerSqmu,
            feeBps: proposal.feeBps,
            period: proposal.period
        });
    }

    /**
     * @notice View helper returning landlord accrual for a booking.
     * @param bookingId Identifier of the booking.
     */
    function landlordAccrued(uint256 bookingId) external view returns (uint256) {
        return _landlordAccruals[bookingId];
    }

    /**
     * @notice View helper returning gross rent paid for a booking.
     * @param bookingId Identifier of the booking.
     */
    function grossRentPaid(uint256 bookingId) external view returns (uint256) {
        return _grossRentPaid[bookingId];
    }

    /**
     * @notice View helper returning expected net rent after landlord fees.
     * @param bookingId Identifier of the booking.
     */
    function expectedNetRent(uint256 bookingId) external view returns (uint256) {
        return _expectedNetRent[bookingId];
    }

    // -------------------------------------------------
    // Internal helpers
    // -------------------------------------------------

    function _calculateRent(uint64 start, uint64 end) internal view returns (uint256 rent) {
        uint256 duration = uint256(end) - uint256(start);
        uint256 daysCount = (duration + SECONDS_PER_DAY - 1) / SECONDS_PER_DAY;
        if (daysCount == 0) {
            daysCount = 1;
        }
        if (baseDailyRate > 0) {
            require(daysCount <= type(uint256).max / baseDailyRate, "rent overflow");
        }
        rent = baseDailyRate * daysCount;
    }

    function _maxInstallmentAmount(Booking storage booking) internal view returns (uint256) {
        uint256 periodDays = _periodDays(booking.period);
        if (periodDays == 0) {
            return booking.rent;
        }

        if (booking.end <= booking.start) {
            return booking.rent;
        }

        uint256 duration = uint256(booking.end) - uint256(booking.start);
        uint256 daysCount = (duration + SECONDS_PER_DAY - 1) / SECONDS_PER_DAY;
        if (daysCount == 0) {
            daysCount = 1;
        }

        uint256 dailyRate = booking.rent / daysCount;
        if (dailyRate * daysCount < booking.rent) {
            dailyRate += 1;
        }

        uint256 installment = dailyRate * periodDays;
        if (installment > booking.rent) {
            installment = booking.rent;
        }

        return installment;
    }

    function _periodDays(Period period) internal pure returns (uint256) {
        if (period == Period.DAY) {
            return 1;
        }
        if (period == Period.WEEK) {
            return DAYS_PER_WEEK;
        }
        if (period == Period.MONTH) {
            return DAYS_PER_MONTH;
        }
        return 0;
    }

    function _releaseBookingRange(uint256 bookingId) internal {
        if (_rangeReleased[bookingId]) {
            return;
        }
        Booking storage booking = _bookings[bookingId];
        _rangeReleased[bookingId] = true;
        if (booking.start != 0 || booking.end != 0) {
            IBookingRegistry(bookingRegistry).release(booking.start, booking.end);
        }
    }

    function _handleLandlordIncome(uint256 bookingId, uint256 amount) internal {
        if (amount == 0) {
            return;
        }

        Booking storage booking = _bookings[bookingId];
        if (booking.tokenised && booking.soldSqmu > 0) {
            booking.accRentPerSqmu += (amount * RENT_PRECISION) / booking.soldSqmu;
        } else {
            _landlordAccruals[bookingId] += amount;
        }
    }
}
