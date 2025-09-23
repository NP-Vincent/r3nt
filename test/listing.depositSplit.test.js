const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

async function deployBookingFixture() {
  const [landlord, , tenant] = await ethers.getSigners();

  const BookingRegistry = await ethers.getContractFactory("MockBookingRegistry");
  const registry = await BookingRegistry.deploy();
  await registry.waitForDeployment();

  const USDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await USDC.deploy();
  await usdc.waitForDeployment();

  const SQMU = await ethers.getContractFactory("MockSQMU");
  const sqmu = await SQMU.deploy();
  await sqmu.waitForDeployment();

  const Platform = await ethers.getContractFactory("MockPlatform");
  const platform = await Platform.deploy(await usdc.getAddress(), await registry.getAddress(), await sqmu.getAddress());
  await platform.waitForDeployment();

  await platform.setModules(ethers.ZeroAddress, await registry.getAddress(), await sqmu.getAddress());
  await platform.setViewPass(tenant.address, true);
  await platform.setFees(0, 0);

  const depositAmount = ethers.parseUnits("500", 6);
  const baseDailyRate = ethers.parseUnits("100", 6);
  const Listing = await ethers.getContractFactory("Listing");
  const listing = await upgrades.deployProxy(
    Listing,
    [
      landlord.address,
      await platform.getAddress(),
      await registry.getAddress(),
      await sqmu.getAddress(),
      1234,
      ethers.ZeroHash,
      ethers.ZeroHash,
      0,
      0,
      baseDailyRate,
      depositAmount,
      0,
      0,
      ""
    ],
    { initializer: "initialize" }
  );
  await listing.waitForDeployment();

  const start = (await time.latest()) + 10;
  const end = start + 3 * 24 * 60 * 60;
  const periodDay = 1;

  await usdc.mint(tenant.address, depositAmount);
  await usdc.connect(tenant).approve(await listing.getAddress(), depositAmount);

  await listing.connect(tenant).book(start, end, periodDay);
  const bookingId = await listing.nextBookingId();

  return { listing, landlord, platform, tenant, bookingId };
}

describe("Listing deposit split cleanup", function () {
  it("clears the pending deposit split when a booking is cancelled", async function () {
    const { listing, landlord, bookingId } = await loadFixture(deployBookingFixture);

    await listing.connect(landlord).proposeDepositSplit(bookingId, 2_000);
    const before = await listing.pendingDepositSplit(bookingId);
    expect(before.exists).to.equal(true);

    await listing.connect(landlord).cancelBooking(bookingId);

    const after = await listing.pendingDepositSplit(bookingId);
    expect(after.exists).to.equal(false);
  });

  it("clears the pending deposit split when handleDefault allocates the deposit", async function () {
    const { listing, landlord, platform, bookingId } = await loadFixture(deployBookingFixture);

    await listing.connect(landlord).proposeDepositSplit(bookingId, 1_000);
    const before = await listing.pendingDepositSplit(bookingId);
    expect(before.exists).to.equal(true);

    await platform.triggerDefault(await listing.getAddress(), bookingId);

    const after = await listing.pendingDepositSplit(bookingId);
    expect(after.exists).to.equal(false);
  });
});
