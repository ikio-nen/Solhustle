import * as web3 from "@solana/web3.js";

const bool = (v: string | undefined) => v === "1" || v === "true" || v === "yes";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  jwtSecret: process.env.JWT_SECRET || "hackathon-dev-secret-change-me",
  chain: ((): "devnet" | "mainnet-beta" => {
    const c = (process.env.CHAIN || "devnet").toLowerCase();
    if (c !== "devnet" && c !== "mainnet-beta") throw new Error("CHAIN must be devnet or mainnet-beta");
    return c as "devnet" | "mainnet-beta";
  })(),
  rpcUrl: process.env.SOLANA_RPC_URL || undefined,
  platformKeyB58: process.env.PLATFORM_KEY_B58 || undefined,
  arbiterKeyB58: process.env.ARBITER_KEY_B58 || undefined,
  geminiApiKey: process.env.GEMINI_SOL_PRICE_API_KEY || process.env.GEMINI_API_KEY || undefined,
  geminiApiSecret: process.env.GEMINI_API_SECRET || undefined,
  airdropUrl: process.env.AIRDROP_URL || undefined,
  dataDir: process.env.DATA_DIR || "data",
  keysDir: process.env.KEYS_DIR || "keys",
  debugLogs: bool(process.env.DEBUG_LOGS),
} as const;

export const EXPLORER_CLUSTER_PARAM =
  config.chain === "devnet" ? "?cluster=devnet" : "";

export function explorerTx(signature: string): string {
  return `https://solscan.io/tx/${signature}${EXPLORER_CLUSTER_PARAM}`;
}

export function explorerAccount(address: string): string {
  return `https://solscan.io/account/${address}${EXPLORER_CLUSTER_PARAM}`;
}
