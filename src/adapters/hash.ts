import { createHash } from 'node:crypto';

/** SHA-256 hex digest of a UTF-8 string. Shared by every content/identity hash in the adapter layer. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
