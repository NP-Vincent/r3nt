// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { IERC1155 } from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

interface IR3NTCore {
    function USDC() external view returns (IERC20Upgradeable);
}

interface IERC1155Supply is IERC1155 {
    function totalSupply(uint256 id) external view returns (uint256);
}

/// @title RentDistribution
/// @notice Distributes periodic rent payments to token holders.
/// @dev Tenants push payments which are immediately split amongst
///      holders of a given ERC-1155 token ID representing the rent stream.
contract RentDistribution is Initializable, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    IR3NTCore public core;
    IERC20Upgradeable public usdc;

    struct Stream {
        IERC1155Supply token; // ERC-1155 token contract
        uint256 tokenId;      // token ID representing the stream
        uint96 totalRent;     // total rent expected over the stream
        uint96 paid;          // rent paid so far
        uint64 period;        // seconds between payments
        uint64 nextDue;       // next payment due timestamp
        uint64 lastPaid;      // timestamp of last payment
    }

    // streamId => Stream
    mapping(uint256 => Stream) public streams;
    // streamId => registered token holders
    mapping(uint256 => address[]) public holders;

    event StreamCreated(
        uint256 indexed streamId,
        address indexed token,
        uint256 indexed tokenId,
        uint96 totalRent,
        uint64 start,
        uint64 period
    );

    event HolderRegistered(uint256 indexed streamId, address indexed holder);
    event RentPaid(
        uint256 indexed streamId,
        uint96 amount,
        uint64 nextDue,
        uint96 outstanding
    );

    function initialize(IR3NTCore _core) public initializer {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        core = _core;
        usdc = _core.USDC();
    }

    /// @notice Create a new rent stream
    /// @param streamId Identifier for the stream
    /// @param token ERC-1155 token representing shares
    /// @param tokenId Token ID representing this stream
    /// @param totalRent Total rent owed over the life of the stream (6d)
    /// @param start First due timestamp
    /// @param period Interval between payments in seconds
    function createStream(
        uint256 streamId,
        IERC1155Supply token,
        uint256 tokenId,
        uint96 totalRent,
        uint64 start,
        uint64 period
    ) external onlyOwner {
        require(address(streams[streamId].token) == address(0), "exists");
        streams[streamId] = Stream({
            token: token,
            tokenId: tokenId,
            totalRent: totalRent,
            paid: 0,
            period: period,
            nextDue: start,
            lastPaid: 0
        });
        emit StreamCreated(streamId, address(token), tokenId, totalRent, start, period);
    }

    /// @notice Register as a token holder to receive distributions
    function registerHolder(uint256 streamId, address holder) public {
        Stream storage s = streams[streamId];
        require(address(s.token) != address(0), "no stream");
        require(s.token.balanceOf(holder, s.tokenId) > 0, "no tokens");
        address[] storage list = holders[streamId];
        for (uint256 i = 0; i < list.length; i++) {
            require(list[i] != holder, "exists");
        }
        list.push(holder);
        emit HolderRegistered(streamId, holder);
    }

    /// @notice Push a rent payment which is immediately split to token holders
    /// @param streamId Stream identifier
    /// @param amount Rent amount being paid (6d)
    function payRent(uint256 streamId, uint96 amount) external nonReentrant {
        Stream storage s = streams[streamId];
        require(address(s.token) != address(0), "no stream");
        require(block.timestamp >= s.nextDue, "not due");
        require(s.paid + amount <= s.totalRent, "overpay");

        uint256 supply = s.token.totalSupply(s.tokenId);
        require(supply > 0, "zero supply");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        address[] memory list = holders[streamId];
        for (uint256 i = 0; i < list.length; i++) {
            uint256 bal = s.token.balanceOf(list[i], s.tokenId);
            if (bal > 0) {
                uint256 share = amount * bal / supply;
                usdc.safeTransfer(list[i], share);
            }
        }

        s.paid += amount;
        s.lastPaid = uint64(block.timestamp);
        s.nextDue += s.period;

        emit RentPaid(streamId, amount, s.nextDue, s.totalRent - s.paid);
    }

    /// @notice Return outstanding rent for a stream
    function outstanding(uint256 streamId) external view returns (uint96) {
        Stream storage s = streams[streamId];
        return s.totalRent - s.paid;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}

