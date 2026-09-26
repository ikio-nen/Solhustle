import * as web3 from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

const cache = new Map<string, web3.Keypair>();

function loadOrCreate(name: string, envB58: string | undefined): web3.Keypair {
  if (cache.has(name)) return cache.get(name)!;
  let kp: web3.Keypair;
  if (envB58) {
    kp = web3.Keypair.fromSecretKey(bs58.decode(envB58));
  } else {
    const file = path.join(config.keysDir, `${name}.json`);
    if (fs.existsSync(file)) {
      const arr = JSON.parse(fs.readFileSync(file, "utf8")) as number[];
      kp = web3.Keypair.fromSecretKey(Uint8Array.from(arr));
    } else {
      fs.mkdirSync(config.keysDir, { recursive: true });
      kp = web3.Keypair.generate();
      fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    }
  }
  cache.set(name, kp);
  return kp;
}

/** Platform hot key: pays fees, initializes escrow accounts. */
export const platformKeypair = () => loadOrCreate("platform", config.platformKeyB58);

/** Arbiter key: signs on-chain dispute resolution moves. */
export const arbiterKeypair = () => loadOrCreate("arbiter", config.arbiterKeyB58);
