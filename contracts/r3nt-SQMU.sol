// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./BookingRegistry.sol";

interface IR3NT {
    function USDC() external view returns (IERC20);
    function platform() external view returns (address);
}

/// @title r3nt-SQMU ERC-1155 token
/// @notice Mints SQMU-R tokens representing square metre bookings and
///         interacts with r3nt and BookingRegistry for calendar management
///         and rent distribution.
contract R3NTSQMU is ERC1155Supply, AccessControl {
    using SafeERC20 for IERC20;

    string public constant name = "r3nt-SQMU";
    string public constant symbol = "SQMU-R";

    bytes32 public constant R3NT_ROLE = keccak256("R3NT_ROLE");

    IR3NT public immutable core;
    IERC20 public immutable usdc;
    address public immutable platform;
    BookingRegistry public immutable registry;

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

    mapping(uint256 => Booking) public bookings;
    uint256 public nextId;

    constructor(
        IR3NT _core,
        BookingRegistry _registry,
        string memory uri
    ) ERC1155(uri) {
        core = _core;
        usdc = _core.USDC();
        platform = _core.platform();
        registry = _registry;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(R3NT_ROLE, msg.sender);
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

        // Reserve nights via BookingRegistry (requires R3NT_ROLE on this contract)
        registry.reserve(listing, msg.sender, startTsUTC, endTsUTC);

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

    /// @notice Release booking and burn tokens after the stay concludes
    function conclude(uint256 bookingId) external {
        Booking memory b = bookings[bookingId];
        require(msg.sender == b.tenant || hasRole(R3NT_ROLE, msg.sender), "unauthorized");

        registry.release(b.listing, b.start, b.end);
        _burn(b.tenant, bookingId, b.area);
        delete bookings[bookingId];
    }
}

