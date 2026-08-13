/**
 * Wire InstructionSender to MockSparkDexRouter and seed inventory.
 *
 * SparkDEX V3 SwapRouter still has no bytecode on Coston2 (verified eth_getCode).
 * This is the Phase 4A venue: same exactInputSingle ABI, FTSO-priced fills, real ERC20 moves.
 *
 *   npm run tee:wire-execution -w scripts
 */
import * as dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getAddress, parseAbi, type Address } from "viem";
import { clientsFromEnv, loadConfig } from "./fdc.ts";

const SENDER_ABI = parseAbi([
  "function swapRouter() view returns (address)",
  "function setSwapRouter(address router)",
]);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: join(ROOT, ".env") });

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
]);

async function main() {
  const cfg = loadConfig();
  const { publicClient, wallet, account } = clientsFromEnv();
  const sender = getAddress(cfg.contracts.instructionSender) as Address;
  const router = getAddress(cfg.contracts.mockSparkDexRouter) as Address;
  const fxrp = getAddress(cfg.tokens.fxrp) as Address;
  const usdt0 = getAddress(cfg.tokens.usdt0) as Address;
  const sparkdex = "0x8a1E35F5c98C4E85B36B7B253222eE17773b2781" as Address;
  const sparkCode = await publicClient.getCode({ address: sparkdex });
  console.log(`SparkDEX SwapRouter ${sparkdex} bytecode: ${sparkCode && sparkCode !== "0x" ? sparkCode.length : "NONE (expected)"}`);

  const current = (await publicClient.readContract({
    address: sender,
    abi: SENDER_ABI,
    functionName: "swapRouter",
  })) as Address;
  console.log(`InstructionSender.swapRouter = ${current}`);

  if (current.toLowerCase() !== router.toLowerCase()) {
    const hash = await wallet.writeContract({
      address: sender,
      abi: SENDER_ABI,
      functionName: "setSwapRouter",
      args: [router],
      gas: 200_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`setSwapRouter → ${router}  tx=${hash}`);
  } else {
    console.log("swapRouter already set");
  }

  const fxrpDec = (await publicClient.readContract({ address: fxrp, abi: ERC20_ABI, functionName: "decimals" })) as number;
  const usdtDec = (await publicClient.readContract({ address: usdt0, abi: ERC20_ABI, functionName: "decimals" })) as number;
  const wantFxrp = 10n ** BigInt(fxrpDec); // 1 FXRP
  const wantUsdt = 10n ** BigInt(usdtDec); // 1 USDT0

  const routerFxrp = (await publicClient.readContract({
    address: fxrp,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [router],
  })) as bigint;
  const routerUsdt = (await publicClient.readContract({
    address: usdt0,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [router],
  })) as bigint;
  console.log(`mock router inventory: ${routerFxrp} FXRP, ${routerUsdt} USDT0`);

  const depFxrp = (await publicClient.readContract({
    address: fxrp,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  const depUsdt = (await publicClient.readContract({
    address: usdt0,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  if (routerFxrp < wantFxrp && depFxrp > wantFxrp) {
    const hash = await wallet.writeContract({
      address: fxrp,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [router, wantFxrp],
      gas: 120_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`seeded mock +1 FXRP  tx=${hash}`);
  }
  if (routerUsdt < wantUsdt && depUsdt > wantUsdt) {
    const hash = await wallet.writeContract({
      address: usdt0,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [router, wantUsdt],
      gas: 120_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`seeded mock +1 USDT0  tx=${hash}`);
  }

  const senderUsdt = (await publicClient.readContract({
    address: usdt0,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [sender],
  })) as bigint;
  if (senderUsdt < wantUsdt && depUsdt > wantUsdt * 2n) {
    const hash = await wallet.writeContract({
      address: usdt0,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [sender, wantUsdt],
      gas: 120_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`seeded InstructionSender +1 USDT0 for BUY path  tx=${hash}`);
  }

  console.log("OK: execution venue wired (MockSparkDexRouter / SparkDEX V3 ABI)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
