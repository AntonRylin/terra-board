// The node:crypto calls the store makes: content-addressed asset IDs (SHA-256)
// and random IDs. Web Crypto's digest is asynchronous, so hashing uses noble.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const randomUUID = () => crypto.randomUUID();
export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') throw Error('Only SHA-256 is available on Android');
  const hash = sha256.create();
  const api = {
    update(data: Uint8Array | string) {
      hash.update(typeof data === 'string' ? new TextEncoder().encode(data) : data);
      return api;
    },
    digest(encoding?: 'hex') {
      const out = hash.digest();
      return encoding === 'hex' ? bytesToHex(out) : out;
    },
  };
  return api;
}
export function randomBytes(n: number) {
  return crypto.getRandomValues(new Uint8Array(n));
}
export default { randomUUID, createHash, randomBytes };
