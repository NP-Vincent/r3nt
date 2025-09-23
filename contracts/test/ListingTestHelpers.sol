// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IListingDefault {
    function handleDefault(uint256 bookingId) external;
}

contract MockUSDC is ERC20 {
    uint8 private immutable _customDecimals;

    constructor() ERC20("Mock USDC", "mUSDC") {
        _customDecimals = 6;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockBookingRegistry {
    uint64 public lastReserveStart;
    uint64 public lastReserveEnd;
    uint64 public lastReleaseStart;
    uint64 public lastReleaseEnd;

    function reserve(uint64 start, uint64 end) external returns (uint64, uint64) {
        lastReserveStart = start;
        lastReserveEnd = end;
        return (start, end);
    }

    function release(uint64 start, uint64 end) external returns (uint64, uint64) {
        lastReleaseStart = start;
        lastReleaseEnd = end;
        return (start, end);
    }
}

contract MockPlatform {
    address public usdc;
    address public treasury;
    address public listingFactory;
    address public bookingRegistry;
    address public sqmuToken;
    uint16 public tenantFeeBps;
    uint16 public landlordFeeBps;

    mapping(address => bool) private _viewPass;

    constructor(address usdc_, address bookingRegistry_, address sqmuToken_) {
        usdc = usdc_;
        bookingRegistry = bookingRegistry_;
        sqmuToken = sqmuToken_;
    }

    function setViewPass(address account, bool active) external {
        _viewPass[account] = active;
    }

    function hasActiveViewPass(address account) external view returns (bool) {
        return _viewPass[account];
    }

    function setFees(uint16 tenantFeeBps_, uint16 landlordFeeBps_) external {
        tenantFeeBps = tenantFeeBps_;
        landlordFeeBps = landlordFeeBps_;
    }

    function fees() external view returns (uint16, uint16) {
        return (tenantFeeBps, landlordFeeBps);
    }

    function setTreasury(address treasury_) external {
        treasury = treasury_;
    }

    function setModules(address listingFactory_, address bookingRegistry_, address sqmuToken_) external {
        listingFactory = listingFactory_;
        bookingRegistry = bookingRegistry_;
        sqmuToken = sqmuToken_;
    }

    function modules() external view returns (address, address, address) {
        return (listingFactory, bookingRegistry, sqmuToken);
    }

    function triggerDefault(address listing, uint256 bookingId) external {
        IListingDefault(listing).handleDefault(bookingId);
    }
}

contract MockSQMU {
    function mint(address, uint256, uint256, bytes calldata) external {}

    function burn(address, uint256, uint256) external {}

    function lockTransfers(uint256) external {}

    function balanceOf(address, uint256) external pure returns (uint256) {
        return 0;
    }

    function totalSupply(uint256) external pure returns (uint256) {
        return 0;
    }
}
