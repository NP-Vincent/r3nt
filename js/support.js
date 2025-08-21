// /js/support.js
import r3ntAbi from "./abi/r3nt.json" assert { type: "json" };
import { R3NT_ADDRESS } from "./config.js";
import { ensureWritable, simulateAndWrite, ready, maybeShowReadOnlyBanner } from "./shared.js";

window.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("release-form")?.addEventListener("submit", confirmRelease);
  await maybeShowReadOnlyBanner();
  await ready();
});

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
    console.error(err);
  }
}
