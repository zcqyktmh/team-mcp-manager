import { randomBytes } from 'node:crypto';
import { createCloudHomeTicketClient } from './cloud-home.mjs';

// Setup is deliberately restricted to the local console, even behind a proxy.
export function createAdminEnrollment({ readConfig, writeConfig, issues, enabled, json, card, audit }) {
  const attempts = new Map();
  const cookie = (token, age) => `mcp_enrollment=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`;
  const tokenOf = req => (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('mcp_enrollment='))?.slice(15);
  return async (req, res, url) => {
    const api = url.pathname === '/api/settings/login/enrollment';
    const callback = url.pathname === '/auth/cloud-home/entry' && url.searchParams.get('state')?.startsWith('setup_');
    if (!api && !callback) return false;
    for (const [key, item] of attempts) if (item.expires < Date.now()) attempts.delete(key);
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const origin = `http://${req.headers.host}`;
    const hostname = new URL(origin).hostname;
    if (!local || !['127.0.0.1', 'localhost', '[::1]'].includes(hostname) || req.headers.forwarded || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || enabled()) {
      json(res, 403, { error: '首位管理员初始化仅限尚未启用登录的服务器本机配置页' }); return true;
    }
    if (api && (req.method !== 'POST' || req.headers.origin !== origin)) {
      json(res, 403, { error: '请从本机配置页面操作' }); return true;
    }
    const config = await readConfig();
    if (config.enabled || config.bootstrapAdminOpenId) { json(res, 409, { error: '已启用登录或已绑定管理员，初始化入口已关闭' }); return true; }
    if (callback) {
      const item = attempts.get(tokenOf(req));
      if (req.method !== 'GET' || !item || item.state !== url.searchParams.get('state') || item.used) { json(res, 403, { error: '扫码已失效，请从原配置页重新发起' }); return true; }
      item.used = true;
      try { item.identity = await createCloudHomeTicketClient(item.config).verify(url.searchParams.get('ticket')); }
      catch { item.error = '云之家身份验证失败，请核对企业和应用后重新扫码'; }
      card(res, item.error ? 401 : 200, item.error ? '扫码验证失败' : '扫码身份已获取', '<p>请回到原来的管理器配置页查看结果并确认绑定。此页可以关闭。</p>'); return true;
    }
    const action = url.searchParams.get('action');
    if (action === 'start') {
      const errors = issues({ ...config, bootstrapAdminOpenId: 'pending' });
      if (config.loginMode !== 'qr' || errors.length) { json(res, 400, { error: '请先选择网站扫码登录，填写应用资料和管理员账号、姓名、手机号并保存草稿。' + errors.join('；') }); return true; }
      if (attempts.size >= 100) { json(res, 429, { error: '初始化请求过多，请稍后重试' }); return true; }
      attempts.delete(tokenOf(req));
      const token = randomBytes(32).toString('hex');
      const state = 'setup_' + randomBytes(24).toString('hex');
      attempts.set(token, { state, config, expires: Date.now() + 300000 });
      const target = new URL('https://www.yunzhijia.com/opencloud/openthird/qrconnet');
      target.search = new URLSearchParams({ appid: config.clientId, redirect_uri: origin + '/auth/cloud-home/entry', state }).toString();
      // Cloud Home can return an HTML page whose image endpoint contains a JSON error,
      // while still claiming image/png. Detect that before sending users to a broken QR.
      try {
        const page = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(12000) });
        if (!page.ok) throw new Error('page');
        const html = await page.text();
        const match = html.match(/class="qrcode lightBorder" src="([^"]+)"/);
        if (!match) throw new Error('markup');
        const imageUrl = new URL(match[1].replaceAll('&amp;', '&'), target);
        if (imageUrl.protocol !== 'https:' || !['yunzhijia.com', 'www.yunzhijia.com'].includes(imageUrl.hostname)) throw new Error('origin');
        const image = await fetch(imageUrl, { redirect: 'error', signal: AbortSignal.timeout(12000) });
        const bytes = new Uint8Array(await image.arrayBuffer());
        const prefix = new TextDecoder().decode(bytes.slice(0, 1));
        if (!image.ok || bytes.length < 1000 || prefix === '{') {
          let errorCode = '';
          try { errorCode = JSON.parse(new TextDecoder().decode(bytes)).errorCode; } catch {}
          json(res, 502, { error: errorCode === 110
            ? '云之家未能生成二维码（错误码 110）。请确认填写的是此扫码轻应用自动生成的 AppID，并且应用已在当前企业团队启用，移动端访问地址为 https://www.yunzhijia.com/opencloud/openthird/qrlogin。'
            : '云之家二维码暂不可用，请检查扫码应用配置后重试。' }); return true;
        }
      } catch {
        attempts.delete(token);
        json(res, 502, { error: '暂时无法连接云之家二维码服务，请检查网络后重试。' }); return true;
      }
      res.setHeader('set-cookie', cookie(token, 300));
      json(res, 200, { url: target.href }); return true;
    }
    const item = attempts.get(tokenOf(req));
    if (!item) { json(res, 410, { error: '扫码操作已过期，请重新发起' }); return true; }
    if (JSON.stringify(config) !== JSON.stringify(item.config)) { attempts.delete(tokenOf(req)); json(res, 409, { error: '配置已发生变化，请重新扫码' }); return true; }
    if (item.error) { json(res, 400, { error: item.error }); return true; }
    if (action === 'status') { json(res, 200, { identity: item.identity || null, account: config.bootstrapAdminAccount, phone: config.bootstrapAdminPhone }); return true; }
    if (action !== 'confirm' || !item.identity) { json(res, 400, { error: '请先完成扫码并查看身份' }); return true; }
    // Consume before persistence so two concurrent confirmations cannot reuse it.
    attempts.delete(tokenOf(req));
    await writeConfig({ ...config, bootstrapAdminOpenId: item.identity.subject });
    audit();
    res.setHeader('set-cookie', cookie('', 0));
    json(res, 200, { message: '管理员企业身份已保存。请启用云之家登录、保存配置并重启管理器。' }); return true;
  };
}
