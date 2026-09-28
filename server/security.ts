import type { NextFunction, Request, Response } from "express";
import { config } from "./config.ts";
import { tooMany } from "./util.ts";

/** Baseline hardening headers (helmet-style, no dependency). */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // Modern browsers ignore this; send "0" so legacy XSS auditors stay off.
  res.setHeader("X-XSS-Protection", "0");
  if (config.isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  // The app ships inline <script>/styles in its HTML, so those must be allowed.
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self' https: wss:",
      "object-src 'none'",
    ].join("; "),
  );
  next();
}

/**
 * Same-origin by default. An explicit CORS_ORIGIN allow-list can open the API
 * to other frontends; credentials stay off because auth is a Bearer token.
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "false");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Admin-Setup-Secret");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export type RateLimitOptions = {
  windowMs: number;
  max: number;
  message?: string;
  /** Extra key material, e.g. the submitted identifier, so one IP cannot
   * hammer a single account. */
  keyExtra?: (req: Request) => string;
};

/**
 * Fixed-window in-memory limiter. Good enough for a single node; swap for a
 * shared store (Redis) if the app is ever horizontally scaled.
 */
export function rateLimit(opts: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of hits) if (rec.resetAt <= now) hits.delete(key);
  }, Math.max(opts.windowMs, 30_000));
  cleanup.unref?.();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const extra = opts.keyExtra ? opts.keyExtra(req) : "";
    const key = `${req.ip ?? "unknown"}|${extra}`;
    const now = Date.now();
    const rec = hits.get(key);

    if (!rec || rec.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }

    rec.count += 1;
    if (rec.count > opts.max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((rec.resetAt - now) / 1000))));
      next(tooMany(opts.message ?? "too many requests, please slow down"));
      return;
    }
    next();
  };
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}
