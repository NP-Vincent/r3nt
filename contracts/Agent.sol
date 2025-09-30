// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {SafeERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

/// @notice Minimal interface for interacting with a listing clone.
interface IListingLike {
    /// @notice Booking lifecycle statuses (mirrors `Listing.Status`).
    enum Status {
        NONE,
        ACTIVE,
        COMPLETED,
        CANCELLED,
        DEFAULTED
    }

    /// @notice Supported rent payment intervals (mirrors `Listing.Period`).
    enum Period {
        NONE,
        DAY,
        WEEK,
        MONTH
    }

    /// @notice View struct returned by `Listing.bookingInfo`.
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

    function platform() external view returns (address);

    function landlord() external view returns (address);

    function bookingRegistry() external view returns (address);

    function sqmuToken() external view returns (address);

    function usdc() external view returns (address);

    function proposeTokenisation(
        uint256 bookingId,
        uint256 totalSqmu,
        uint256 pricePerSqmu,
        uint16 feeBps,
        Period period
    ) external;

    function bookingInfo(uint256 bookingId) external view returns (BookingView memory info);
}

/// @notice Minimal interface for retrieving the platform treasury address.
interface IPlatformLike {
    function treasury() external view returns (address);
}

/// @notice Minimal interface for the booking registry used by listings.
interface IBookingRegistry {
    function reserve(uint64 start, uint64 end) external returns (uint64, uint64);

    function release(uint64 start, uint64 end) external returns (uint64, uint64);
}

/// @notice Minimal interface for interacting with the r3nt-SQMU token contract.
interface IR3ntSQMU {
    function mint(address to, uint256 id, uint256 amount, bytes calldata data) external;

    function lockTransfers(uint256 id) external;

    function balanceOf(address account, uint256 id) external view returns (uint256);
}

/**
 * @title Agent
 * @notice Wrapper contract that represents an on-chain property manager for a long-term booking.
 *         The agent coordinates the initial fundraising to pre-pay the landlord, manages
 *         short-term subletting and streams rent to SQMU-R investors while skimming an agent fee.
 * @dev Upgradeable through the UUPS proxy pattern. Upgrade authority is derived from the
 *      underlying listing's platform contract to keep multi-sig control aligned with other
 *      protocol modules.
 */
