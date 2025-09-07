// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*
 * BookingRegistry — nights-only calendar with month bitmasks.
 * Dependencies: OpenZeppelin (upgradeable) v5.x
 */

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

contract BookingRegistry is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable
{
    // ---- Roles ----
    bytes32 public constant R3NT_ROLE = keccak256("R3NT_ROLE");

    // listing => ym => month bitmask (1 bit per day; bit 0 = day 1)
    mapping(address => mapping(uint32 => uint32)) private _booked;

    // ---- Events ----
    event Reserved(address indexed listing, address indexed tenant, uint32 startDay, uint32 endDayExcl);
    event Released(address indexed listing, address indexed by,     uint32 startDay, uint32 endDayExcl);

    // ---- Init / Upgrade ----
    function initialize(address admin, address r3ntCaller) public initializer {
        __UUPSUpgradeable_init();
        __AccessControl_init();
        __ReentrancyGuard_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (r3ntCaller != address(0)) _grantRole(R3NT_ROLE, r3ntCaller);
    }
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ---- External API ----

    // Reserve a range: startTsUTC inclusive, endTsUTC exclusive (both must be UTC midnights)
    function reserve(address listing, address tenant, uint64 startTsUTC, uint64 endTsUTC)
        external
        onlyRole(R3NT_ROLE)
        nonReentrant
    {
        require(endTsUTC > startTsUTC, "range");
        require(startTsUTC % DAY == 0 && endTsUTC % DAY == 0, "midnight");
        (uint32 sDay, uint32 eDay) = _normalizeTsToDays(startTsUTC, endTsUTC);
        _requireFree(listing, sDay, eDay);
        _mark(listing, sDay, eDay, true);
        emit Reserved(listing, tenant, sDay, eDay);
    }

    // Release a range (e.g., cancellation or admin correction)
    function release(address listing, uint64 startTsUTC, uint64 endTsUTC)
        external
        onlyRole(R3NT_ROLE)
        nonReentrant
    {
        require(endTsUTC > startTsUTC, "range");
        require(startTsUTC % DAY == 0 && endTsUTC % DAY == 0, "midnight");
        (uint32 sDay, uint32 eDay) = _normalizeTsToDays(startTsUTC, endTsUTC);
        _mark(listing, sDay, eDay, false);
        emit Released(listing, msg.sender, sDay, eDay);
    }

    // Read-only: check if a UTC range is entirely free
    function isFree(address listing, uint64 startTsUTC, uint64 endTsUTC)
        external
        view
        returns (bool)
    {
        if (endTsUTC <= startTsUTC) return false;
        (uint32 sDay, uint32 eDay) = _normalizeTsToDays(startTsUTC, endTsUTC);
        return _isFree(listing, sDay, eDay);
    }

    // UI helper: return the month bitmask for (year, month)
    function monthMask(address listing, uint16 year, uint8 month)
        external
        view
        returns (uint32)
    {
        require(month >= 1 && month <= 12, "month");
        uint32 ym = uint32(year) * 12 + (month - 1);
        return _booked[listing][ym];
    }

    // ---- Internal: core marking & checks ----

    uint256 private constant DAY = 86400;

    function _normalizeTsToDays(uint64 sTs, uint64 eTs) internal pure returns (uint32 sDay, uint32 eDay) {
        // Expecting UTC midnights already; still safe to floor by DAY.
        sDay = uint32(uint256(sTs) / DAY);
        eDay = uint32(uint256(eTs) / DAY);
        require(eDay > sDay, "empty");
    }

    function _requireFree(address L, uint32 sDay, uint32 eDay) internal view {
        require(_isFree(L, sDay, eDay), "overlap");
    }

    function _isFree(address L, uint32 sDay, uint32 eDay) internal view returns (bool) {
        (uint16 yS, uint8 mS, uint8 dS) = _civilFromDays(int256(uint256(sDay)));
        (uint16 yE, uint8 mE, uint8 dE) = _civilFromDays(int256(uint256(eDay - 1))); // last occupied day
        uint32 ymS = uint32(yS) * 12 + (mS - 1);
        uint32 ymE = uint32(yE) * 12 + (mE - 1);

        for (uint32 ym = ymS; ym <= ymE; ym++) {
            (uint16 y, uint8 m) = (uint16(ym / 12), uint8(ym % 12) + 1);
            uint32 need = _maskForMonthSpan(y, m, sDay, eDay);
            if ((_booked[L][ym] & need) != 0) return false;
        }
        return true;
    }

    function _mark(address L, uint32 sDay, uint32 eDay, bool setBits) internal {
        (uint16 yS, uint8 mS, ) = _civilFromDays(int256(uint256(sDay)));
        (uint16 yE, uint8 mE, ) = _civilFromDays(int256(uint256(eDay - 1)));
        uint32 ymS = uint32(yS) * 12 + (mS - 1);
        uint32 ymE = uint32(yE) * 12 + (mE - 1);

        for (uint32 ym = ymS; ym <= ymE; ym++) {
            (uint16 y, uint8 m) = (uint16(ym / 12), uint8(ym % 12) + 1);
            uint32 need = _maskForMonthSpan(y, m, sDay, eDay);
            if (need == 0) continue;
            if (setBits) _booked[L][ym] |= need;
            else         _booked[L][ym] &= ~need;
        }
    }

    // Build mask for portion of [sDay, eDay) that lies in (year, month)
    function _maskForMonthSpan(uint16 year, uint8 month, uint32 sDay, uint32 eDay) internal pure returns (uint32) {
        int256 mStartInt = _daysFromCivil(
            int256(uint256(year)),
            int256(uint256(month)),
            1
        );
        require(
            mStartInt >= 0 && mStartInt <= int256(uint256(type(uint32).max)),
            "range"
        );
        uint32 monthStart = uint32(uint256(mStartInt));
        uint8 dim = _daysInMonth(year, month);
        uint32 monthEndExcl = monthStart + dim; // exclusive

        // Intersect [sDay, eDay) with [monthStart, monthEndExcl)
        uint32 a = sDay > monthStart ? sDay : monthStart;
        uint32 b = eDay < monthEndExcl ? eDay : monthEndExcl;
        if (b <= a) return 0;

        // Convert to 1-based day numbers within the month
        uint32 startDayNum = (a - monthStart) + 1;       // 1..dim
        uint32 endDayNumExcl = (b - monthStart) + 1;     // 2..dim+1 (exclusive)

        // Build contiguous mask from startDayNum to (endDayNumExcl-1)
        uint32 span = endDayNumExcl - startDayNum;       // 1..dim
        uint32 ones = span == 32 ? type(uint32).max : (uint32(1) << span) - 1;
        uint32 mask = ones << (startDayNum - 1);
        return mask;
    }

    // ---- Gregorian date helpers (days <-> civil) ----
    // Based on Howard Hinnant's algorithms (public domain).

    function _isLeap(uint16 y) internal pure returns (bool) {
        return (y % 4 == 0) && ((y % 100 != 0) || (y % 400 == 0));
    }

    function _daysInMonth(uint16 y, uint8 m) internal pure returns (uint8) {
        if (m == 2) return _isLeap(y) ? 29 : 28;
        if (m == 4 || m == 6 || m == 9 || m == 11) return 30;
        return 31;
    }

    // days since 1970-01-01 (Unix epoch), can be negative for pre-1970
    function _daysFromCivil(int256 y, int256 m, int256 d) internal pure returns (int256) {
        // Shift March=1 … Feb=12
        y -= (m <= 2) ? int256(1) : int256(0);
        int256 era = (y >= 0 ? y : y - 399) / 400;
        uint256 yoe = uint256(y - era * 400);
        uint256 doy = (153 * uint256(m + (m > 2 ? int256(-3) : int256(9))) + 2) / 5 + uint256(d - int256(1));
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        // 719468 = days from civil 0000-03-01 to 1970-01-01
        return era * 146097 + int256(doe) - 719468;
    }

    function _civilFromDays(int256 z) internal pure returns (uint16 y, uint8 m, uint8 d) {
        z += 719468;
        int256 era = (z >= 0 ? z : z - 146096) / 146097;
        uint256 doe = uint256(z - era * 146097);                        // [0, 146096]
        uint256 yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;  // [0,399]
        int256 yFull = int256(yoe) + era * 400;
        uint256 doy = doe - (365*yoe + yoe/4 - yoe/100);               // [0, 365]
        int256 mp = int256((5*doy + 2) / 153);                         // [0, 11]
        int256 d0 = int256(doy) - (153*mp + 2)/5 + 1;                  // [1, 31]
        int256 m0 = mp + (mp < 10 ? int256(3) : int256(-9));           // [1, 12]
        yFull += (m0 <= 2) ? int256(1) : int256(0);
        y = uint16(uint256(yFull));
        m = uint8(uint256(m0));
        d = uint8(uint256(d0));
    }

    uint256[50] private __gap;
}
