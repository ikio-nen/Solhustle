import { createHash, randomBytes } from "node:crypto";

/**
 * One-time tokens for email verification and password reset.
 *
 * The raw token is only ever sent to the user (email / response body); the
 * database stores a SHA-256 hash so a database leak cannot be replayed.
 */

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenFingerprint(token: string): string {
  return hashToken(token).slice(0, 12);
}
