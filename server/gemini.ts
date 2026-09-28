import { db } from "./db.ts";
import { HttpError } from "./util.ts";

const GEMINI_TICKER_URL = "https://api.gemini.com/v1/pubticker/solusd";
const CACHE_TTL_MS = 60_000;
const HTTP_TIMEOUT_MS = 8_000;

export type PriceQuote = { usd: number; sol: number; rate: number; source: string; fetchedAt: string };

function readCache(): { rate: number; fetched_at: string } | undefined {
  const row = db.prepare("SELECT rate, fetched_at FROM price_cache WHERE pair = 'solusd'").get() as
    | { rate: number; fetched_at: string }
    | undefined;
  return row;
}

function writeCache(rate: number): void {
  db.prepare(
    `INSERT INTO price_cache (pair, rate, fetched_at) VALUES ('solusd', ?, datetime('now'))
     ON CONFLICT(pair) DO UPDATE SET rate = excluded.rate, fetched_at = datetime('now')`
  ).run(rate);
}

/** Fetch live SOL/USD from Gemini's public ticker; fall back to last cached rate. */
export async function getSolUsdRate(): Promise<{ rate: number; fetched_at: string; live: boolean }> {
  const cached = readCache();
  if (cached && Date.now() - Date.parse(cached.fetched_at + "Z") < CACHE_TTL_MS) {
    return { rate: cached.rate, fetched_at: cached.fetched_at, live: false };
  }
  try {
    const res = await fetch(GEMINI_TICKER_URL, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { "User-Agent": "solana-escrow-marketplace/1.0" },
    });
    if (!res.ok) throw new Error(`Gemini ticker HTTP ${res.status}`);
    const body = (await res.json()) as { last?: string };
    if (!body.last) throw new Error("ticker missing 'last'");
    const rate = Number(body.last);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("ticker rate not finite");
    writeCache(rate);
    return { rate, fetched_at: new Date().toISOString().replace("T", " ").slice(0, 19), live: true };
  } catch (err) {
    if (cached) {
      // Network hiccup but we have a previous REAL rate — degrade gracefully, never fake.
      return { rate: cached.rate, fetched_at: cached.fetched_at, live: false };
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(502, `Gemini price unavailable and no cached rate yet: ${msg}`);
  }
}

/** Quote a USD job budget in SOL. Cache persists so job quotes are reproducible. */
export async function quoteUsdToSol(usd: number): Promise<PriceQuote> {
  const { rate, fetched_at, live } = await getSolUsdRate();
  return { usd, sol: usd / rate, rate, source: live ? "gemini_live" : "gemini_cached", fetchedAt: fetched_at };
}

/** Quote SOL payout in USD (freelancer cash-out view). */
export async function quoteSolToUsd(sol: number): Promise<PriceQuote> {
  const { rate, fetched_at, live } = await getSolUsdRate();
  return { usd: sol * rate, sol, rate, source: live ? "gemini_live" : "gemini_cached", fetchedAt: fetched_at };
}
