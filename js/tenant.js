// /js/tenant.js
import {
  publicClient,
  getWalletClient,
  ensureWritable,
  toUnits,
  fromUnits,
  readVar,
  readStruct,
  simulateAndWrite,
} from "./shared.js";

import {
  R3NT_ADDRESS,
  USDC_ADDRESS,
  FEE_BPS,
} from "./config.js";

import r3nt from "./abi/r3nt.json" assert { type: "json" };
const r3ntAbi = r3nt.abi;
import usdc from "./abi/USDC.json" assert { type: "json" };
const erc20Abi = usdc.abi;

const els = {
  viewPass: document.getElementById("view-pass"),
  book: document.getElementById("book"),
  myBookings: document.getElementById("my-bookings"),
};

async function getAddresses() {
  const w = await getWalletClient();
  return w ? { walletClient: w.walletClient, account: w.account } : { walletClient: null, account: null };
}

async function renderViewPass() {
  const viewFee = await readVar(R3NT_ADDRESS, r3ntAbi, "viewFee");
  const feeStr = fromUnits(viewFee, 6);
  const { walletClient, account } = await getAddresses();

  let expiry = 0n;
  if (account) {
    expiry = await publicClient.readContract({
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "viewPassExpiry",
      args: [account],
    });
  }

  let html = `<div class="card">
    <h3>View Pass</h3>
    <p>Price: USDC ${feeStr} · Expires: ${expiry > 0n ? new Date(Number(expiry) * 1000).toLocaleString() : "None"}</p>`;

  if (!walletClient) {
    html += `<div class="banner banner--readonly">Read-only. Open inside Farcaster Mini App to purchase.</div></div>`;
    els.viewPass.innerHTML = html;
    return;
  }

  const allowance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, R3NT_ADDRESS],
  });

  if (allowance < viewFee) {
    html += `<button id="approveViewPass" class="btn">Approve USDC</button> `;
  }
  html += `<button id="buyViewPass" class="btn">Buy View Pass</button></div>`;
  els.viewPass.innerHTML = html;

  const approveBtn = document.getElementById("approveViewPass");
  if (approveBtn) {
    approveBtn.onclick = async () => {
      await ensureWritable();
      await simulateAndWrite({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "approve",
        args: [R3NT_ADDRESS, viewFee],
      });
      renderViewPass();
    };
  }

  document.getElementById("buyViewPass").onclick = async () => {
    await ensureWritable();
    await simulateAndWrite({
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "buyViewPass",
      args: [],
    });
    renderViewPass();
  };
}

function bookFormHTML() {
  return `<div class="card">
    <h3>Book Listing</h3>
    <div class="grid">
      <label>Listing ID <input id="listingId" type="number" min="0" /></label>
      <label>Rate Type
        <select id="rateType">
          <option value="0">Daily</option>
          <option value="1">Weekly</option>
          <option value="2">Monthly</option>
        </select>
      </label>
      <label>Units <input id="units" type="number" min="1" value="1"/></label>
      <label>Start (unix) <input id="start" type="number"/></label>
      <label>End (unix) <input id="end" type="number"/></label>
    </div>
    <div id="quote" class="muted">Enter Listing ID to preview totals</div>
    <button id="btnApproveBook" class="btn btn-secondary" disabled>Approve USDC</button>
    <button id="btnBook" class="btn" disabled>Book</button>
  </div>`;
}

