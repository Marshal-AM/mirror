import { ethers } from "hardhat";

const FLARE_TEE_MANAGER =
  process.env.FLARE_TEE_MANAGER ?? "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
const MATCHING_SENDER = "0xf082D53B50D08f0fdC06B0B4C6A1932DB589d91f";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  if (network.chainId !== 114n) {
    throw new Error(`Expected chain ID 114 (Coston2), got ${network.chainId}`);
  }

  const code = await ethers.provider.getCode(FLARE_TEE_MANAGER);
  if (!code || code === "0x") {
    throw new Error(`FlareTeeManager ${FLARE_TEE_MANAGER} has no code`);
  }

  console.log(`Deploying AiAgentSender from ${deployer.address}`);
  console.log(`FlareTeeManager (both registries): ${FLARE_TEE_MANAGER}`);

  const Factory = await ethers.getContractFactory("AiAgentSender");
  const sender = await Factory.deploy(FLARE_TEE_MANAGER, FLARE_TEE_MANAGER);
  await sender.waitForDeployment();
  const address = await sender.getAddress();

  if (address.toLowerCase() === MATCHING_SENDER.toLowerCase()) {
    throw new Error("Refusing to treat matching-engine InstructionSender as AiAgentSender");
  }

  console.log("");
  console.log("========================================");
  console.log(" AiAgentSender deployed");
  console.log("========================================");
  console.log(`  AI_AGENT_SENDER  ${address}`);
  console.log("  Do NOT call setExtensionId on 0xf082… (matching).");
  console.log("  Next: cd fce-ai-agent && ./scripts/pre-register.sh", address);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
