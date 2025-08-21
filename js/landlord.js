// /js/landlord.js
import r3ntAbi from "./abi/r3nt.json" assert { type: "json" };
import usdcAbi from "./abi/USDC.json" assert { type: "json" };
import { R3NT_ADDRESS, USDC_ADDRESS } from "./config.js";
import { ensureWritable, simulateAndWrite, toUnits, readVar, ready, sdk, publicClient, getWalletClient } from "./shared.js";

ready();

let provider = null;
let account = null;

window.addEventListener("DOMContentLoaded", () => {
  setupWallet();
  document.getElementById("connect-btn")?.addEventListener("click", connectWallet);
  document.getElementById("create-form")?.addEventListener("submit", createListing);
  document.getElementById("completed-form")?.addEventListener("submit", markCompleted);
  document.getElementById("split-form")?.addEventListener("submit", proposeSplit);
});

async function setupWallet() {
  try {
    provider = await sdk.wallet.getEthereumProvider();
    const btn = document.getElementById("connect-btn");
    if (!btn) return;
    if (!provider) {
      btn.style.display = "block";
      return;
    }
    const accounts = await provider.request({ method: "eth_accounts" });
    if (accounts.length > 0) {
      account = accounts[0];
      btn.textContent = shortAddr(account);
    }
  } catch {}
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
}

function shortAddr(a) {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

async function createListing(e) {
  e.preventDefault();
  const statusEl = document.getElementById("create-status");
  try {
    await ensureWritable();
    const { account } = await getWalletClient();
    const deposit = toUnits(document.getElementById("deposit").value);
    const rateDaily = toUnits(document.getElementById("rateDaily").value);
    const rateWeekly = toUnits(document.getElementById("rateWeekly").value);
    const rateMonthly = toUnits(document.getElementById("rateMonthly").value);
    const geohash = document.getElementById("geohash").value;
    const geolen = geohash.length;
    const fid = BigInt(document.getElementById("fid").value);
    const castHash = document.getElementById("castHash").value;
    const title = document.getElementById("title").value;
    const shortDesc = document.getElementById("shortDesc").value;
    const signersStr = document.getElementById("signers").value.trim();
    const signers = signersStr ? signersStr.split(",").map(s => s.trim()) : [];
    const threshold = BigInt(document.getElementById("threshold").value || 1);

    const listFee = await readVar(R3NT_ADDRESS, r3ntAbi, "listFee");
    const allowance = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: usdcAbi,
      functionName: "allowance",
      args: [account, R3NT_ADDRESS],
    });
    if (allowance < listFee) {
      const gasA = await publicClient.estimateContractGas({
        account,
        address: USDC_ADDRESS,
        abi: usdcAbi,
        functionName: "approve",
        args: [R3NT_ADDRESS, listFee],
      });
      const gasPriceA = await publicClient.getGasPrice();
      const balance = await publicClient.getBalance({ address: account });
      if (gasA * gasPriceA > balance) {
        if (statusEl) statusEl.textContent = "Insufficient funds for gas";
        return;
      }
      await simulateAndWrite({
        address: USDC_ADDRESS,
        abi: usdcAbi,
        functionName: "approve",
        args: [R3NT_ADDRESS, listFee],
      });
    }

    const gas = await publicClient.estimateContractGas({
      account,
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "createListing",
      args: [
        USDC_ADDRESS,
        deposit,
        rateDaily,
        rateWeekly,
        rateMonthly,
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
    const gasPrice = await publicClient.getGasPrice();
    const balance = await publicClient.getBalance({ address: account });
    if (gas * gasPrice > balance) {
      if (statusEl) statusEl.textContent = "Insufficient funds for gas";
      return;
    }
    if (statusEl) statusEl.textContent = "Submitting...";
    await simulateAndWrite({
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "createListing",
      args: [
        USDC_ADDRESS,
        deposit,
        rateDaily,
        rateWeekly,
        rateMonthly,
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
    if (statusEl) statusEl.textContent = "Transaction sent";
  } catch (err) {
    if (statusEl) statusEl.textContent = err.shortMessage || err.message;
    console.error(err);
  }
}

async function markCompleted(e) {
  e.preventDefault();
  try {
    await ensureWritable();
    const bookingId = BigInt(document.getElementById("bookingId").value);
    await simulateAndWrite({
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "markCompleted",
      args: [bookingId]
    });
  } catch (err) {
    console.error(err);
  }
}

async function proposeSplit(e) {
  e.preventDefault();
  try {
    await ensureWritable();
    const bookingId = BigInt(document.getElementById("splitBookingId").value);
    const toTenant = toUnits(document.getElementById("toTenant").value);
    const toLandlord = toUnits(document.getElementById("toLandlord").value);
    await simulateAndWrite({
      address: R3NT_ADDRESS,
      abi: r3ntAbi,
      functionName: "proposeDepositSplit",
      args: [bookingId, toTenant, toLandlord]
    });
  } catch (err) {
    console.error(err);
  }
}
