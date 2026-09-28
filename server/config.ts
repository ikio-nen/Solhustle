const bool = (v: string | undefined) => v === "1" || v === "true" || v === "yes";
const env = process.env;

const nodeEnv = env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

/** Known-insecure value that must never be used in production. */
const INSECURE_JWT_SECRET = "hackathon-dev-secret-change-me";

function resolveJwtSecret(): string {
  const secret = env.JWT_SECRET?.trim();
  if (isProduction) {
    if (!secret || secret === INSECURE_JWT_SECRET || secret.length < 32) {
      throw new Error(
        "JWT_SECRET must be set to a random value of at least 32 characters in production",
      );
    }
    return secret;
  }
  if (!secret) {
    console.warn(
      "[config] JWT_SECRET not set — using the insecure development default. Never do this in production.",
    );
  }
  return secret || INSECURE_JWT_SECRET;
}

/**
 * Secret that gates admin signup. In production it must be configured
 * explicitly, otherwise the admin signup route is disabled entirely.
 */
function resolveAdminSetupSecret(): string | undefined {
  const secret = env.ADMIN_SETUP_SECRET?.trim();
  if (secret) return secret;
  if (isProduction) return undefined;
  return "admin-setup-secret";
}

// `||` (not `??`) so an empty PORT= in the environment still falls back.
const port = Number(env.PORT || 8787);

const appOrigin = (env.APP_ORIGIN || `http://localhost:${port}`).replace(/\/+$/, "");

export const config = {
  nodeEnv,
  isProduction,
  port,
  appOrigin,
  jwtSecret: resolveJwtSecret(),
  adminSetupSecret: resolveAdminSetupSecret(),
  /** Access-token lifetime; short enough that revocation lag stays small. */
  accessTokenTtl: env.ACCESS_TOKEN_TTL || "12h",
  /** Minutes a one-time email/reset token stays valid. */
  authTokenTtlMinutes: Number(env.AUTH_TOKEN_TTL_MINUTES || 60),
  /** Block login for this many minutes after too many failures. */
  lockoutMinutes: Number(env.LOCKOUT_MINUTES || 15),
  lockoutThreshold: Number(env.LOCKOUT_THRESHOLD || 8),
  /** When true, unverified accounts cannot log in. Off by default so the demo
   * accounts keep working; flip it on for a real deployment. */
  requireEmailVerification: bool(env.REQUIRE_EMAIL_VERIFICATION),
  /** Returning the demo signing keypair to the browser is a hackathon
   * affordance. Off in production so private keys never leave the server. */
  exposeDemoSecretKeys: env.EXPOSE_DEMO_SECRET_KEYS === undefined
    ? !isProduction
    : bool(env.EXPOSE_DEMO_SECRET_KEYS),
  /** Seed the known demo accounts (buyer/seller/admin). Off by default in
   * production. */
  seedDemoAccounts: env.SEED_DEMO_ACCOUNTS === undefined
    ? !isProduction
    : bool(env.SEED_DEMO_ACCOUNTS),
  /** Top a buyer wallet up from the platform wallet whenever a deposit is short,
   * so escrow checkout never requires a manual devnet airdrop. Off in production:
   * on a real chain the platform must not silently fund users from its balance. */
  autoFundBuyerWallet: env.AUTO_FUND_BUYER_WALLET === undefined
    ? !isProduction
    : bool(env.AUTO_FUND_BUYER_WALLET),
  /**
   * Auth0 (OIDC) — the hosted sign-in path on the login page. Dormant until an
   * application's client id and secret are configured; the login page then shows
   * the "AUTH0 · READY" badge and a real redirect to Auth0 Universal Login,
   * exactly like the reference deployment. `redirectUri` must be whitelisted in
   * the Auth0 application's Allowed Callback URLs or Auth0 refuses the login.
   */
  auth0: ((): {
    issuerBaseUrl?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri: string;
    callbackPath: string;
    configured: boolean;
  } => {
    const raw = (env.AUTH0_ISSUER_BASE_URL || env.AUTH0_DOMAIN || "").trim().replace(/\/+$/, "");
    const issuerBaseUrl = raw ? (/^https?:\/\//.test(raw) ? raw : `https://${raw}`) : undefined;
    const clientId = env.AUTH0_CLIENT_ID?.trim() || undefined;
    const clientSecret = env.AUTH0_CLIENT_SECRET?.trim() || undefined;
    // The redirect URI is deployment config, not a hardcoded path: Auth0 only
    // answers a callback it has been told about, and tenants differ (Auth0's own
    // Express quickstart whitelists /callback, for instance). The callback route
    // is registered at whatever path this resolves to, so the two cannot drift.
    const configuredCallback = env.AUTH0_CALLBACK_URL?.trim();
    const redirectUri =
      configuredCallback && /^https?:\/\//i.test(configuredCallback)
        ? configuredCallback
        : `${appOrigin}/auth/auth0/callback`;
    let callbackPath = "/auth/auth0/callback";
    try {
      const parsed = new URL(redirectUri).pathname;
      if (parsed && parsed !== "/") callbackPath = parsed;
    } catch {
      /* the guard above means this cannot happen; keep the canonical path */
    }
    return {
      issuerBaseUrl,
      clientId,
      clientSecret,
      redirectUri,
      callbackPath,
      configured: Boolean(issuerBaseUrl && clientId && clientSecret),
    };
  })(),
  /**
   * Redirect URI used after Auth0 federated logout, so the user lands back on the
   * login page with a clean (unsigned-in) session rather than looping into the
   * previous portal.
   */
  auth0LogoutReturnTo: env.AUTH0_LOGOUT_RETURN_TO || `${appOrigin}/login`,
  /** Comma-separated origin allow-list for cross-origin API use. */
  corsOrigins: (env.CORS_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  chain: ((): "devnet" | "mainnet-beta" => {
    const c = (env.CHAIN || "devnet").toLowerCase();
    if (c !== "devnet" && c !== "mainnet-beta") throw new Error("CHAIN must be devnet or mainnet-beta");
    return c as "devnet" | "mainnet-beta";
  })(),
  rpcUrl: env.SOLANA_RPC_URL || undefined,
  platformKeyB58: env.PLATFORM_KEY_B58 || undefined,
  arbiterKeyB58: env.ARBITER_KEY_B58 || undefined,
  geminiApiKey: env.GEMINI_SOL_PRICE_API_KEY || env.GEMINI_API_KEY || undefined,
  geminiApiSecret: env.GEMINI_API_SECRET || undefined,
  airdropUrl: env.AIRDROP_URL || undefined,
  dataDir: env.DATA_DIR || "data",
  keysDir: env.KEYS_DIR || "keys",
  debugLogs: bool(env.DEBUG_LOGS),
};

export const EXPLORER_CLUSTER_PARAM =
  config.chain === "devnet" ? "?cluster=devnet" : "";

export function explorerTx(signature: string): string {
  return `https://solscan.io/tx/${signature}${EXPLORER_CLUSTER_PARAM}`;
}

export function explorerAccount(address: string): string {
  return `https://solscan.io/account/${address}${EXPLORER_CLUSTER_PARAM}`;
}
