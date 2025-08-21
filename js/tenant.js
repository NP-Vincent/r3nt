// /js/tenant.js
import r3ntAbi from "./abi/r3nt.json" assert { type: "json" };
import usdcAbi from "./abi/USDC.json" assert { type: "json" };
import { R3NT_ADDRESS, USDC_ADDRESS, FEE_BPS } from "./config.js";
import { ensureWritable, simulateAndWrite, readVar, readStruct, ready, sdk, publicClient } from "./shared.js";

ready();

let provider = null;
let account = null;

window.addEventListener("DOMContentLoaded", () => {
  setupWallet();
  document.getElementById("connect-btn")?.addEventListener("click", connectWallet);
  document.getElementById("approve-btn")?.addEventListener("click", approveUSDC);
  document.getElementById("pass-form")?.addEventListener("submit", buyPass);
  document.getElementById("book-form")?.addEventListener("submit", book);
});

async function setupWallet() {
  try {
    provider = await sdk.wallet.getEthereumProvider();
    const btn = document.getElementById("connect-btn");
    if (!btn) return;
    if (!provider) {
      btn.style.display = "block";
    } else {
      const accounts = await provider.request({ method: "eth_accounts" });
      if (accounts.length > 0) {
        account = accounts[0];
        btn.textContent = shortAddr(account);
      }
    }
  } catch {}
  await checkPass();
}

async function connectWallet() {
  if (!provider) {
    provider = await sdk.wallet.getEthereumProvider();
    if (!provider) return;
  }
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (accounts.length > 0) {
    account = accounts[0];
    const btn = document.getElementById("connect-btn");
    if (btn) btn.textContent = shortAddr(account);
  }
  await checkPass();
}

function shortAddr(a) {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

async function checkPass() {
  const statusEl = document.getElementById("pass-status");
  const approveBtn = document.getElementById("approve-btn");
  const buyBtn = document.getElementById("buy-pass-btn");
  if (!account) {
    if (statusEl) statusEl.textContent = "Connect wallet";
    if (approveBtn) approveBtn.disabled = true;
    if (buyBtn) buyBtn.disabled = true;
    return;
  }
  try {
    const fee = await readVar(R3NT_ADDRESS, r3ntAbi, "viewFee");
    const allowance = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: usdcAbi,
      functionName: "allowance",
      args: [account, R3NT_ADDRESS],
    });
    const expiry = await publicClient.readContract({
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "viewPassExpiry",
      args: [account],
    });
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (expiry >= now) {
      if (statusEl) statusEl.textContent = `Pass valid until ${new Date(Number(expiry) * 1000).toLocaleString()}`;
      if (approveBtn) approveBtn.disabled = true;
      if (buyBtn) buyBtn.disabled = true;
    } else if (allowance < fee) {
      if (statusEl) statusEl.textContent = "Allowance too low. Approve USDC.";
      if (approveBtn) approveBtn.disabled = false;
      if (buyBtn) buyBtn.disabled = true;
    } else {
      if (statusEl) statusEl.textContent = "";
      if (approveBtn) approveBtn.disabled = true;
      if (buyBtn) buyBtn.disabled = false;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = err.shortMessage || err.message;
    if (approveBtn) approveBtn.disabled = true;
    if (buyBtn) buyBtn.disabled = true;
  }
}

async function approveUSDC() {
  try {
    await ensureWritable();
    const fee = await readVar(R3NT_ADDRESS, r3ntAbi, "viewFee");
    await simulateAndWrite({
      address: USDC_ADDRESS,
      abi: usdcAbi,
      functionName: "approve",
      args: [R3NT_ADDRESS, fee],
    });
    await checkPass();
  } catch (err) {
    console.error(err);
  }
}

async function buyPass(e) {
  e.preventDefault();
  try {
    await ensureWritable();
    const fee = await readVar(R3NT_ADDRESS, r3ntAbi, "viewFee");
    const allowance = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: usdcAbi,
      functionName: "allowance",
      args: [account, R3NT_ADDRESS],
    });
    if (allowance < fee) {
      const statusEl = document.getElementById("pass-status");
      if (statusEl) statusEl.textContent = "Allowance too low. Approve first.";
      return;
    }
    const expiry = await publicClient.readContract({
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "viewPassExpiry",
      args: [account],
    });
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (expiry >= now) {
      const statusEl = document.getElementById("pass-status");
      if (statusEl) statusEl.textContent = "Pass already valid.";
      return;
    }
    await simulateAndWrite({
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "buyViewPass",
      args: [],
    });
    await checkPass();
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