contract Agent is Initializable, UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice Precision used for rent accumulator calculations.
    uint256 private constant RENT_PRECISION = 1e18;

    /// @notice Basis point denominator used for fee calculations.
    uint16 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Address of the wrapped listing clone.
    address public listing;

    /// @notice Identifier of the long-term booking managed by this agent.
    uint256 public bookingId;

    /// @notice Platform contract coordinating listings and treasury distribution.
    address public platform;

    /// @notice Landlord receiving the upfront rent payment.
    address public landlord;

    /// @notice Booking registry responsible for calendar management.
    address public bookingRegistry;

    /// @notice SQMU-R token contract used for investor receipts.
    address public sqmuToken;

    /// @notice USDC token used for all settlements.
    address public usdc;

    /// @notice Wallet authorised to operate the agent.
    address public agent;

    /// @notice Recipient of accumulated agent fees (defaults to the agent wallet).
    address public agentFeeRecipient;

    /// @notice Agent fee expressed in basis points of each rent payment.
    uint16 public agentFeeBps;

    /// @notice Total SQMU-R supply allocated to this fundraising round.
    uint256 public totalSqmu;

    /// @notice SQMU-R price in USDC (6 decimals) for the upfront fundraising.
    uint256 public pricePerSqmu;

    /// @notice Platform fee in basis points applied during fundraising contributions.
    uint16 public fundraisingFeeBps;

    /// @notice Number of SQMU-R tokens minted to investors.
    uint256 public soldSqmu;

    /// @notice Aggregate amount of USDC raised from investors (before platform fees).
    uint256 public totalRaised;

    /// @notice Indicates whether fundraising is currently active.
    bool public fundraisingActive;

    /// @notice Indicates whether fundraising has been permanently closed.
    bool public fundraisingClosed;

    /// @notice Rent accumulator tracked per SQMU-R token.
    uint256 public accRentPerSqmu;

    /// @notice Tracks the rent debt settled for each investor to avoid double claiming.
    mapping(address => uint256) public investorDebt;

    /// @notice Records each investor's total USDC contribution for off-chain accounting.
    mapping(address => uint256) public contributions;

    /// @notice Accrued agent fees awaiting withdrawal.
    uint256 public agentFeesAccrued;

    /// @notice Incrementing identifier for short-term sub-bookings handled by the agent.
    uint256 public nextSubBookingId;

    /// @notice Snapshot of a sub-booking managed by the agent.
    struct SubBooking {
        address tenant;
        uint64 start;
        uint64 end;
        uint256 expectedRent;
        uint256 paidRent;
        bool active;
        bool calendarReleased;
    }

    /// @notice Mapping of sub-booking identifiers to their details.
    mapping(uint256 => SubBooking) public subBookings;

    event AgentInitialized(
        address indexed listing,
        uint256 indexed bookingId,
        address indexed agent,
        uint16 agentFeeBps
    );
    event AgentUpdated(address indexed previousAgent, address indexed newAgent);
    event AgentFeeUpdated(uint16 previousFeeBps, uint16 newFeeBps);
    event AgentFeeRecipientUpdated(address indexed previousRecipient, address indexed newRecipient);
    event FundraisingConfigured(
        uint256 indexed bookingId,
        uint256 totalSqmu,
        uint256 pricePerSqmu,
        uint16 feeBps,
        IListingLike.Period period
    );
    event FundraisingOpened(uint256 indexed bookingId);
    event FundraisingClosed(uint256 indexed bookingId, uint256 soldSqmu, uint256 totalRaised);
    event Investment(
        address indexed purchaser,
        address indexed recipient,
        uint256 indexed bookingId,
        uint256 sqmuAmount,
        uint256 totalCost,
        uint256 platformFee
    );
    event RentRecorded(uint256 indexed bookingId, address indexed payer, uint256 grossAmount, uint256 agentFee);
    event Claimed(uint256 indexed bookingId, address indexed account, address indexed recipient, uint256 amount);
    event AgentFeesWithdrawn(address indexed recipient, uint256 amount);
    event SubBookingCreated(
        uint256 indexed subBookingId,
        address indexed tenant,
        uint64 start,
        uint64 end,
        uint256 expectedRent
    );
    event SubBookingCompleted(uint256 indexed subBookingId, uint256 paidRent);
    event SubBookingCancelled(uint256 indexed subBookingId, uint256 paidRent, bool defaulted);

    modifier onlyAgent() {
        require(_msgSender() == agent, "not agent");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize an agent contract for a pre-existing long-term booking.
     * @param listing_ Address of the landlord's listing clone.
     * @param bookingId_ Identifier of the long-term booking managed by this agent.
     * @param agent_ Wallet authorised to operate the agent contract.
     * @param agentFeeBps_ Fee retained by the agent on each rent payment (basis points).
     * @param agentFeeRecipient_ Recipient of accrued agent fees (defaults to agent when zero).
     */
    function initialize(
        address listing_,
        uint256 bookingId_,
        address agent_,
        uint16 agentFeeBps_,
        address agentFeeRecipient_
    ) external initializer {
        require(listing_ != address(0), "listing=0");
        require(bookingId_ != 0, "booking=0");
        require(agent_ != address(0), "agent=0");
        require(agentFeeBps_ <= BPS_DENOMINATOR, "fee bps too high");

        IListingLike listingContract = IListingLike(listing_);

        address platform_ = listingContract.platform();
        address landlord_ = listingContract.landlord();
        address registry_ = listingContract.bookingRegistry();
        address sqmuToken_ = listingContract.sqmuToken();
        address usdc_ = listingContract.usdc();

        require(platform_ != address(0), "platform=0");
        require(landlord_ != address(0), "landlord=0");
        require(registry_ != address(0), "registry=0");
        require(sqmuToken_ != address(0), "sqmu=0");
        require(usdc_ != address(0), "usdc=0");

        __ReentrancyGuard_init();
        __Ownable_init(platform_);
        __UUPSUpgradeable_init();

        listing = listing_;
        bookingId = bookingId_;
        platform = platform_;
        landlord = landlord_;
        bookingRegistry = registry_;
        sqmuToken = sqmuToken_;
        usdc = usdc_;

        agent = agent_;
        agentFeeRecipient = agentFeeRecipient_ == address(0) ? agent_ : agentFeeRecipient_;
        agentFeeBps = agentFeeBps_;
        nextSubBookingId = 1;

        emit AgentInitialized(listing_, bookingId_, agent_, agentFeeBps_);
    }

    // -------------------------------------------------
    // Configuration & fundraising lifecycle
    // -------------------------------------------------

    /**
     * @notice Configure the fundraising parameters and forward the proposal to the listing.
     * @dev The platform must subsequently approve the proposal on the listing before fundraising
     *      can be opened via {openFundraising}.
     * @param totalSqmu_ Total number of SQMU-R tokens that will be minted.
     * @param pricePerSqmu_ Price per SQMU-R token denominated in USDC (6 decimals).
     * @param feeBps_ Platform fee (basis points) applied to investments.
     * @param period_ Informational rent distribution interval passed through to the listing.
     */
    function configureFundraising(
        uint256 totalSqmu_,
        uint256 pricePerSqmu_,
        uint16 feeBps_,
        IListingLike.Period period_
    ) external onlyAgent {
        require(!fundraisingActive, "fundraising active");
        require(!fundraisingClosed, "fundraising closed");
        require(totalSqmu_ > 0, "sqmu=0");
        require(pricePerSqmu_ > 0, "price=0");
        require(feeBps_ <= BPS_DENOMINATOR, "fee bps too high");
        require(period_ != IListingLike.Period.NONE, "period none");

        totalSqmu = totalSqmu_;
        pricePerSqmu = pricePerSqmu_;
        fundraisingFeeBps = feeBps_;

        IListingLike(listing).proposeTokenisation(bookingId, totalSqmu_, pricePerSqmu_, feeBps_, period_);

        emit FundraisingConfigured(bookingId, totalSqmu_, pricePerSqmu_, feeBps_, period_);
    }

    /**
     * @notice Open fundraising once the platform has approved the listing tokenisation proposal.
     */
    function openFundraising() external onlyAgent {
        require(!fundraisingActive, "fundraising active");
        require(!fundraisingClosed, "fundraising closed");
        require(totalSqmu > 0 && pricePerSqmu > 0, "config incomplete");

        IListingLike.BookingView memory info = IListingLike(listing).bookingInfo(bookingId);
        require(info.tokenised, "not approved");
        require(info.totalSqmu == totalSqmu, "sqmu mismatch");
        require(info.pricePerSqmu == pricePerSqmu, "price mismatch");
        require(info.feeBps == fundraisingFeeBps, "fee mismatch");

        fundraisingActive = true;

        emit FundraisingOpened(bookingId);
    }

    /**
     * @notice Permanently close fundraising once the upfront payment has been fulfilled.
     * @dev Attempts to lock SQMU-R transfers to preserve accumulator invariants.
     */
    function closeFundraising() external onlyAgent {
        require(fundraisingActive, "not active");

        fundraisingActive = false;
        fundraisingClosed = true;

        _attemptLockTransfers();

        emit FundraisingClosed(bookingId, soldSqmu, totalRaised);
    }

    /**
     * @notice Invest in the long-term booking and receive SQMU-R tokens representing rent claims.
     * @param sqmuAmount Number of SQMU-R tokens to mint.
     * @param recipient Address receiving the SQMU-R tokens (defaults to msg.sender when zero).
     * @return totalCost Total USDC transferred from the purchaser.
     */
    function invest(uint256 sqmuAmount, address recipient)
        external
        nonReentrant
        returns (uint256 totalCost)
    {
        require(fundraisingActive, "fundraising inactive");
        require(sqmuAmount > 0, "sqmu=0");
        require(soldSqmu + sqmuAmount <= totalSqmu, "exceeds supply");

        address investor = recipient == address(0) ? msg.sender : recipient;

        totalCost = pricePerSqmu * sqmuAmount;
        require(totalCost > 0, "cost=0");

        IERC20Upgradeable token = IERC20Upgradeable(usdc);
        token.safeTransferFrom(msg.sender, address(this), totalCost);

        uint256 platformFee = (totalCost * fundraisingFeeBps) / BPS_DENOMINATOR;
        if (platformFee > 0) {
            address treasury = IPlatformLike(platform).treasury();
            if (treasury != address(0)) {
                token.safeTransfer(treasury, platformFee);
            }
        }

        uint256 proceeds = totalCost - platformFee;
        if (proceeds > 0) {
            token.safeTransfer(landlord, proceeds);
        }

        uint256 tokenId = _sqmuTokenId();
        IR3ntSQMU(sqmuToken).mint(investor, tokenId, sqmuAmount, "");

        uint256 acc = accRentPerSqmu;
        if (acc > 0) {
            investorDebt[investor] += (sqmuAmount * acc) / RENT_PRECISION;
        }

        soldSqmu += sqmuAmount;
        totalRaised += totalCost;
        contributions[investor] += totalCost;

        emit Investment(msg.sender, investor, bookingId, sqmuAmount, totalCost, platformFee);

        if (soldSqmu == totalSqmu) {
            fundraisingActive = false;
            fundraisingClosed = true;
            _attemptLockTransfers();

            emit FundraisingClosed(bookingId, soldSqmu, totalRaised);
        }
    }

    // -------------------------------------------------
    // Rent collection & distribution
    // -------------------------------------------------

    /**
     * @notice Collect rent from a long-term tenant and distribute proceeds to investors.
     * @param payer Address providing the USDC payment.
     * @param grossAmount Gross rent amount being settled.
     * @return netAmount Net amount accrued to investors after the agent fee.
     */
    function collectRent(address payer, uint256 grossAmount)
        external
        onlyAgent
        nonReentrant
        returns (uint256 netAmount)
    {
        netAmount = _collectRent(payer, grossAmount);
        emit RentRecorded(bookingId, payer, grossAmount, grossAmount - netAmount);
    }

    /**
     * @notice Create a short-term sub-booking managed by the agent.
     * @param tenant Address of the sub-tenant (informational).
     * @param start Start timestamp of the sub-booking.
     * @param end End timestamp of the sub-booking.
     * @param expectedRent Expected gross rent for the sub-booking (informational).
     * @return subBookingId Identifier of the newly created sub-booking.
     */
    function createSubBooking(
        address tenant,
        uint64 start,
        uint64 end,
        uint256 expectedRent
    ) external onlyAgent returns (uint256 subBookingId) {
        require(start < end, "invalid range");

        IBookingRegistry(bookingRegistry).reserve(start, end);

        subBookingId = nextSubBookingId++;
        subBookings[subBookingId] = SubBooking({
            tenant: tenant,
            start: start,
            end: end,
            expectedRent: expectedRent,
            paidRent: 0,
            active: true,
            calendarReleased: false
        });

        emit SubBookingCreated(subBookingId, tenant, start, end, expectedRent);
    }

    /**
     * @notice Collect rent for a sub-booking from a specified payer.
     * @param subBookingId Identifier of the sub-booking.
     * @param payer Address providing the USDC payment.
     * @param grossAmount Gross rent amount being settled.
     * @param markComplete Whether to mark the sub-booking as completed and release the calendar.
     * @return netAmount Net amount accrued to investors after the agent fee.
     */
    function collectSubletRent(
        uint256 subBookingId,
        address payer,
        uint256 grossAmount,
        bool markComplete
    ) external onlyAgent nonReentrant returns (uint256 netAmount) {
        SubBooking storage subBooking = subBookings[subBookingId];
        require(subBooking.active, "inactive sub-booking");

        netAmount = _collectRent(payer, grossAmount);

        subBooking.paidRent += grossAmount;

        if (markComplete) {
            subBooking.active = false;
            _releaseSubBookingCalendar(subBooking);
            emit SubBookingCompleted(subBookingId, subBooking.paidRent);
        }

        emit RentRecorded(bookingId, payer, grossAmount, grossAmount - netAmount);
    }

    /**
     * @notice Cancel an active sub-booking and optionally mark it as defaulted.
     * @param subBookingId Identifier of the sub-booking.
     * @param defaulted Whether the cancellation corresponds to a tenant default.
     */
    function cancelSubBooking(uint256 subBookingId, bool defaulted) external onlyAgent {
        SubBooking storage subBooking = subBookings[subBookingId];
        require(subBooking.active, "inactive sub-booking");

        subBooking.active = false;
        _releaseSubBookingCalendar(subBooking);

        emit SubBookingCancelled(subBookingId, subBooking.paidRent, defaulted);
    }

    // -------------------------------------------------
    // Investor claims & agent withdrawals
    // -------------------------------------------------

    /**
     * @notice Claim accrued rent based on SQMU-R holdings.
     * @param recipient Address receiving the funds (defaults to msg.sender when zero).
     * @return amount Amount of USDC transferred to the recipient.
     */
    function claim(address recipient) external nonReentrant returns (uint256 amount) {
        uint256 tokenId = _sqmuTokenId();
        uint256 balance = IR3ntSQMU(sqmuToken).balanceOf(msg.sender, tokenId);
        require(balance > 0, "no sqmu");

        uint256 acc = accRentPerSqmu;
        uint256 accumulated = (balance * acc) / RENT_PRECISION;
        uint256 debt = investorDebt[msg.sender];
        require(accumulated > debt, "nothing to claim");

        amount = accumulated - debt;
        investorDebt[msg.sender] = accumulated;

        address to = recipient == address(0) ? msg.sender : recipient;
        IERC20Upgradeable(usdc).safeTransfer(to, amount);

        emit Claimed(bookingId, msg.sender, to, amount);
    }

    /**
     * @notice Preview the claimable rent for an account without modifying state.
     * @param account Address holding SQMU-R tokens.
     * @return pending Amount of USDC currently claimable.
     */
    function previewClaim(address account) external view returns (uint256 pending) {
        uint256 tokenId = _sqmuTokenId();
        uint256 balance = IR3ntSQMU(sqmuToken).balanceOf(account, tokenId);
        if (balance == 0) {
            return 0;
        }

        uint256 acc = accRentPerSqmu;
        uint256 accumulated = (balance * acc) / RENT_PRECISION;
        uint256 debt = investorDebt[account];
        if (accumulated <= debt) {
            return 0;
        }

        pending = accumulated - debt;
    }

    /**
     * @notice Withdraw accrued agent fees.
     * @param recipient Address receiving the funds (defaults to the configured fee recipient).
     * @return amount Amount transferred to the recipient.
     */
    function withdrawAgentFees(address recipient)
        external
        onlyAgent
        nonReentrant
        returns (uint256 amount)
    {
        amount = agentFeesAccrued;
        require(amount > 0, "nothing accrued");
        agentFeesAccrued = 0;

        address to = recipient == address(0) ? agentFeeRecipient : recipient;
        IERC20Upgradeable(usdc).safeTransfer(to, amount);

        emit AgentFeesWithdrawn(to, amount);
    }

    /**
     * @notice Update the agent wallet controlling the contract.
     * @param newAgent Address of the new agent wallet.
     */
    function setAgent(address newAgent) external onlyAgent {
        require(newAgent != address(0), "agent=0");
        address previous = agent;
        agent = newAgent;
        emit AgentUpdated(previous, newAgent);
    }

    /**
     * @notice Update the agent fee (basis points) applied to rent receipts.
     * @param newAgentFeeBps New fee expressed in basis points.
     */
    function setAgentFeeBps(uint16 newAgentFeeBps) external onlyAgent {
        require(newAgentFeeBps <= BPS_DENOMINATOR, "fee bps too high");
        uint16 previous = agentFeeBps;
        agentFeeBps = newAgentFeeBps;
        emit AgentFeeUpdated(previous, newAgentFeeBps);
    }

    /**
     * @notice Update the recipient of accrued agent fees.
     * @param newRecipient Address receiving future fee withdrawals.
     */
    function setAgentFeeRecipient(address newRecipient) external onlyAgent {
        require(newRecipient != address(0), "recipient=0");
        address previous = agentFeeRecipient;
        agentFeeRecipient = newRecipient;
        emit AgentFeeRecipientUpdated(previous, newRecipient);
    }

    // -------------------------------------------------
    // Internal helpers
    // -------------------------------------------------

    function _collectRent(address payer, uint256 grossAmount) internal returns (uint256 netAmount) {
        require(grossAmount > 0, "amount=0");
        require(soldSqmu > 0, "no investors");

        IERC20Upgradeable token = IERC20Upgradeable(usdc);
        token.safeTransferFrom(payer, address(this), grossAmount);

        uint256 agentFee = (grossAmount * agentFeeBps) / BPS_DENOMINATOR;
        if (agentFee > 0) {
            agentFeesAccrued += agentFee;
        }

        netAmount = grossAmount - agentFee;
        if (netAmount > 0) {
            accRentPerSqmu += (netAmount * RENT_PRECISION) / soldSqmu;
        }
    }

    function _releaseSubBookingCalendar(SubBooking storage subBooking) internal {
        if (!subBooking.calendarReleased) {
            subBooking.calendarReleased = true;
            IBookingRegistry(bookingRegistry).release(subBooking.start, subBooking.end);
        }
    }

    function _sqmuTokenId() internal view returns (uint256) {
        return (uint256(uint160(listing)) << 96) | bookingId;
    }

    function _attemptLockTransfers() internal {
        uint256 tokenId = _sqmuTokenId();
        try IR3ntSQMU(sqmuToken).lockTransfers(tokenId) {} catch {}
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
