import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing.
 *
 * Passwords are stored as `scrypt$N$r$p$salt$hash` (base64url). We never store
 * or log a plaintext password. Accounts created before hashing existed hold a
 * bare plaintext string; those are detected by the missing `scrypt$` prefix and
 * transparently upgraded to a hash the first time the user logs in.
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
const PREFIX = "scrypt";

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export function hashCode(value: string): string {
  const salt = randomBytes(SALT_LEN);
  const derived = scryptSync(value, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export function isHashed(stored: string): boolean {
  return typeof stored === "string" && stored.startsWith(`${PREFIX}$`);
}

/** Constant-time string compare that tolerates unequal lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still burn a comparison so length is not the only timing signal.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export type VerifyResult = {
  ok: boolean;
  /** True when the stored value should be rewritten (legacy plaintext or an
   * outdated work factor). */
  needsRehash: boolean;
};

export function verifyPassword(password: string, stored: string): VerifyResult {
  if (typeof stored !== "string" || stored.length === 0) {
    return { ok: false, needsRehash: false };
  }

  // Legacy plaintext row: compare directly, then upgrade on success.
  if (!isHashed(stored)) {
    const ok = safeEqual(stored, password);
    return { ok, needsRehash: ok };
  }

  const parts = stored.split("$");
  if (parts.length !== 6) return { ok: false, needsRehash: false };

  const nRaw = parts[1] ?? "";
  const rRaw = parts[2] ?? "";
  const pRaw = parts[3] ?? "";
  const saltRaw = parts[4] ?? "";
  const hashRaw = parts[5] ?? "";
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return { ok: false, needsRehash: false };
  }

  const salt = Buffer.from(saltRaw, "base64url");
  const expected = Buffer.from(hashRaw, "base64url");

  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.length || KEY_LEN, { N, r, p });
  } catch {
    return { ok: false, needsRehash: false };
  }

  const ok = derived.length === expected.length && timingSafeEqual(derived, expected);
  const needsRehash = ok && (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P);
  return { ok, needsRehash };
}

/** Basic server-side strength gate (length + character variety). */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "password is required";
  if (password.length < MIN_PASSWORD_LENGTH)
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH)
    return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) return "password must mix at least two of: lowercase, uppercase, digits, symbols";
  return null;
}
