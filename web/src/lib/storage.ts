import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./api";

/**
 * Pluggable storage — same provider pattern as Project 8.
 * `local` is the dev default (disk + HMAC-signed streaming route).
 * `s3` / `cloudinary` expect their SDK + credentials and throw a clear
 * error until configured; see .env.example.
 */
export type StorageProviderName = "s3" | "cloudinary" | "local";

export interface StorageProvider {
  /** Persist bytes under `key` (never client-controlled path segments). */
  upload(buffer: Buffer, key: string, mime: string): Promise<void>;
  /** Time-limited URL the client can use to fetch the object. */
  getDownloadUrl(key: string, ttlSec?: number): Promise<string>;
  /** Local provider only — read bytes for the signed streaming route. */
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const LOCAL_ROOT = path.join(process.cwd(), ".data", "uploads");

function storageSecret(): string {
  const secret = process.env.STORAGE_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("STORAGE_SECRET or NEXTAUTH_SECRET required for signed media URLs");
  }
  return secret;
}

function signKey(key: string, exp: number): string {
  return createHmac("sha256", storageSecret()).update(`${key}:${exp}`).digest("hex");
}

function verifySignature(key: string, exp: string, sig: string): boolean {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now() / 1000) return false;
  const expected = Buffer.from(signKey(key, expNum), "hex");
  const provided = Buffer.from(sig, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** Guard against path traversal — keys are `{scope}/{userId}/{filename}`. */
function safeLocalPath(key: string): string {
  const resolved = path.resolve(LOCAL_ROOT, key);
  if (!resolved.startsWith(LOCAL_ROOT + path.sep)) {
    throw ApiError.forbidden("Invalid storage key");
  }
  return resolved;
}

const localProvider: StorageProvider = {
  async upload(buffer, key) {
    const filePath = safeLocalPath(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
  },
  async getDownloadUrl(key, ttlSec = 15 * 60) {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = signKey(key, exp);
    return `/api/media/${key}?exp=${exp}&sig=${sig}`;
  },
  async read(key) {
    return readFile(safeLocalPath(key));
  },
  async delete(key) {
    await unlink(safeLocalPath(key)).catch(() => {});
  },
};

function notConfigured(name: StorageProviderName): never {
  throw new Error(
    `STORAGE_PROVIDER=${name} requires its SDK and credentials — see .env.example (local provider works with zero config)`
  );
}

const s3Provider: StorageProvider = {
  upload: () => notConfigured("s3"),
  getDownloadUrl: () => notConfigured("s3"),
  read: () => notConfigured("s3"),
  delete: () => notConfigured("s3"),
};

const cloudinaryProvider: StorageProvider = {
  upload: () => notConfigured("cloudinary"),
  getDownloadUrl: () => notConfigured("cloudinary"),
  read: () => notConfigured("cloudinary"),
  delete: () => notConfigured("cloudinary"),
};

export function getStorage(): StorageProvider {
  const provider = (process.env.STORAGE_PROVIDER ?? "local") as StorageProviderName;
  switch (provider) {
    case "local":
      return localProvider;
    case "s3":
      return s3Provider;
    case "cloudinary":
      return cloudinaryProvider;
    default:
      return localProvider;
  }
}

/** Media GET route helper — validates `exp` + `sig` query params. */
export function verifyMediaSignature(
  key: string,
  searchParams: URLSearchParams
): void {
  const exp = searchParams.get("exp");
  const sig = searchParams.get("sig");
  if (!exp || !sig || !verifySignature(key, exp, sig)) {
    throw ApiError.forbidden("Invalid or expired media signature");
  }
}
