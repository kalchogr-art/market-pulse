// Market Pulse V1.0.0 — Capital.com DEMO diagnostics. No trading endpoints.
interface Env {
  CAPITAL_API_KEY: string;
  CAPITAL_IDENTIFIER: string;
  CAPITAL_API_PASSWORD: string;
  ADMIN_TOKEN: string;
}
type Obj = Record<string, any>;
const BASE = 'https://demo-api-capital.backend-capital.com/api/v1';
const VERSION = '1.0.0';
class Fault extends Error {
  code: string;
  status: number;
  upstreamStatus?: number;
  constructor(code: string, status = 502, upstreamStatus?: number) {
    super(code); this.code = code; this.status = status; this.upstreamStatus = upstreamStatus;
  }
}
let cached: { signature: string; cst: string; token: string; expires: number } | undefined;
let pending: { signature: string; promise: Promise<NonNullable<typeof cached>> } | undefined;
let lastLogin = 0;
function json(body: Obj, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  }});
}
async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(BASE + path, {...init, redirect: 'error', signal: AbortSignal.timeout(12000)});
  } catch { throw new Fault('CAPITAL_NETWORK_OR_TIMEOUT'); }
  let data: Obj;
  try { data = await response.json() as Obj; }
  catch { throw new Fault('CAPITAL_NON_JSON_RESPONSE', 502, response.status); }
  // Never return upstream error bodies, headers, credentials or session tokens.
  if (!response.ok) {
    const code = response.status === 429 ? 'CAPITAL_RATE_LIMIT' :
      response.status === 401 || response.status === 403 ? 'CAPITAL_AUTH_REJECTED' : 'CAPITAL_REQUEST_FAILED';
    throw new Fault(code, 502, response.status);
  }
  return {data, response};
}
async function session(env: Env) {
  const signature = JSON.stringify([env.CAPITAL_API_KEY, env.CAPITAL_IDENTIFIER, env.CAPITAL_API_PASSWORD]);
  if (cached?.signature === signature && cached.expires > Date.now()) return cached;
  if (pending?.signature === signature) return pending.promise;
  // Rate guard per isolate; no global polling or Cron in this release.
  if (Date.now() - lastLogin < 1500) throw new Fault('LOGIN_COOLDOWN_RETRY', 429);
  lastLogin = Date.now();
  const promise = (async () => {
    const {response} = await request('/session', {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-CAP-API-KEY': env.CAPITAL_API_KEY},
      body: JSON.stringify({identifier: env.CAPITAL_IDENTIFIER, password: env.CAPITAL_API_PASSWORD, encryptedPassword: false})
    });
    const cst = response.headers.get('CST');
    const token = response.headers.get('X-SECURITY-TOKEN');
    if (!cst || !token) throw new Fault('CAPITAL_SESSION_HEADERS_MISSING');
    cached = {signature, cst, token, expires: Date.now() + 8 * 60 * 1000};
    return cached;
  })();
  pending = {signature, promise};
  try { return await promise; } finally { if (pending?.promise === promise) pending = undefined; }
}
async function get(env: Env, path: string) {
  const current = await session(env);
  try {
    return (await request(path, {headers: {'CST': current.cst, 'X-SECURITY-TOKEN': current.token}})).data;
  } catch (error) {
    if (error instanceof Fault && error.upstreamStatus === 401 && cached === current) cached = undefined;
    throw error;
  }
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function quote(m: Obj) {
  const bid = number(m.bid), offer = number(m.offer);
  return {epic: m.epic ?? null, name: m.instrumentName ?? null,
    instrument_type: m.instrumentType ?? null, status: m.marketStatus ?? null,
    bid, offer, spread: bid !== null && offer !== null ? Number((offer - bid).toPrecision(10)) : null,
    update_time: m.updateTimeUTC ?? m.updateTime ?? null, delay_time: m.delayTime ?? null};
}
const PAGE = `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Market Pulse</title>
<style>body{font:16px system-ui;background:#101923;color:#e7edf5;max-width:850px;margin:30px auto;padding:20px}h1{margin-bottom:5px}.badge{color:#8fe4bd}input,button{font:inherit;padding:12px;margin:6px 0;border:1px solid #526579;border-radius:8px}input{box-sizing:border-box;width:100%;background:#1c2a38;color:white}button{cursor:pointer;background:#9ae6c3;color:#10251c}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#192635;padding:16px;border-radius:10px}small{color:#b7c7d8}</style></head>
<body><h1>Market Pulse</h1><p class="badge">V1.0.0 · DEMO · READ ONLY</p>
<p>Проверка на връзката и котировки от Capital.com. Няма изпращане на поръчки.</p>
<label for="token">ADMIN_TOKEN на Worker-а</label><input id="token" type="password" autocomplete="off" placeholder="Твоят отделен токен за достъп">
<small>Тук не се въвежда Capital.com API ключът. Токенът не се запазва в браузъра.</small>
<p><button id="check">Провери връзката и акаунтите</button></p>
<label for="query">Търси инструмент</label><input id="query" value="EURUSD" maxlength="60">
<small>Примери: EURUSD, GBPUSD, gold, silver, oil. Резултатите са от API, без автоматичен избор.</small>
<p><button id="search">Покажи котировките</button></p><pre id="result">Готов за проверка.</pre>
<script>
const output=document.getElementById('result');
async function run(path){
 const token=document.getElementById('token').value.trim();
 if(!token){output.textContent='Въведи ADMIN_TOKEN.';return;}
 const buttons=document.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);
 output.textContent='Зареждане…';
 try{const response=await fetch(path,{headers:{Authorization:'Bearer '+token},cache:'no-store'});
 output.textContent=JSON.stringify(await response.json(),null,2);
 }catch{output.textContent='Неуспешна връзка с Worker-а.';}finally{buttons.forEach(b=>b.disabled=false);}
}
document.getElementById('check').onclick=()=>run('/api/check');
document.getElementById('search').onclick=()=>run('/api/markets?q='+encodeURIComponent(document.getElementById('query').value.trim()));
</script></body></html>`;
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'GET') return json({success: false, error: 'METHOD_NOT_ALLOWED'}, 405);
    if (url.pathname === '/') return new Response(PAGE, {headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
    }});
    const info = {worker: 'market-pulse', version: VERSION, mode: 'DEMO_READ_ONLY', trading_enabled: false};
    if (url.pathname === '/health') return json({success: true, ...info});
    if (!['/api/check', '/api/markets'].includes(url.pathname)) return json({success: false, error: 'NOT_FOUND'}, 404);
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return json({success: false, error: 'ADMIN_TOKEN_MISSING_OR_TOO_SHORT'}, 503);
    if (req.headers.get('Authorization') !== 'Bearer ' + env.ADMIN_TOKEN) return json({success: false, error: 'UNAUTHORIZED'}, 401);
    const required: (keyof Env)[] = ['CAPITAL_API_KEY', 'CAPITAL_IDENTIFIER', 'CAPITAL_API_PASSWORD'];
    const missing = required.filter(key => !env[key]?.trim());
    if (missing.length) return json({success: false, ...info, error: 'MISSING_SECRETS', missing}, 503);
    try {
      if (url.pathname === '/api/check') {
        const data = await get(env, '/accounts');
        if (!Array.isArray(data.accounts)) throw new Fault('CAPITAL_INVALID_ACCOUNTS_RESPONSE');
        return json({success: true, ...info, checked_at: new Date().toISOString(), accounts: data.accounts.map((a: Obj) => ({
          currency: a.currency ?? null, status: a.status ?? null, type: a.accountType ?? null,
          preferred: a.preferred === true, balance: number(a.balance?.balance), available: number(a.balance?.available),
          profit_loss: number(a.balance?.profitLoss)
        }))});
      }
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q || q.length > 60 || /[\x00-\x1f]/.test(q)) return json({success: false, error: 'QUERY_REQUIRED_MAX_60_CHARACTERS'}, 400);
      const data = await get(env, '/markets?searchTerm=' + encodeURIComponent(q));
      if (!Array.isArray(data.markets)) throw new Fault('CAPITAL_INVALID_MARKETS_RESPONSE');
      return json({success: true, ...info, query: q, fetched_at: new Date().toISOString(), count: data.markets.length,
        markets: data.markets.map(quote), note: 'Котировките са моментна снимка; fetched_at не е времето на последната пазарна сделка.'});
    } catch (error) {
      const fault = error instanceof Fault ? error : new Fault('INTERNAL_ERROR', 500);
      return json({success: false, ...info, error: fault.code, upstream_status: fault.upstreamStatus ?? null}, fault.status);
    }
  }
};
