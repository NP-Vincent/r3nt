// /js/landlord.js
import {
  publicClient,
  getWalletClient,
  ensureWritable,
  toUnits,
  fromUnits,
  readVar,
  readStruct,
  simulateAndWrite,
} from "./shared.js"; // create this helper (or inline; see tenant.js for patterns too)

import {
  R3NT_ADDRESS,
  USDC_ADDRESS,
} from "./config.js";

import r3nt from "./abi/r3nt.json" assert { type: "json" };
const r3ntAbi = r3nt.abi;
import usdc from "./abi/USDC.json" assert { type: "json" };
const erc20Abi = usdc.abi;

const els = {
  feeApprove: document.getElementById("fee-approve"),
  createListing: document.getElementById("create-listing"),
  myListings: document.getElementById("my-listings"),
};

async function getAddresses() {
  const w = await getWalletClient();
  return w ? { walletClient: w.walletClient, account: w.account } : { walletClient: null, account: null };
}

async function renderApproveListFee() {
  const listFee = await readVar(R3NT_ADDRESS, r3ntAbi, "listFee");
  const { account, walletClient } = await getAddresses();

  const feeStr = fromUnits(listFee, 6);
  let html = `<div class="card">
    <h3>List Fee</h3>
    <p>USDC ${feeStr}</p>`;

  if (!walletClient) {
    html += `<div class="banner banner--readonly">Read-only. Open inside Farcaster Mini App to list.</div></div>`;
    els.feeApprove.innerHTML = html;
    return;
  }

  const allowance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, R3NT_ADDRESS],
  });

  if (allowance < listFee) {
    html += `<button id="btnApproveListFee" class="btn">Approve USDC</button>`;
  } else {
    html += `<div class="ok">Allowance OK</div>`;
  }
  html += `</div>`;
  els.feeApprove.innerHTML = html;

  const btn = document.getElementById("btnApproveListFee");
  if (btn) {
    btn.onclick = async () => {
      await ensureWritable();
      await simulateAndWrite({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "approve",
        args: [R3NT_ADDRESS, listFee],
      });
      renderApproveListFee();
    };
  }
}

function createListingFormHTML() {
  return `
  <div class="card">
    <h3>Create Listing</h3>
    <div class="grid">
      <label>Deposit (USDC 6d) <input id="dep" type="number" step="0.01" placeholder="e.g. 200.00"/></label>
      <label>Rate Daily <input id="rd" type="number" step="0.01" /></label>
      <label>Rate Weekly <input id="rw" type="number" step="0.01" /></label>
      <label>Rate Monthly <input id="rm" type="number" step="0.01" /></label>
      <label>Geohash <input id="gh" type="text" placeholder="u173z..." /></label>
      <label>FID <input id="fid" type="number" /></label>
      <label>castHash (0x...) <input id="cast" type="text" /></label>
      <label>Title <input id="title" type="text" maxlength="64"/></label>
      <label>Short Desc <input id="desc" type="text" maxlength="160"/></label>
      <label>Signers (one per line, ERC-7913 id)
        <textarea id="signers" rows="3" placeholder="0x..."></textarea>
      </label>
      <label>Threshold <input id="threshold" type="number" value="2"/></label>
    </div>
    <button id="btnCreateListing" class="btn">Create Listing</button>
    <div id="createStatus" class="muted"></div>
  </div>`;
}

