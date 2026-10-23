import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Session IDs are bearer credentials. Persist only authenticated ciphertext.
export function createSessionCache(file, signingKey) {
  const key = createHash('sha256').update('team-mcp-browser-sessions-v1').update(signingKey).digest();
  let writes = Promise.resolve();
  return {
    async load() {
      let buffer;
      try { buffer = await fs.readFile(file); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      if (buffer.length < 29 || buffer[0] !== 1) throw new Error('Invalid session cache');
      const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(1, 13));
      decipher.setAuthTag(buffer.subarray(13, 29));
      const records = JSON.parse(Buffer.concat([decipher.update(buffer.subarray(29)), decipher.final()]).toString('utf8'));
      if (!Array.isArray(records)) throw new Error('Invalid session records');
      return records.filter(record => typeof record.id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(record.id) && typeof record.userId === 'string' && typeof record.identityStamp === 'string' && Number.isFinite(record.expiresAt) && record.expiresAt > Date.now());
    },
    save(records) {
      const snapshot = JSON.stringify(records);
      const next = writes.catch(() => {}).then(async () => {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        const ciphertext = Buffer.concat([cipher.update(snapshot, 'utf8'), cipher.final()]);
        const buffer = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        await fs.writeFile(temporary, buffer, { mode: 0o600 });
        await fs.rename(temporary, file);
      });
      writes = next;
      return next;
    }
  };
}
