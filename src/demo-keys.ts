import * as web3 from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { bad } from "./util.ts";

const DEMO_FILES = [
  "demo_client.json",
  "demo_freelancer_a.json",
  "demo_freelancer_b.json",
  "demo_support.json",
  "demo_dev.json",
];

/** Load the keypair for a demo wallet (only wallets stored in keys/demo_*.json). */
export function loadDemoKeypairByWallet(wallet: string): web3.Keypair {
  for (const f of DEMO_FILES) {
    const p = path.join(config.keysDir, f);
    if (!fs.existsSync(p)) continue;
    const arr = JSON.parse(fs.readFileSync(p, "utf8")) as number[];
    const kp = web3.Keypair.fromSecretKey(Uint8Array.from(arr));
    if (kp.publicKey.toBase58() === wallet) return kp;
  }
  throw bad("not a demo wallet");
}
