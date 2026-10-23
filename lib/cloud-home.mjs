import { createHash } from 'node:crypto';

export const CLOUD_HOME_ENDPOINTS = Object.freeze({
  tokenUrl: 'https://www.yunzhijia.com/gateway/oauth2/token/getAccessToken',
  userInfoUrl: 'https://www.yunzhijia.com/gateway/ticket/user/acquirecontext'
});

// Only this server-side exchange is trusted. Client-side person info is not a login credential.
export function createCloudHomeTicketClient(config, fetchImpl = fetch, now = Date.now) {
  let cachedToken;
  let tokenRequest;
  const consumed = new Map();
  async function post(url, body) {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`cloud_home_http_${response.status}`);
    const result = await response.json();
    if (result.success !== true || !result.data) throw new Error('cloud_home_remote_rejected');
    return result.data;
  }
  async function token() {
    if (cachedToken?.expiresAt > now()) return cachedToken.value;
    if (!tokenRequest) tokenRequest = (async () => {
      const data = await post(config.tokenUrl, { appId: config.clientId, secret: config.clientSecret, timestamp: now(), scope: 'app' });
      if (typeof data.accessToken !== 'string' || !data.accessToken) throw new Error('cloud_home_token_missing');
      const ttl = Number(data.expireIn);
      cachedToken = { value: data.accessToken, expiresAt: now() + Math.max(0, Math.min(Number.isFinite(ttl) ? ttl : 6400, 6400) - 60) * 1000 };
      return data.accessToken;
    })().finally(() => { tokenRequest = null; });
    return tokenRequest;
  }
  return {
    async checkCredentials() { await token(); return true; },
    async verify(ticket) {
      if (typeof ticket !== 'string' || !ticket || ticket.length > 4096) throw new Error('cloud_home_ticket_invalid');
      for (const [key, expiry] of consumed) if (expiry <= now()) consumed.delete(key);
      const digest = createHash('sha256').update(ticket).digest('hex');
      if (consumed.has(digest)) throw new Error('cloud_home_ticket_replayed');
      if (consumed.size >= 2000) throw new Error('cloud_home_busy');
      consumed.set(digest, now() + 10 * 60_000);
      const accessToken = await token();
      const endpoint = new URL(config.userInfoUrl);
      endpoint.searchParams.set('accessToken', accessToken);
      const data = await post(endpoint.toString(), { appid: config.clientId, ticket, disposable: true });
      if (String(data.appid || '') !== config.clientId || String(data.eid || '') !== config.enterpriseId) throw new Error('cloud_home_wrong_tenant_or_app');
      if (typeof data.openid !== 'string' || !data.openid || data.openid.length > 120) throw new Error('cloud_home_subject_missing');
      return { subject: data.openid, enterpriseId: String(data.eid), account: String(data.jobNo || data.userid || data.openid).slice(0, 120), name: String(data.username || '').slice(0, 80) };
    }
  };
}
