import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { config } from "./config.ts";
import { bad } from "./util.ts";

/**
 * File uploads for deliverables and portfolios.
 *
 * There is deliberately no multipart dependency here: the project has no multer
 * or busboy, and the client sends the file as base64 JSON instead. That keeps the
 * dependency list unchanged, and it means the size cap has to be enforced *by
 * hand* — see the encoded-length check in `uploadRoute`, which is what actually
 * bounds memory before any decoding happens.
 */

export const uploadsDir = path.join(config.dataDir, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

/** Per-file cap. The route's JSON body limit must exceed this by ~4/3. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Only raster images and video. SVG is excluded on purpose: an SVG is a document,
 * so serving a user-supplied one from our own origin would be stored XSS against
 * every signed-in session. (SVG referenced by URL is fine — it only ever renders
 * inside an <img>, where scripts don't run.)
 */
const ALLOWED_TYPES: Record<string, { ext: string; kind: "image" | "video" }> = {
  "image/png": { ext: "png", kind: "image" },
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/jpg": { ext: "jpg", kind: "image" },
  "image/gif": { ext: "gif", kind: "image" },
  "image/webp": { ext: "webp", kind: "image" },
  "image/avif": { ext: "avif", kind: "image" },
  "video/mp4": { ext: "mp4", kind: "video" },
  "video/webm": { ext: "webm", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" },
};

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/** True for a path this server issued. The only relative URL we ever trust. */
export function isUploadPath(url: string): boolean {
  return /^\/uploads\/[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/i.test(url);
}

export const uploadMeta = {
  maxBytes: MAX_UPLOAD_BYTES,
  maxMb: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024),
  accepts: Object.keys(ALLOWED_TYPES),
  acceptsSvg: false,
};

/**
 * POST /uploads — body `{ mime, data_base64, filename? }` → `{ url, type, bytes }`.
 *
 * The stored name is generated, never taken from the client, so a hostile
 * filename cannot influence the path on disk.
 */
export function uploadRoute(req: Request, res: Response): void {
  const user = (req as Request & { user?: { id: number } }).user!;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const [mimeType = ""] = String(body.mime ?? "").toLowerCase().split(";");
  const mime = mimeType.trim();
  const spec = ALLOWED_TYPES[mime];
  if (!spec) {
    throw bad(
      `unsupported file type${mime ? ` (${mime})` : ""} — images (png, jpg, gif, webp, avif) and video (mp4, webm, mov) only`,
    );
  }

  const dataB64 = String(body.data_base64 ?? "");
  if (!dataB64) throw bad("data_base64 is required");

  // Check the *encoded* length first: base64 inflates by ~4/3, so this rejects an
  // oversized file before allocating the decoded buffer.
  const approxBytes = Math.floor((dataB64.length * 3) / 4);
  if (approxBytes > MAX_UPLOAD_BYTES) {
    throw bad(`file is too large — the limit is ${uploadMeta.maxMb} MB`);
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(dataB64, "base64");
  } catch {
    throw bad("data_base64 is not valid base64");
  }
  if (!buf.length) throw bad("the file was empty");
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw bad(`file is too large — the limit is ${uploadMeta.maxMb} MB`);
  }

  const name = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${spec.ext}`;
  fs.writeFileSync(path.join(uploadsDir, name), buf);

  res.status(201).json({
    url: `/uploads/${name}`,
    type: spec.kind,
    bytes: buf.length,
    mime,
    uploaded_by: user.id,
  });
}

/**
 * Headers for serving stored files. `sandbox` + `default-src 'none'` means even a
 * mis-typed or future asset type cannot execute script in our origin, and nosniff
 * stops a browser from reinterpreting a file as HTML.
 */
export function uploadHeaders(res: Response, filePath: string): void {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = EXT_MIME[ext];
  if (mime) res.setHeader("Content-Type", mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
}
