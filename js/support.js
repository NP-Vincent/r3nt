// /js/support.js
import r3ntAbi from "./abi/r3nt.json" assert { type: "json" };
import { R3NT_ADDRESS } from "./config.js";
import { ensureWritable, simulateAndWrite, ready, debugLog } from "./shared.js";

ready();

document.getElementById("release-form")?.addEventListener("submit", confirmRelease);

async function confirmRelease(e) {
  e.preventDefault();
  try {
    await ensureWritable();
    const bookingId = BigInt(document.getElementById("bookingId").value);
    const signature = document.getElementById("signature").value.trim();
    await simulateAndWrite({
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "confirmDepositRelease",
      args: [bookingId, signature]
    });
  } catch (err) {
    debugLog(err);
  }
}
