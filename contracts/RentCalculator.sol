// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

library RentCalculator {
    function calcRent(
        uint96 rateDaily,
        uint96 rateWeekly,
        uint96 rateMonthly,
        uint8 rtype,
        uint256 units
    ) internal pure returns (uint96) {
        uint256 rate;
        if (rtype == 0)       rate = rateDaily;
        else if (rtype == 1)  rate = rateWeekly;
        else                  rate = rateMonthly;
        require(units > 0, "units=0");
        require(rate > 0, "rate not offered");
        uint256 rent = rate * units;
        require(rent <= type(uint96).max, "rent overflow");
        return uint96(rent);
    }
}
