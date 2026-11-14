import { createHash, randomBytes } from 'node:crypto';

/** Opaque bearer tokens for suppliers, sensors and vendor feeds: shown once, stored as a SHA-256 hash. */
export const newToken = (prefix: string) => {
  const token = `${prefix}_${randomBytes(24).toString('base64url')}`;
  return { token, hash: hashToken(token), hint: token.slice(-4) };
};
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
