import crypto from 'crypto';

/**
 * Same AES-256-GCM scheme as `src/lib/whatsapp/encryption.ts` in the
 * main app (format: `<iv-hex>:<ciphertext-hex>:<authTag-hex>`),
 * duplicated here because this worker is a separate npm project with
 * its own `package.json` (no shared workspace set up) — see the plan
 * doc. `ENCRYPTION_KEY` MUST be the same value in both `.env` files or
 * decrypts fail across the two processes.
 */

const GCM_IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function keyBuffer(encryptionKey: string): Buffer {
  return Buffer.from(encryptionKey, 'hex');
}

export function encrypt(text: string, encryptionKey: string): string {
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(encryptionKey), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`;
}

export function decrypt(encryptedText: string, encryptionKey: string): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error(`Encrypted value has unexpected format (expected 3 parts, got ${parts.length})`);
  }
  const [ivHex, ctHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  if (iv.length !== GCM_IV_LENGTH) {
    throw new Error(`Encrypted value has unexpected IV length ${iv.length}`);
  }
  const authTag = Buffer.from(tagHex, 'hex');
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(`Encrypted value has unexpected auth-tag length ${authTag.length}`);
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer(encryptionKey), iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ctHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
