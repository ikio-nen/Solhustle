import type { NextFunction, Request, Response } from "express";
import type { User } from "./db.ts";

export type AuthedRequest = Request & { user?: User };

/** Thrown by handlers; mapped to an HTTP status by errorHandler. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const bad = (msg: string) => new HttpError(400, msg);
export const unauthorized = (msg = "unauthorized") => new HttpError(401, msg);
export const forbidden = (msg = "forbidden") => new HttpError(403, msg);
export const notFound = (msg = "not found") => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
export const tooMany = (msg = "rate limited") => new HttpError(429, msg);

type AsyncHandler = (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>;

/** Wrap an async express handler so rejections reach the error middleware. */
export function h(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as AuthedRequest, res, next).catch(next);
  };
}

export function parseIntOr(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`invalid ${field}`);
  return n;
}

export function requireString(body: Record<string, unknown>, field: string, maxLen = 5000): string {
  const v = body[field];
  if (typeof v !== "string" || v.trim().length === 0) throw bad(`${field} is required`);
  if (v.length > maxLen) throw bad(`${field} too long`);
  return v.trim();
}

export function optionalString(body: Record<string, unknown>, field: string, maxLen = 5000): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw bad(`${field} must be a string`);
  if (v.length > maxLen) throw bad(`${field} too long`);
  const t = v.trim();
  return t === "" ? undefined : t;
}

export function requireNumber(body: Record<string, unknown>, field: string, min: number, max: number): number {
  const n = Number(body[field]);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${field} must be a number between ${min} and ${max}`);
  return n;
}

export function requireArray(body: Record<string, unknown>, field: string): unknown[] {
  const v = body[field];
  if (!Array.isArray(v)) throw bad(`${field} must be an array`);
  return v;
}
