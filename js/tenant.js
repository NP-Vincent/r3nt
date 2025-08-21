// /js/tenant.js
import r3ntAbi from "./abi/r3nt.json" assert { type: "json" };
import usdcAbi from "./abi/USDC.json" assert { type: "json" };
import { R3NT_ADDRESS, USDC_ADDRESS, FEE_BPS } from "./config.js";
import { ensureWritable, simulateAndWrite, readVar, readStruct, ready } from "./shared.js";

ready();

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("pass-form")?.addEventListener("submit", buyPass);
  document.getElementById("book-form")?.addEventListener("submit", book);
});

async function buyPass(e) {
  e.preventDefault();
  try {
    await ensureWritable();
    const fee = await readVar(R3NT_ADDRESS, r3ntAbi, "viewFee");
    await simulateAndWrite({
      address: USDC_ADDRESS,
      abi: usdcAbi,
      functionName: "approve",
      args: [R3NT_ADDRESS, fee]
    });
    await simulateAndWrite({
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "buyViewPass",
      args: []
    });
  } catch (err) {
    console.error(err);
  }
}

function calcRent(rateDaily, rateWeekly, rateMonthly, rtype, units) {
  let rate;
  if (rtype === 0) rate = rateDaily;
  else if (rtype === 1) rate = rateWeekly;
  else rate = rateMonthly;
  if (units <= 0n) throw new Error("units=0");
  if (rate <= 0n) throw new Error("rate not offered");
  return rate * units;
}

async function book(e) {
  e.preventDefault();
  try {
    await ensureWritable();
    const listingId = BigInt(document.getElementById("listingId").value);
    const rtype = Number(document.getElementById("rateType").value);
    const units = BigInt(document.getElementById("units").value);
    const start = BigInt(Math.floor(new Date(document.getElementById("startDate").value).getTime() / 1000));
    const end = BigInt(Math.floor(new Date(document.getElementById("endDate").value).getTime() / 1000));

    const listing = await readStruct(R3NT_ADDRESS, r3ntAbi, "getListing", [listingId]);
    const rent = calcRent(listing.rateDaily, listing.rateWeekly, listing.rateMonthly, rtype, units);
    const fee = rent * BigInt(FEE_BPS) / 10000n;
    const total = rent + fee + listing.deposit;

    await simulateAndWrite({
      address: USDC_ADDRESS,
      abi: usdcAbi,
      functionName: "approve",
      args: [R3NT_ADDRESS, total]
    });

    await simulateAndWrite({
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "book",
      args: [listingId, rtype, units, start, end]
    });
  } catch (err) {
    console.error(err);
  }
}