async function renderBook() {
  els.book.innerHTML = bookFormHTML();

  const idEl = document.getElementById("listingId");
  const typeEl = document.getElementById("rateType");
  const unitsEl = document.getElementById("units");
  const startEl = document.getElementById("start");
  const endEl = document.getElementById("end");
  const quoteEl = document.getElementById("quote");
  const approveBtn = document.getElementById("btnApproveBook");
  const bookBtn = document.getElementById("btnBook");

  async function refreshQuote() {
    const id = idEl.value ? BigInt(idEl.value) : null;
    const units = BigInt(unitsEl.value || "0");
    if (id === null) return;
    try {
      const li = await readStruct(R3NT_ADDRESS, r3ntAbi, "getListing", [id]);
      // pick rate
      let rate = li.rateDaily;
      if (typeEl.value === "1") rate = li.rateWeekly;
      if (typeEl.value === "2") rate = li.rateMonthly;

      if (rate === 0n || units === 0n) {
        quoteEl.textContent = "Select a non-zero rate & units.";
        approveBtn.disabled = true; bookBtn.disabled = true; return;
      }

      const rent = rate * units;
      const fee = (rent * BigInt(FEE_BPS)) / 10000n;
      const tenantHalf = fee / 2n;
      const landlordHalf = fee - tenantHalf;
      const deposit = li.deposit;

      const { account } = await getAddresses();
      let allowance = 0n;
      if (account) {
        allowance = await publicClient.readContract({
          address: li.usdc,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account, R3NT_ADDRESS],
        });
      }

      const totalTenant = rent + tenantHalf + deposit;

      quoteEl.innerHTML = `
        <ul>
          <li>Rent: <b>${fromUnits(rent, 6)}</b></li>
          <li>Platform fee (1%): ${fromUnits(fee, 6)} (0.5% tenant = ${fromUnits(tenantHalf, 6)}; 0.5% landlord = ${fromUnits(landlordHalf, 6)})</li>
          <li>Deposit: ${fromUnits(deposit, 6)}</li>
          <li>Total you pay now: <b>${fromUnits(totalTenant, 6)}</b></li>
          <li>Landlord receives now: <b>${fromUnits(rent - landlordHalf, 6)}</b></li>
        </ul>
      `;

      approveBtn.disabled = !(account && allowance < totalTenant);
      bookBtn.disabled = !account;
      approveBtn.onclick = async () => {
        await ensureWritable();
        await simulateAndWrite({
          address: li.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [R3NT_ADDRESS, totalTenant],
        });
        refreshQuote();
      };

      bookBtn.onclick = async () => {
        await ensureWritable();
        const start = BigInt(startEl.value || "0");
        const end = BigInt(endEl.value || "0");
        if (end <= start) return alert("End must be > start");
        await simulateAndWrite({
          address: R3NT_ADDRESS,
          abi: r3ntAbi,
          functionName: "book",
          args: [id, Number(typeEl.value), BigInt(units), start, end],
        });
        renderMyBookings();
      };
    } catch (e) {
      quoteEl.textContent = "Listing not found or invalid.";
      approveBtn.disabled = true; bookBtn.disabled = true;
    }
  }

  [idEl, typeEl, unitsEl, startEl, endEl].forEach(el => el.addEventListener("input", refreshQuote));
  refreshQuote();
}

async function renderMyBookings() {
  const { account } = await getAddresses();
  const n = await readVar(R3NT_ADDRESS, r3ntAbi, "bookingsCount");
  const rows = [];
  for (let i = 0n; i < n; i++) {
    const b = await readStruct(R3NT_ADDRESS, r3ntAbi, "getBooking", [i]);
    if (account && b.tenant.toLowerCase() === account.toLowerCase()) {
      rows.push({
        id: Number(i),
        listingId: Number(b.listingId),
        start: Number(b.startDate),
        end: Number(b.endDate),
        rent: fromUnits(b.rentAmount, 6),
        fee: fromUnits(b.feeAmount, 6),
        deposit: fromUnits(b.depositAmount, 6),
        status: ["Booked","Completed","Resolved"][Number(b.status)],
      });
    }
  }
  let html = `<div class="card"><h3>My Bookings</h3>`;
  if (!rows.length) html += `<div class="muted">No bookings.</div>`;
  else {
    html += `<table><thead><tr>
      <th>ID</th><th>Listing</th><th>Start</th><th>End</th><th>Rent</th><th>Fee</th><th>Deposit</th><th>Status</th>
    </tr></thead><tbody>`;
    for (const r of rows) {
      html += `<tr>
        <td>${r.id}</td>
        <td>${r.listingId}</td>
        <td>${new Date(r.start*1000).toLocaleDateString()}</td>
        <td>${new Date(r.end*1000).toLocaleDateString()}</td>
        <td>${r.rent}</td>
        <td>${r.fee}</td>
        <td>${r.deposit}</td>
        <td>${r.status}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }
  html += `</div>`;
  els.myBookings.innerHTML = html;
}

document.addEventListener("DOMContentLoaded", async () => {
  await renderViewPass();
  await renderBook();
  await renderMyBookings();
});
