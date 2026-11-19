import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_MEDIA_TICKET_TTL_MS = 4 * 60 * 60 * 1000;

/** Generate an ephemeral 32-byte HMAC-SHA256 secret scoped to a single daemon process. */
export function generateMediaTicketSecret(): Buffer {
  return randomBytes(32);
}

/** Mint a time-bounded media capability ticket signed with HMAC-SHA256. */
export function mintMediaTicket(
  secret: Buffer,
  ttlMs = DEFAULT_MEDIA_TICKET_TTL_MS,
  now = Date.now(),
): { ticket: string; expiresAt: number } {
  const safeTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 0;
  const expiresAt = now + safeTtl;
  const nonce = randomBytes(16).toString("hex");
  const payload = `${expiresAt}.${nonce}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return {
    ticket: `${payload}.${signature}`,
    expiresAt,
  };
}

/** Verify a media capability ticket in constant time against expiration and signature tampering. */
export function verifyMediaTicket(
  secret: Buffer,
  ticket: string | null | undefined,
  now = Date.now(),
): boolean {
  if (typeof ticket !== "string" || !ticket) return false;
  const parts = ticket.split(".");
  if (parts.length !== 3) return false;
  const [expiresStr, nonce, signatureStr] = parts;
  if (!expiresStr || !nonce || !signatureStr) return false;
  if (!/^\d+$/.test(expiresStr) || !/^[0-9a-f]+$/i.test(nonce)) return false;

  const expiresAt = Number(expiresStr);
  if (!Number.isSafeInteger(expiresAt) || now >= expiresAt) return false;

  let providedDigest: Buffer;
  try {
    providedDigest = Buffer.from(signatureStr, "base64url");
  } catch {
    return false;
  }
  if (providedDigest.toString("base64url") !== signatureStr) return false;

  const expectedDigest = createHmac("sha256", secret).update(`${expiresStr}.${nonce}`).digest();
  if (providedDigest.length !== expectedDigest.length) return false;
  return timingSafeEqual(providedDigest, expectedDigest);
}