async function renderCreateListing() {
  els.createListing.innerHTML = createListingFormHTML();
  const btn = document.getElementById("btnCreateListing");
  btn.onclick = async () => {
    await ensureWritable();
    const { account } = await getAddresses();

    // collect inputs
    const dep = toUnits(document.getElementById("dep").value || "0", 6);
    const rd = toUnits(document.getElementById("rd").value || "0", 6);
    const rw = toUnits(document.getElementById("rw").value || "0", 6);
    const rm = toUnits(document.getElementById("rm").value || "0", 6);
    const geohash = (document.getElementById("gh").value || "").trim();
    const geolen = geohash.length;
    const fid = BigInt(document.getElementById("fid").value || "0");
    const castHash = document.getElementById("cast").value.trim();
    const title = document.getElementById("title").value.trim();
    const shortDesc = document.getElementById("desc").value.trim();
    const signersLines = (document.getElementById("signers").value || "").split("\n").map(s => s.trim()).filter(Boolean);
    const threshold = BigInt(document.getElementById("threshold").value || "2");

    if (geolen < 4 || geolen > 10) return alert("Geohash length must be 4..10");
    if (!castHash.startsWith("0x") || castHash.length !== 66) return alert("castHash must be 32-byte hex (0x + 64)");

    // encode signers as bytes[]
    const signers = signersLines.map(s => s.startsWith("0x") ? s : `0x${s}`);

    const before = await readVar(R3NT_ADDRESS, r3ntAbi, "listingsCount");
    const createStatus = document.getElementById("createStatus");
    createStatus.textContent = "Submitting tx…";

    await simulateAndWrite({
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "createListing",
      args: [
        USDC_ADDRESS,
        dep, rd, rw, rm,
        geohash,
        geolen,
        fid,
        castHash,
        title,
        shortDesc,
        signers,
        threshold,
      ],
    });

    // wait until listing is appended
    let after = before;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      after = await readVar(R3NT_ADDRESS, r3ntAbi, "listingsCount");
      if (after > before) break;
    }
    const id = Number(after) - 1;
    // poll vault existence
    let listing = await readStruct(R3NT_ADDRESS, r3ntAbi, "getListing", [BigInt(id)]);
    for (let i = 0; i < 20 && listing.vault === "0x0000000000000000000000000000000000000000"; i++) {
      await new Promise(r => setTimeout(r, 1500));
      listing = await readStruct(R3NT_ADDRESS, r3ntAbi, "getListing", [BigInt(id)]);
    }
    createStatus.textContent = listing.vault === "0x0000000000000000000000000000000000000000"
      ? "Created, vault pending…"
      : `Created Listing #${id}. Vault: ${listing.vault}`;
    renderMyListings(); // refresh table
  };
}

async function renderMyListings() {
  const { account, walletClient } = await getAddresses();
  const n = await readVar(R3NT_ADDRESS, r3ntAbi, "listingsCount");
  const rows = [];
  for (let i = 0n; i < n; i++) {
    const li = await readStruct(R3NT_ADDRESS, r3ntAbi, "getListing", [i]);
    if (account && li.owner.toLowerCase() === account.toLowerCase()) {
      rows.push({
        id: Number(i),
        active: li.active,
        vault: li.vault,
        title: li.title,
        rateDaily: fromUnits(li.rateDaily, 6),
        deposit: fromUnits(li.deposit, 6),
      });
    }
  }
  let html = `<div class="card"><h3>My Listings</h3>`;
  if (!rows.length) html += `<div class="muted">No listings yet.</div>`;
  else {
    html += `<table><thead><tr>
      <th>ID</th><th>Title</th><th>Deposit</th><th>Daily</th><th>Vault</th><th>Active</th><th></th>
    </tr></thead><tbody>`;
    for (const r of rows) {
      html += `<tr>
        <td>${r.id}</td>
        <td>${r.title || "-"}</td>
        <td>${r.deposit}</td>
        <td>${r.rateDaily}</td>
        <td class="mono">${r.vault}</td>
        <td>${r.active ? "Yes" : "No"}</td>
        <td>${walletClient ? `<button data-id="${r.id}" data-act="${r.active ? 0 : 1}" class="btn btn-sm">Set ${r.active ? "Inactive" : "Active"}</button>` : ""}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }
  html += `</div>`;
  els.myListings.innerHTML = html;

  if (walletClient) {
    els.myListings.querySelectorAll("button[data-id]").forEach(btn => {
      btn.onclick = async () => {
        await ensureWritable();
        const id = BigInt(btn.getAttribute("data-id"));
        const makeActive = btn.getAttribute("data-act") === "1";
        await simulateAndWrite({
          address: R3NT_ADDRESS,
          abi: r3ntAbi,
          functionName: "setActive",
          args: [id, makeActive],
        });
        renderMyListings();
      };
    });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await renderApproveListFee();
  await renderCreateListing();
  await renderMyListings();
});
