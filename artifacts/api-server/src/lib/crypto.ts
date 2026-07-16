import { createHash, randomBytes } from "crypto";

/**
 * Hash a PIN using SHA-256. In production, consider bcrypt for stronger security.
 * For this lightweight internal tool, SHA-256 is acceptable.
 */
export function hashPin(pin: string): string {
  return createHash("sha256").update(pin).digest("hex");
}

/**
 * Verify a PIN against a stored hash.
 */
export function verifyPin(pin: string, hash: string): boolean {
  return hashPin(pin) === hash;
}

/**
 * Generate a random URL-safe token.
 */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}
