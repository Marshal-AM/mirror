import { expect } from "chai";
import { ethers } from "hardhat";

describe("AiAgentSender", function () {
  async function deployMock() {
    const Mock = await ethers.getContractFactory("MockTeeRegistries");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();
    return mock;
  }

  it("reverts constructor on zero-address registries", async function () {
    const mock = await deployMock();
    const Factory = await ethers.getContractFactory("AiAgentSender");
    await expect(
      Factory.deploy(ethers.ZeroAddress, await mock.getAddress())
    ).to.be.revertedWith("TeeExtensionRegistry cannot be zero address");
    await expect(
      Factory.deploy(await mock.getAddress(), ethers.ZeroAddress)
    ).to.be.revertedWith("TeeMachineRegistry cannot be zero address");
  });

  it("reverts constructor when a registry has no code", async function () {
    const [eoa] = await ethers.getSigners();
    const mock = await deployMock();
    const Factory = await ethers.getContractFactory("AiAgentSender");
    await expect(Factory.deploy(eoa.address, await mock.getAddress())).to.be.revertedWith(
      "TeeExtensionRegistry has no code"
    );
  });

  it("reverts sendScoreV1 before setExtensionId", async function () {
    const mock = await deployMock();
    const Factory = await ethers.getContractFactory("AiAgentSender");
    const sender = await Factory.deploy(await mock.getAddress(), await mock.getAddress());
    await sender.waitForDeployment();

    await expect(sender.sendScoreV1("0x1234")).to.be.revertedWith("Extension ID is not set.");
    await expect(sender.sendSayHello("0x1234")).to.be.revertedWith("Extension ID is not set.");
  });

  it("setExtensionId latches the registered id then SCORE_V1 succeeds", async function () {
    const mock = await deployMock();
    const Factory = await ethers.getContractFactory("AiAgentSender");
    const sender = await Factory.deploy(await mock.getAddress(), await mock.getAddress());
    await sender.waitForDeployment();

    const extId = 0x1029cn;
    await mock.register(extId, await sender.getAddress());
    await sender.setExtensionId();
    expect(await sender.extensionId()).to.equal(extId);

    await expect(sender.setExtensionId()).to.be.revertedWith("Extension ID already set.");

    const tx = await sender.sendScoreV1("0x1234", { value: 1_000_000n });
    const receipt = await tx.wait();
    expect(receipt?.status).to.equal(1);
    expect(await mock.lastInstructionId()).to.not.equal(ethers.ZeroHash);
  });
});
