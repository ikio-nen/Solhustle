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

export type DemoActor = {
  name: string;
  /** Human label shown in the UI ("Freelancer B"), because the demo personas have no credentials row. */
  label: string;
  wallet: string;
  secretKeyB58: string;
  userId: number;
  role: string;
};

const DEMO_ACTORS: {
  name: string;
  label: string;
  file: string;
  role: "client" | "freelancer" | "support" | "dev";
}[] = [
  { name: "client", label: "Client", file: "demo_client.json", role: "client" },
  { name: "freelancerA", label: "Freelancer A", file: "demo_freelancer_a.json", role: "freelancer" },
  { name: "freelancerB", label: "Freelancer B", file: "demo_freelancer_b.json", role: "freelancer" },
  { name: "support", label: "Support", file: "demo_support.json", role: "support" },
  { name: "dev", label: "Operator", file: "demo_dev.json", role: "dev" },
];

/**
 * wallet → label, filled by `ensureDemoActors`.
 *
 * The demo personas sign in by wallet only, so they own no `user_credentials`
 * row and therefore no username — anywhere the app names a person (the message
 * inbox, the "new message" picker) they would otherwise render as a bare
 * truncated address. `demoActorLabel` is that missing name.
 */
const demoLabels = new Map<string, string>();

export function demoActorLabel(wallet: string): string | undefined {
  return demoLabels.get(wallet);
}

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
    demoLabels.set(wallet, spec.label);
    actors.push({
      name: spec.name,
      label: spec.label,
      wallet,
      secretKeyB58: bs58.encode(kp.secretKey),
      userId,
      role: spec.role,
    });
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

/**
 * Give the demo freelancers a real presence: a filled-in profile, skills, and a
 * portfolio with artwork. Without this the marketplace rendered one bare card and
 * a profile with an empty grid, which reads as a broken site rather than a demo.
 *
 * Idempotent by design: profiles are upserted, skills use INSERT OR IGNORE, and
 * portfolio items are only added when that exact URL is missing.
 */
const DEMO_PORTFOLIOS: {
  actor: string;
  headline: string;
  bio: string;
  degrees: string;
  languages: string;
  years: number;
  hourlyRateSol: number;
  skills: string[];
  items: { title: string; url: string; type: string }[];
}[] = [
  {
    actor: "freelancerA",
    headline: "Solana core developer & Anchor specialist",
    bio: "Full-stack Web3 engineer specialising in Solana Anchor programs, high-throughput escrow architectures and Rust smart contracts. 100+ devnet programs deployed, and I ship the tests with them.",
    degrees: "B.S. Computer Science (Stanford), Certified Solana Foundation Anchor Engineer",
    languages: "Rust, TypeScript, Go, Python, English",
    years: 5,
    hourlyRateSol: 0.75,
    skills: ["Backend/API", "Full-stack Sites", "Frontend Builds"],
    items: [
      { title: "Escrow vault — on-chain settlement flow", url: "/assets/cover-escrow.svg", type: "image" },
      { title: "Anchor escrow program + test suite", url: "https://github.com/solana-developers/program-vault-pr-42", type: "repo" },
      { title: "Program internals — instruction handlers", url: "/assets/cover-anchor.svg", type: "image" },
    ],
  },
  {
    actor: "freelancerB",
    headline: "Product designer — Web3 interfaces & design systems",
    bio: "I design and build the front end of crypto products: landing pages that convert, dashboards people actually understand, and design systems that survive contact with engineering.",
    degrees: "B.A. Interaction Design (RISD), Figma Advanced Prototyping",
    languages: "English, Spanish",
    years: 4,
    hourlyRateSol: 0.45,
    skills: ["UI Assets", "Branding", "Frontend Builds"],
    items: [
      { title: "Solhustle landing page — hero and systems", url: "/assets/cover-landing.svg", type: "image" },
      { title: "Block explorer UI — balance and history", url: "/assets/cover-explorer.svg", type: "image" },
      { title: "Design system handoff", url: "https://www.figma.com/file/example/solhustle-design-system", type: "design" },
    ],
  },
];

export async function seedDemoPortfolios(): Promise<void> {
  await seedTaxonomy();
  const actors = await ensureDemoActors(false);
  const byName = new Map(actors.map((a) => [a.name, a]));

  for (const spec of DEMO_PORTFOLIOS) {
    const actor = byName.get(spec.actor);
    if (!actor) continue;
    const userId = actor.userId;

    db.prepare(
      `INSERT INTO freelancer_profiles
         (user_id, headline, bio, degrees, languages, age, years_experience, hourly_rate_sol, points, portfolio_ready)
       VALUES (?, ?, ?, ?, ?, 28, ?, ?, 450, 1)
       ON CONFLICT(user_id) DO UPDATE SET
         headline = excluded.headline,
         bio = excluded.bio,
         degrees = excluded.degrees,
         languages = excluded.languages,
         years_experience = excluded.years_experience,
         hourly_rate_sol = excluded.hourly_rate_sol,
         portfolio_ready = 1`,
    ).run(userId, spec.headline, spec.bio, spec.degrees, spec.languages, spec.years, spec.hourlyRateSol);

    for (const skill of spec.skills) {
      const sub = db.prepare("SELECT id FROM subdomains WHERE name = ?").get(skill) as
        | { id: number }
        | undefined;
      if (!sub) continue;
      db.prepare(
        "INSERT OR IGNORE INTO freelancer_domains (freelancer_id, subdomain_id) VALUES (?, ?)",
      ).run(userId, sub.id);
    }

    for (const item of spec.items) {
      const exists = db
        .prepare("SELECT id FROM portfolio_items WHERE freelancer_id = ? AND media_url = ?")
        .get(userId, item.url);
      if (exists) continue;
      db.prepare(
        "INSERT INTO portfolio_items (freelancer_id, domain_id, title, media_url, media_type) VALUES (?, NULL, ?, ?, ?)",
      ).run(userId, item.title, item.url, item.type);
    }
  }
}

export async function main(): Promise<void> {
  console.log("Seeding taxonomy + demo actors…");
  await ensureDemoActors(true);
  await seedDemoPortfolios();
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
