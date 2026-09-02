import { randomBytes } from 'node:crypto';

/**
 * Bytes of entropy per identifier. 9 bytes encode to exactly 12 base64url
 * characters with no padding, carrying 72 bits.
 */
const PUBLIC_ID_BYTES = 9;

export const PUBLIC_ID_LENGTH = 12;

/**
 * Short, opaque, URL-safe identifier for the public address of a video.
 *
 * `base64url`, not `base64`: the standard alphabet contains `+`, `/` and `=`,
 * which would need escaping in a path segment. The two encodings produce
 * strings that look alike, so the difference only shows up later, in routing.
 *
 * Uniqueness is guaranteed by the unique constraint on the column, not by this
 * function. At 72 bits a collision is not a practical concern, but the caller
 * still retries on a unique violation: the database is what makes the promise,
 * so the promise survives any future change of generator.
 */
export function generatePublicId(): string {
  return randomBytes(PUBLIC_ID_BYTES).toString('base64url');
}
