import fs from 'node:fs/promises';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export function createServiceVault(file, signingKey) {
  const key = createHash('sha256').update('mcp-service-vault-v1').update(signingKey).digest();
  let queue = Promise.resolve();
  async function read() {
    let bytes;
    try { bytes = await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
  }
  return {
    async get(id) { await queue.catch(() => {}); return (await read())[id] || {}; },
    update(id, patch) {
      queue = queue.catch(() => {}).then(async () => {
        const all = await read(); all[id] = typeof patch === 'function' ? patch(all[id] || {}) : { ...(all[id] || {}), ...patch };
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
        const body = Buffer.concat([cipher.update(JSON.stringify(all), 'utf8'), cipher.final()]);
        await fs.writeFile(`${file}.tmp`, Buffer.concat([nonce, cipher.getAuthTag(), body]), { mode: 0o600 });
        await fs.rename(`${file}.tmp`, file);
      });
      return queue;
    }
  };
}
