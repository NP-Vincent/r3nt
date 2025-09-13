// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IBookingRegistry {
    function reserve(address listing, address tenant, uint64 startTsUTC, uint64 endTsUTC) external;
    function release(address listing, uint64 startTsUTC, uint64 endTsUTC) external;
}

interface IR3NT {
    function USDC() external view returns (IERC20);
    function platform() external view returns (address);
}

/// @title r3nt-SQMU ERC-1155 token
/// @notice Mints SQMU-R tokens representing square metre bookings and
///         interacts with r3nt and BookingRegistry for calendar management
///         and rent distribution.
contract R3NTSQMU is ERC1155Supply, OwnableUpgradeable {
    using SafeERC20 for IERC20;

    string public constant name = "r3nt-SQMU";
    string public constant symbol = "SQMU-R";

    IR3NT public immutable core;
    IERC20 public immutable usdc;
    address public immutable platform;
    IBookingRegistry public bookingRegistry;

    uint16 public feeBps = 100; // 1% platform fee on rent

    struct Booking {
        address tenant;
        address landlord;
        address listing;
        uint256 area;          // square metres
        uint256 rentPerSqM;    // price per square metre (6d)
        uint64  start;         // UTC midnight
        uint64  end;           // UTC midnight
    }

    /// @notice Request to tokenise rent for a booking
    /// @dev `landlord` indicates if the proposer is the landlord (tokenising
    ///      future rental income) or tenant (tokenising an upfront payment).
    struct TokenizationRequest {
        address proposer;
        bool landlord;
        uint256 amount;   // amount of tokens to mint
        uint16 feeBps;    // platform fee on the tokenised amount
        uint16 rateBps;   // periodic rate in basis points
        uint8  frequency; // 1 = weekly, 2 = monthly
        bool approved;
    }

    mapping(uint256 => TokenizationRequest) public tokenizationRequests;

    event TokenizationProposed(
        uint256 indexed bookingId,
        address indexed proposer,
        bool landlord,
        uint256 amount,
        uint16 feeBps,
        uint16 rateBps,
        uint8 frequency
    );

    event TokenizationApproved(
        uint256 indexed bookingId,
        address indexed proposer,
        uint256 amount,
        uint16 feeBps,
        uint16 rateBps
    );

    mapping(uint256 => Booking) public bookings;
    uint256 public nextId;

    event BookingRegistryUpdated(address indexed bookingRegistry);

    constructor(
        IR3NT _core,
        address _registry,
        string memory uri
    ) ERC1155(uri) initializer {
        __Ownable_init(msg.sender);
        core = _core;
        usdc = _core.USDC();
        platform = _core.platform();
        if (_registry != address(0)) {
            bookingRegistry = IBookingRegistry(_registry);
            emit BookingRegistryUpdated(_registry);
        }
    }

    function setBookingRegistry(address _registry) external onlyOwner {
        require(_registry != address(0), "zero");
        bookingRegistry = IBookingRegistry(_registry);
        emit BookingRegistryUpdated(_registry);
    }

    /// @notice Intake a booking, reserve calendar, distribute rent and mint tokens
    function book(
        address listing,
        address landlord,
        uint256 area,
        uint256 rentPerSqM,
        uint64 startTsUTC,
        uint64 endTsUTC
    ) external returns (uint256 bookingId) {
        bookingId = ++nextId;

        // Reserve nights via BookingRegistry
        bookingRegistry.reserve(listing, msg.sender, startTsUTC, endTsUTC);

        uint256 grossRent = area * rentPerSqM;
        uint256 fee = grossRent * feeBps / 10_000;

        usdc.safeTransferFrom(msg.sender, landlord, grossRent - fee);
        usdc.safeTransferFrom(msg.sender, platform, fee);

        _mint(msg.sender, bookingId, area, "");

        bookings[bookingId] = Booking({
            tenant: msg.sender,
            landlord: landlord,
            listing: listing,
            area: area,
            rentPerSqM: rentPerSqM,
            start: startTsUTC,
            end: endTsUTC
        });
    }

    /// @notice Propose tokenisation of rent for a booking
    /// @param bookingId The booking to tokenise
    /// @param amount Amount of tokens to mint upon approval
    /// @param feeBps_ Proposed platform fee in basis points
    /// @param rateBps_ Proposed periodic rate in basis points
    /// @param frequency 1 = weekly, 2 = monthly
    function proposeTokenization(
        uint256 bookingId,
        uint256 amount,
        uint16 feeBps_,
        uint16 rateBps_,
        uint8 frequency
    ) external {
        Booking memory b = bookings[bookingId];
        require(b.tenant != address(0), "invalid booking");

        bool isLandlord;
        if (msg.sender == b.landlord) {
            isLandlord = true;
        } else if (msg.sender == b.tenant) {
            isLandlord = false;
        } else {
            revert("unauthorized");
        }

        TokenizationRequest storage r = tokenizationRequests[bookingId];
        require(r.proposer == address(0), "exists");

        tokenizationRequests[bookingId] = TokenizationRequest({
            proposer: msg.sender,
            landlord: isLandlord,
            amount: amount,
            feeBps: feeBps_,
            rateBps: rateBps_,
            frequency: frequency,
            approved: false
        });

        emit TokenizationProposed(
            bookingId,
            msg.sender,
            isLandlord,
            amount,
            feeBps_,
            rateBps_,
            frequency
        );
    }

    /// @notice Approve a tokenisation request and mint tokens
    /// @param bookingId Booking identifier
    /// @param feeBps_ Final platform fee in basis points
    /// @param rateBps_ Final periodic rate in basis points
    function approveTokenization(
        uint256 bookingId,
        uint16 feeBps_,
        uint16 rateBps_
    ) external onlyOwner {
        TokenizationRequest storage r = tokenizationRequests[bookingId];
        require(r.proposer != address(0), "no request");
        require(!r.approved, "approved");

        r.feeBps = feeBps_;
        r.rateBps = rateBps_;
        r.approved = true;

        _mint(r.proposer, bookingId, r.amount, "");

        emit TokenizationApproved(
            bookingId,
            r.proposer,
            r.amount,
            feeBps_,
            rateBps_
        );
    }

    /// @notice Release booking and burn tokens after the stay concludes
    function conclude(uint256 bookingId) external {
        Booking memory b = bookings[bookingId];
        require(msg.sender == b.tenant || msg.sender == owner(), "unauthorized");

        bookingRegistry.release(b.listing, b.start, b.end);
        _burn(b.tenant, bookingId, b.area);
        delete bookings[bookingId];
        delete tokenizationRequests[bookingId];
    }
}

