import { zeroAddress, type PublicClient } from "viem";
import { config } from "./config";
import { leaderboardAbi, registryAbi } from "./abis";

/** Coston2 public RPC eth_getLogs max span is 30 blocks inclusive. */
const RPC_LOG_BLOCK_LIMIT = 30n;
const RECENT_LEAD_LOOKBACK = 600n;

const SEED_LEADS: `0x${string}`[] = [
  "0x03182be182be76F11D1d136574190708844aE079",
  "0xB1C314846C29d894db4a3CF6b557B92CFC6f18d5",
];

export type DiscoverLead = {
  address: `0x${string}`;
  score: number;
  attestationId: `0x${string}`;
  strategyType: number;
  verified: boolean;
  feeRateBps: number;
};

function addAddr(set: Set<string>, value: string | undefined) {
  if (!value || value === zeroAddress) return;
  set.add(value.toLowerCase());
}

async function announcedLeads(): Promise<string[]> {
  try {
    const res = await fetch("/api/leads", { cache: "no-store" });
    if (!res.ok) return [];
    const body = (await res.json()) as { addresses?: string[] };
    return body.addresses ?? [];
  } catch {
    return [];
  }
}

async function recentRegisteredLeads(client: PublicClient): Promise<string[]> {
  try {
    const toBlock = await client.getBlockNumber();
    const fromBlock = toBlock > RECENT_LEAD_LOOKBACK ? toBlock - RECENT_LEAD_LOOKBACK : 0n;
    const found: string[] = [];
    let to = toBlock;
    while (to >= fromBlock) {
      const spanStart = to + 1n > RPC_LOG_BLOCK_LIMIT ? to + 1n - RPC_LOG_BLOCK_LIMIT : 0n;
      const from = spanStart < fromBlock ? fromBlock : spanStart;
      const logs = await client.getContractEvents({
        address: config.registry,
        abi: registryAbi,
        eventName: "LeadRegistered",
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        const wallet = (log as { args?: { wallet?: `0x${string}` } }).args?.wallet;
        if (wallet) found.push(wallet);
      }
      if (from === fromBlock) break;
      to = from - 1n;
    }
    return found;
  } catch {
    return [];
  }
}

export async function loadDiscoverLeads(client: PublicClient): Promise<DiscoverLead[]> {
  const candidates = new Set<string>();
  for (const a of SEED_LEADS) addAddr(candidates, a);

  try {
    const ranked = (await client.readContract({
      address: config.leaderboard,
      abi: leaderboardAbi,
      functionName: "getRankedLeads",
    })) as `0x${string}`[];
    for (const a of ranked) addAddr(candidates, a);
  } catch {
    /* leaderboard optional */
  }

  for (const a of await announcedLeads()) addAddr(candidates, a);
  for (const a of await recentRegisteredLeads(client)) addAddr(candidates, a);

  const rows: DiscoverLead[] = [];
  for (const addr of candidates) {
    const address = addr as `0x${string}`;
    try {
      const lead = await client.readContract({
        address: config.registry,
        abi: registryAbi,
        functionName: "getLead",
        args: [address],
      });
      if (!lead.wallet || lead.wallet === zeroAddress) continue;
      let score = 0;
      let attestationId = ("0x" + "0".repeat(64)) as `0x${string}`;
      try {
        const scoreRec = await client.readContract({
          address: config.leaderboard,
          abi: leaderboardAbi,
          functionName: "getScore",
          args: [address],
        });
        score = Number(scoreRec.score);
        attestationId = scoreRec.attestationId;
      } catch {
        /* unranked leads still show */
      }
      rows.push({
        address: lead.wallet,
        score,
        attestationId,
        strategyType: Number(lead.strategyType),
        verified: Boolean(lead.verified),
        feeRateBps: Number(lead.feeRateBps),
      });
    } catch {
      /* skip */
    }
  }

  rows.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  return rows;
}

export async function announceLead(address: string) {
  try {
    await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
  } catch {
    /* directory is best-effort */
  }
}
