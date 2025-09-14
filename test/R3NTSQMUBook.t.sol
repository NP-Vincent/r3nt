// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {R3NTSQMU, IR3NT, IBookingRegistry} from "../contracts/r3nt-SQMU.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("MockUSDC", "mUSDC") {}
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockCore is IR3NT {
    IERC20 private _usdc;
    address private _platform;
    constructor(IERC20 usdc_, address platform_) {
        _usdc = usdc_;
        _platform = platform_;
    }
    function USDC() external view returns (IERC20) { return _usdc; }
    function platform() external view returns (address) { return _platform; }
}

contract MockBookingRegistry is IBookingRegistry {
    function reserve(address, address, uint64, uint64) external override {}
    function release(address, uint64, uint64) external override {}
}

contract R3NTSQMUBookTest is Test, ERC1155Holder {
    MockUSDC usdc;
    MockCore core;
    MockBookingRegistry registry;
    R3NTSQMU sqmu;
    address landlord = address(0x1);
    address platform = address(0x2);

    function setUp() public {
        usdc = new MockUSDC();
        core = new MockCore(IERC20(address(usdc)), platform);
        registry = new MockBookingRegistry();
        sqmu = new R3NTSQMU();
        sqmu.initialize(core, address(registry), "uri");
    }

    function prepare(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(sqmu), amount);
    }

    function testBookFailsIfLessThanThreeWeeks() public {
        prepare(1_000_000);
        vm.expectRevert(bytes("duration < 3 weeks"));
        sqmu.book(address(0xA), landlord, 1, 1_000_000, 0, 1_814_399);
    }

    function testBookSucceedsForThreeWeeksOrMore() public {
        prepare(1_000_000);
        sqmu.book(address(0xA), landlord, 1, 1_000_000, 0, 1_814_400);
    }
}

