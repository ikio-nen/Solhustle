import * as web3 from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.ts";
import { config } from "./config.ts";
import { requestAirdrop } from "./solana.ts";
import { platformKeypair } from "./keys.ts";
import { recomputeLeaderboard } from "./leaderboard.ts";

/**
 * Keypair-backed demo actors. Each gets a real keypair (persisted in keys/demo_*.json),
 * a user row, and devnet SOL — so the frontend can sign real transactions for them
 * and every balance change is independently verifiable on Explorer.
 */

export type DemoActor = { name: string; wallet: string; secretKeyB58: string; userId: number; role: string };

const DEMO_ACTORS: { name: string; file: string; role: "client" | "freelancer" | "support" | "dev" }[] = [
  { name: "client", file: "demo_client.json", role: "client" },
  { name: "freelancerA", file: "demo_freelancer_a.json", role: "freelancer" },
  { name: "freelancerB", file: "demo_freelancer_b.json", role: "freelancer" },
  { name: "support", file: "demo_support.json", role: "support" },
  { name: "dev", file: "demo_dev.json", role: "dev" },
];

function loadDemoKeypair(file: string): web3.Keypair {
  fs.mkdirSync(config.keysDir, { recursive: true });
  const p = path.join(config.keysDir, file);
  if (fs.existsSync(p)) {
    const arr = JSON.parse(fs.readFileSync(p, "utf8")) as number[];
    return web3.Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  const kp = web3.Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

function upsertUser(wallet: string, role: DemoActor["role"]): number {
  const existing = db.prepare("SELECT id FROM users WHERE wallet_address = ?").get(wallet) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = db.prepare("INSERT INTO users (wallet_address, role) VALUES (?, ?)").run(wallet, role);
  return Number(info.lastInsertRowid);
}

export async function seedTaxonomy(): Promise<void> {
  const domains: [string, string[]][] = [
    ["Video Editing", ["Motion Graphics", "Velocity Edits", "Portfolio Edits", "Website/Product Edits"]],
    ["Graphic Design", ["Branding", "Social Media Graphics", "UI Assets"]],
    ["Web Development", ["Frontend Builds", "Backend/API", "Full-stack Sites"]],
    ["Writing", ["Copywriting", "Technical Writing", "Scriptwriting"]],
    ["Audio/Music", ["Sound Design", "Mixing/Mastering", "Voiceover Editing"]],
    ["Marketing", ["SEO", "Paid Ads", "Social Strategy"]],
  ];
  for (const [domain, subs] of domains) {
    let domainId: number;
    const existing = db.prepare("SELECT id FROM domains WHERE name = ?").get(domain) as { id: number } | undefined;
    if (existing) {
      domainId = existing.id;
    } else {
      domainId = Number(db.prepare("INSERT INTO domains (name) VALUES (?)").run(domain).lastInsertRowid);
    }
    for (const sub of subs) {
      db.prepare("INSERT OR IGNORE INTO subdomains (domain_id, name) VALUES (?, ?)").run(domainId, sub);
    }
  }
}

export async function ensureDemoActors(fund: boolean): Promise<DemoActor[]> {
  await seedTaxonomy();
  const actors: DemoActor[] = [];
  for (const spec of DEMO_ACTORS) {
    const kp = loadDemoKeypair(spec.file);
    const wallet = kp.publicKey.toBase58();
    const userId = upsertUser(wallet, spec.role);
    actors.push({ name: spec.name, wallet, secretKeyB58: bs58.encode(kp.secretKey), userId, role: spec.role });
  }
  if (fund) {
    const platform = platformKeypair();
    const platformBal = await requestAirdrop(platform.publicKey).catch(() => null);
    if (platformBal) console.log(`  platform wallet funded: ${platform.publicKey.toBase58()}`);
    for (const a of actors) {
      try {
        const pub = new web3.PublicKey(a.wallet);
        const existing = await (await import("./solana.ts")).getSolBalance(pub);
        if (existing < 200_000_000) {
          const res = await requestAirdrop(pub);
          console.log(`  airdropped 1 SOL to ${a.name}: ${res.signature.slice(0, 16)}…`);
        }
      } catch (err) {
        console.warn(`  airdrop failed for ${a.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return actors;
}

export async function main(): Promise<void> {
  console.log("Seeding taxonomy + demo actors…");
  await ensureDemoActors(true);
  recomputeLeaderboard();
  console.log("Seed complete. Demo wallets (base58 secret keys are in keys/demo_*.json):");
  const actors = await ensureDemoActors(false);
  for (const a of actors) console.log(`  ${a.name.padEnd(12)} ${a.wallet} (${a.role})`);
}

const isMain = process.argv[1]?.includes("seed");
if (isMain) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
