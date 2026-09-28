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

/**
 * Signing key for an account created by an external identity provider (Auth0).
 * The keypair is persisted under keys/user_<id>.json so a *returning* login can
 * still sign escrow deposits — generating it only at signup would leave the
 * account unable to sign after its first session ended.
 */
export function userKeypair(userId: number, wallet?: string): web3.Keypair {
  const kp = loadOrCreate(`user_${userId}`, undefined);
  if (wallet && kp.publicKey.toBase58() !== wallet) {
    throw new Error(`stored key for user ${userId} does not match wallet ${wallet}`);
  }
  return kp;
}

/** Persist a freshly generated account keypair and reuse it for later logins. */
export function saveUserKeypair(userId: number, kp: web3.Keypair): void {
  const name = `user_${userId}`;
  fs.mkdirSync(config.keysDir, { recursive: true });
  fs.writeFileSync(
    path.join(config.keysDir, `${name}.json`),
    JSON.stringify(Array.from(kp.secretKey)),
  );
  cache.set(name, kp);
}
