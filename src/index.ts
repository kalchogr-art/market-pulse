// Market Pulse V1.1.1 — Capital.com DEMO dashboard and historical candles. No trading endpoints.
interface Env {
  CAPITAL_API_KEY: string;
  CAPITAL_IDENTIFIER: string;
  CAPITAL_API_PASSWORD: string;
  ADMIN_TOKEN: string;
}
type Obj = Record<string, any>;
const BASE = 'https://demo-api-capital.backend-capital.com/api/v1';
const VERSION = '1.1.1';
const TIMEOUT_MS = 12000;
const INFO = {worker: 'market-pulse', version: VERSION, mode: 'DEMO_READ_ONLY', trading_enabled: false};
class Fault extends Error {
  code: string; status: number; upstreamStatus?: number; diagnostic?: Obj;
  constructor(code: string, status = 502, upstreamStatus?: number, diagnostic?: Obj) {
    super(code); this.name = 'Fault'; this.code=code; this.status=status; this.upstreamStatus=upstreamStatus; this.diagnostic=diagnostic;
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
function failure(error: unknown) {
  const fault = error instanceof Fault ? error : new Fault('INTERNAL_ERROR', 500);
  return {success: false, error: fault.code, upstream_status: fault.upstreamStatus ?? null,
    diagnostic: fault.diagnostic ?? null};
}
// Classify locally. Never expose raw exception messages, headers, bodies or credentials.
function exceptionDetails(error: unknown): Obj {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const kind = /dns|resolve|enotfound/.test(message) ? 'DNS' :
    /tls|ssl|certificate/.test(message) ? 'TLS' :
    /redirect/.test(message) ? 'REDIRECT' :
    /header|invalid.*url/.test(message) ? 'REQUEST_CONFIGURATION' : 'UNCLASSIFIED';
  return {exception_type: ['TypeError', 'Error', 'AbortError', 'TimeoutError', 'RangeError'].includes(name) ? name : 'Other',
    error_category_hint: kind};
}
async function request(path: string, init: RequestInit = {}) {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  let stage = 'fetch';
  let response: Response | undefined;
  // Use a controller instead of relying on AbortSignal.timeout support.
  // Keep the timer active through response body reading as well.
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  const diagnostic = () => ({endpoint: path.split('?')[0], method: init.method ?? 'GET', stage,
    elapsed_ms: Date.now() - started, timeout_ms: TIMEOUT_MS,
    ...(response ? {response_format: (response.headers.get('content-type') ?? '').toLowerCase().includes('json') ? 'JSON' : 'NON_JSON'} : {})});
  try {
    response = await fetch(BASE + path, {...init, redirect: 'manual', signal: controller.signal});
    stage = 'response_headers';
    if (response.status >= 300 && response.status < 400) {
      throw new Fault('CAPITAL_REDIRECT_RESPONSE', 502, response.status, diagnostic());
    }
    if (!response.ok) {
      const code = response.status === 429 ? 'CAPITAL_RATE_LIMIT' :
        response.status === 401 || response.status === 403 ? 'CAPITAL_AUTH_REJECTED' : 'CAPITAL_REQUEST_FAILED';
      throw new Fault(code, 502, response.status, diagnostic());
    }
    stage = 'response_body';
    const text = await response.text();
    stage = 'json_parse';
    let data: Obj;
    try { data = JSON.parse(text); }
    catch { throw new Fault('CAPITAL_NON_JSON_RESPONSE', 502, response.status, diagnostic()); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Fault('CAPITAL_INVALID_JSON_RESPONSE', 502, response.status, diagnostic());
    }
    return {data, response, diagnostic: diagnostic()};
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(timedOut ? 'CAPITAL_TIMEOUT' : 'CAPITAL_REQUEST_EXCEPTION', 502, response?.status,
      {...diagnostic(), ...exceptionDetails(error)});
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.bodyUsed) {
      try { await response.body.cancel(); } catch { /* No raw error output. */ }
    }
  }
}
async function session(env: Env) {
  const signature = JSON.stringify([env.CAPITAL_API_KEY, env.CAPITAL_IDENTIFIER, env.CAPITAL_API_PASSWORD]);
  if (cached?.signature === signature && cached.expires > Date.now()) return cached;
  if (pending?.signature === signature) return pending.promise;
  if (Date.now() - lastLogin < 1500) throw new Fault('LOGIN_COOLDOWN_RETRY', 429);
  lastLogin = Date.now();
  const promise = (async () => {
    const {response, diagnostic} = await request('/session', {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-CAP-API-KEY': env.CAPITAL_API_KEY},
      body: JSON.stringify({identifier: env.CAPITAL_IDENTIFIER, password: env.CAPITAL_API_PASSWORD, encryptedPassword: false})
    });
    const cst = response.headers.get('CST');
    const token = response.headers.get('X-SECURITY-TOKEN');
    if (!cst || !token) throw new Fault('CAPITAL_SESSION_HEADERS_MISSING', 502, response.status, diagnostic);
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
function missingSecrets(env: Env) {
  const required: (keyof Env)[] = ['CAPITAL_API_KEY', 'CAPITAL_IDENTIFIER', 'CAPITAL_API_PASSWORD'];
  return required.filter(key => !env[key]?.trim());
}
async function diagnose(env: Env) {
  const checks: Obj[] = [];
  try {
    const result = await request('/time');
    if (number(result.data.serverTime) === null) throw new Fault('CAPITAL_INVALID_TIME_RESPONSE', 502, result.response.status, result.diagnostic);
    checks.push({step: 'DEMO_TIME_NO_CREDENTIALS', success: true, upstream_status: result.response.status,
      server_time: result.data.serverTime, diagnostic: result.diagnostic});
  } catch (error) {
    checks.push({step: 'DEMO_TIME_NO_CREDENTIALS', ...failure(error)});
  }
  const missing = missingSecrets(env);
  if (missing.length) {
    checks.push({step: 'SESSION_AND_ACCOUNTS', success: false, error: 'MISSING_SECRETS', missing});
  } else {
    const started = Date.now();
    const signature = JSON.stringify([env.CAPITAL_API_KEY, env.CAPITAL_IDENTIFIER, env.CAPITAL_API_PASSWORD]);
    const wasCached = cached?.signature === signature && cached.expires > Date.now();
    try {
      const data = await get(env, '/accounts');
      if (!Array.isArray(data.accounts)) throw new Fault('CAPITAL_INVALID_ACCOUNTS_RESPONSE');
      checks.push({step: 'SESSION_AND_ACCOUNTS', success: true, session_source: wasCached ? 'CACHE' : 'LOGIN_OR_IN_FLIGHT',
        account_count: data.accounts.length, elapsed_ms: Date.now() - started});
    } catch (error) {
      checks.push({step: 'SESSION_AND_ACCOUNTS', ...failure(error), elapsed_ms: Date.now() - started});
    }
  }
  return {success: checks.every(check => check.success === true), ...INFO,
    checked_at: new Date().toISOString(), api_host: new URL(BASE).hostname, checks};
}
const WATCHLIST = [
  {epic: 'EURUSD', label: 'EUR / USD', type: 'CURRENCIES'},
  {epic: 'GOLD', label: 'Злато', type: 'COMMODITIES'},
  {epic: 'SILVER', label: 'Сребро', type: 'COMMODITIES'},
  {epic: 'OIL_CRUDE', label: 'Crude Oil', type: 'COMMODITIES'},
  {epic: 'OIL_BRENT', label: 'Brent Oil', type: 'COMMODITIES'}
];
const RESOLUTIONS: Record<string, number> = {MINUTE: 60000, MINUTE_5: 300000};
function utcMs(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(value)) return null;
  const timestamp = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value + 'Z');
  return Number.isFinite(timestamp) ? timestamp : null;
}
// Use the search route already verified against this demo account.
// Four read requests, at most two concurrently; Oil supplies both exact oil epics.
async function dashboard(env: Env) {
  const searches = [
    {query: 'EURUSD', epics: ['EURUSD']},
    {query: 'Gold', epics: ['GOLD']},
    {query: 'silver', epics: ['SILVER']},
    {query: 'Oil', epics: ['OIL_CRUDE', 'OIL_BRENT']}
  ];
  const results: Obj[] = [];
  const errors = new Map<string, Obj>();
  const checks: Obj[] = [];
  // Authenticate once before starting concurrent GET requests.
  await session(env);
  for (let offset = 0; offset < searches.length; offset += 2) {
    const batch = searches.slice(offset, offset + 2);
    const settled = await Promise.allSettled(batch.map(async search => {
      const data = await get(env, '/markets?searchTerm=' + encodeURIComponent(search.query));
      if (!Array.isArray(data.markets)) {
        throw new Fault('CAPITAL_INVALID_MARKETS_RESPONSE', 502, 200, {
          endpoint: '/markets', method: 'GET', request_mode: 'searchTerm', query: search.query,
          markets_field_type: data.markets === null ? 'null' : Array.isArray(data.markets) ? 'array' : typeof data.markets,
          has_market_details_array: Array.isArray(data.marketDetails)
        });
      }
      return data.markets;
    }));
    settled.forEach((outcome, i) => {
      const search = batch[i];
      if (outcome.status === 'fulfilled') {
        // Discard unrelated search matches before building the watchlist.
        const exact = outcome.value.filter((m: Obj) => m && search.epics.includes(m.epic));
        results.push(...exact);
        checks.push({query: search.query, success: true, returned_count: outcome.value.length,
          exact_count: exact.length, expected_epics: search.epics});
      } else {
        const detail = failure(outcome.reason);
        for (const epic of search.epics) errors.set(epic, detail);
        checks.push({query: search.query, ...detail});
      }
    });
  }
  const now = Date.now();
  const markets = WATCHLIST.map(item => {
    const queryError = errors.get(item.epic);
    if (queryError) return {...item, success: false, issue: queryError.error, diagnostic: queryError.diagnostic, upstream_status: queryError.upstream_status};
    const matches = results.filter((m: Obj) => m && m.epic === item.epic);
    if (matches.length !== 1) return {...item, success: false, issue: matches.length ? 'DUPLICATE_EPIC' : 'MARKET_NOT_RETURNED'};
    const raw = matches[0];
    if (raw.instrumentType !== item.type) return {...item, success: false, issue: 'INSTRUMENT_TYPE_MISMATCH'};
    const q = quote(raw);
    const time = utcMs(q.update_time);
    const age = time === null ? null : Math.round((now - time) / 1000);
    const valid = q.bid !== null && q.offer !== null && q.bid > 0 && q.offer >= q.bid;
    const freshness = age === null ? 'UNKNOWN_TIME' : age < -5 ? 'FUTURE_TIME' : age > 60 ? 'STALE' : 'FRESH';
    return {...q, label: item.label, success: valid, issue: valid ? null : 'INVALID_BID_ASK',
      age_seconds: age, freshness, delay_time: q.delay_time,
      usable_quote: valid && freshness === 'FRESH' && q.status === 'TRADEABLE' && q.delay_time === 0,
      spread_pips: item.epic === 'EURUSD' && q.spread !== null ? Number((q.spread / 0.0001).toFixed(3)) : null};
  });
  return {success: markets.every(m => m.success), ...INFO, fetched_at: new Date(now).toISOString(),
    source: 'SEARCH_TERM_EXACT_EPIC', request_count: searches.length, checks, markets,
    note: 'FRESH означава възраст до 60 секунди, не сигнал за вход. Времената updateTime без зона се тълкуват като UTC. Спредовете са в ценови единици.'};
}
function priceSide(value: unknown): {bid: number; ask: number} | null {
  const p = value as Obj | null;
  const bid = number(p?.bid), ask = number(p?.ask);
  return bid !== null && ask !== null && bid > 0 && ask >= bid ? {bid, ask} : null;
}
async function candles(env: Env, epic: string, resolution: string) {
  if (!WATCHLIST.some(x => x.epic === epic)) throw new Fault('EPIC_NOT_ALLOWED', 400);
  if (!Object.hasOwn(RESOLUTIONS, resolution)) throw new Fault('RESOLUTION_NOT_ALLOWED', 400);
  const data = await get(env, '/prices/' + encodeURIComponent(epic) + '?resolution=' + resolution + '&max=120');
  if (!Array.isArray(data.prices)) throw new Fault('CAPITAL_INVALID_PRICES_RESPONSE');
  const now = Date.now(), duration = RESOLUTIONS[resolution];
  const byTime = new Map<number, Obj>();
  let invalid = 0, duplicates = 0;
  for (const raw of data.prices) {
    const time = utcMs(raw?.snapshotTimeUTC);
    const o = priceSide(raw?.openPrice), h = priceSide(raw?.highPrice), l = priceSide(raw?.lowPrice), c = priceSide(raw?.closePrice);
    if (time === null || time > now + 5000 || !o || !h || !l || !c ||
      h.bid < Math.max(o.bid,c.bid,l.bid) || l.bid > Math.min(o.bid,c.bid,h.bid) ||
      h.ask < Math.max(o.ask,c.ask,l.ask) || l.ask > Math.min(o.ask,c.ask,h.ask)) {invalid++; continue;}
    if (byTime.has(time)) {duplicates++; continue;}
    // Use BID OHLC: exact broker series, never invent midpoint highs/lows.
    byTime.set(time, {time: new Date(time).toISOString(), timestamp_ms: time,
      open: o.bid, high: h.bid, low: l.bid, close: c.bid,
      ask_open: o.ask, ask_high: h.ask, ask_low: l.ask, ask_close: c.ask,
      complete: time + duration <= now - 2000});
  }
  const rows = [...byTime.values()].sort((a,b) => a.timestamp_ms-b.timestamp_ms);
  const closed = rows.filter(x => x.complete);
  let gaps = 0;
  for (let i=1;i<rows.length;i++) if (rows[i].timestamp_ms-rows[i-1].timestamp_ms > duration) gaps++;
  const latest = rows.at(-1);
  return {success: rows.length > 0, ...INFO, epic, resolution, price_basis: 'BID', fetched_at: new Date(now).toISOString(),
    requested_count: 120, received_count: data.prices.length, count: rows.length, closed_count: closed.length,
    forming_count: rows.length-closed.length, invalid_count: invalid, duplicate_count: duplicates, gap_count: gaps,
    latest_age_seconds: latest ? Math.round((now-latest.timestamp_ms)/1000) : null,
    history_stale: latest ? now-(latest.timestamp_ms+duration) > duration*2 : null,
    error: rows.length ? null : 'NO_VALID_CANDLES', candles: rows,
    note: 'BID свещи. Затваряне по UTC начало + интервал и 2 секунди буфер. Пропуските не се запълват; могат да са извън пазарната сесия. Няма сигнали или сделки.'};
}

const PAGE = `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Market Pulse</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0b1320;color:#e5edf7}*{box-sizing:border-box}body{max-width:1180px;margin:0 auto;padding:24px}header{display:flex;justify-content:space-between;gap:12px;align-items:center}h1{margin:0;font-size:28px}h2{font-size:19px;margin:0 0 14px}.muted,small{color:#9cb0c7}.badge{color:#85e4bd;border:1px solid #285947;padding:7px 10px;border-radius:20px;font-size:12px}.panel{background:#111e30;border:1px solid #24374d;border-radius:14px;padding:18px;margin-top:18px}.bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}input,button,select{font:inherit;border:1px solid #36506b;border-radius:8px;padding:10px;background:#16273b;color:#e5edf7}input[type=password]{flex:1;min-width:180px}button{cursor:pointer;background:#79dcb4;color:#09231b;font-weight:650}button.secondary{background:#1b3048;color:#dce8f5}button:disabled{opacity:.5;cursor:wait}label{font-size:14px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:12px;margin-top:16px}.card{background:#142439;border:1px solid #2c435d;border-radius:10px;padding:16px}.card h3{margin:0 0 6px;font-size:17px}.price{font-size:22px;font-variant-numeric:tabular-nums;margin:14px 0}.good{color:#85e4bd}.warn{color:#ffcf7a}.bad{color:#ff959d}canvas{width:100%;height:300px;display:block;margin-top:14px;background:#0d1929;border-radius:8px}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px;white-space:nowrap}td,th{text-align:right;padding:9px;border-bottom:1px solid #263a52}td:first-child,th:first-child{text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:460px;overflow:auto;font-size:12px}#message{min-height:24px;margin:12px 0 0}details{margin-top:16px}summary{cursor:pointer}@media(max-width:500px){body{padding:14px}.panel{padding:12px}header{align-items:flex-start}.grid{grid-template-columns:1fr}h1{font-size:24px}}
</style></head><body>
<header><div><h1>Market Pulse</h1><small>V1.1.1 · Capital.com</small></div><span class="badge">DEMO · READ ONLY</span></header>
<p class="muted">Пет пазара · котировки и исторически свещи · търговията е изключена</p>
<section class="panel"><label for="token">ADMIN_TOKEN</label><div class="bar"><input id="token" type="password" autocomplete="off" placeholder="Токенът на Market Pulse"><button id="refresh">Обнови пазарите</button><button class="secondary" id="clear">Изчисти</button></div><small>Токенът остава само в това поле. Не въвеждай Capital.com API ключ.</small>
<div class="bar" style="margin-top:12px"><label><input type="checkbox" id="auto"> Котировки през 30 секунди</label><button class="secondary" id="diagnostics">Диагностика</button><button class="secondary" id="accounts">Акаунти</button></div><p id="message" role="status">Въведи токена и обнови пазарите.</p></section>
<section class="panel"><h2>Пазарен преглед</h2><small id="updated">Все още няма заредени данни.</small><div class="grid" id="markets"></div><small>Спредът е в ценови единици; само EUR/USD показва и пипсове. FRESH ≤ 60 секунди.</small></section>
<section class="panel"><h2>Исторически свещи</h2><div class="bar"><select id="epic" aria-label="Инструмент"><option value="EURUSD">EUR / USD</option><option value="GOLD">Злато</option><option value="SILVER">Сребро</option><option value="OIL_CRUDE">Crude Oil</option><option value="OIL_BRENT">Brent Oil</option></select><select id="resolution" aria-label="Интервал"><option value="MINUTE">1 минута</option><option value="MINUTE_5">5 минути</option></select><button id="history">Зареди 120 свещи</button></div>
<p class="muted" id="historyInfo">Избери инструмент. Историята се зарежда ръчно.</p><canvas id="chart" aria-label="Графика на BID свещите" role="img"></canvas><small>BID цени · зелено: покачване · червено: спад · жълто: незавършена свещ. Разстоянията са по ред на свещите, не по изминало време.</small>
<div class="scroll"><table><thead><tr><th>UTC</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Статус</th></tr></thead><tbody id="rows"></tbody></table></div></section>
<details class="panel"><summary>Диагностика / JSON на последния отговор</summary><pre id="result">Няма данни.</pre></details>
<script>
const $=id=>document.getElementById(id);let busy=false,chartRows=[],lastQuoteAt=0;
const fmt=v=>typeof v==='number'?v.toLocaleString('en-US',{maximumFractionDigits:6,useGrouping:false}):'—';
function element(tag,text,cls){const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;}
function message(text,bad=false){$('message').textContent=text;$('message').className=bad?'warn':'good';}
async function api(path){const token=$('token').value.trim();if(!token)throw Error('Въведи ADMIN_TOKEN.');const response=await fetch(path,{headers:{Authorization:'Bearer '+token},cache:'no-store'});const data=await response.json();$('result').textContent=JSON.stringify(data,null,2);if(!response.ok)throw Error(data.error||'HTTP '+response.status);return data;}
async function action(fn){if(busy)return;busy=true;document.querySelectorAll('button,select').forEach(b=>b.disabled=true);message('Зареждане…');try{await fn();}catch(e){message(e.message||'Неуспешна заявка.',true);}finally{busy=false;document.querySelectorAll('button,select').forEach(b=>b.disabled=false);}}
function renderMarkets(data){$('markets').replaceChildren();for(const m of data.markets){const card=element('div','', 'card');card.append(element('h3',m.label||m.epic),element('small',m.epic));if(m.bid!=null){card.append(element('div',fmt(m.bid)+' / '+fmt(m.offer),'price'),element('p','Спред: '+fmt(m.spread)+(m.spread_pips!=null?' · '+fmt(m.spread_pips)+' пипса':'')));}card.append(element('p',m.issue||((m.status||'UNKNOWN')+' · '+(m.freshness||'UNKNOWN')),m.usable_quote?'good':'warn'),element('small','Възраст: '+(m.age_seconds??'—')+' s · delay: '+(m.delay_time??'—')));$('markets').append(card);}lastQuoteAt=Date.now();$('updated').textContent='Получени: '+data.fetched_at+' · снимка на котировките';}
async function refresh(){await action(async()=>{try{const data=await api('/api/dashboard');renderMarkets(data);message(data.success?'Пазарите са обновени.':'Част от пазарите липсват или са невалидни.',!data.success);}catch(e){lastQuoteAt=0;$('updated').textContent='Обновяването е неуспешно. Показаните данни са от предишна заявка.';for(const p of $('markets').querySelectorAll('.good')){p.className='warn';p.textContent='ПРЕДИШНА СНИМКА — ОБНОВЯВАНЕТО Е НЕУСПЕШНО';}throw e;}});}
function draw(){const canvas=$('chart'),ctx=canvas.getContext('2d');const w=canvas.clientWidth||600,h=300,dpr=window.devicePixelRatio||1;canvas.width=w*dpr;canvas.height=h*dpr;ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);if(!chartRows.length){ctx.fillStyle='#9cb0c7';ctx.fillText('Няма заредени свещи',16,30);return;}const rows=chartRows.slice(-80),lo=Math.min(...rows.map(r=>r.low)),hi=Math.max(...rows.map(r=>r.high)),pad=(hi-lo)*.08||Math.max(hi*.0001,.00001),min=lo-pad,max=hi+pad,left=14,right=76,top=18,bottom=28,plot=w-left-right,step=plot/rows.length;const y=v=>top+(max-v)/(max-min)*(h-top-bottom);ctx.font='11px system-ui';for(let i=0;i<5;i++){const v=min+(max-min)*i/4,yy=y(v);ctx.strokeStyle='#23384f';ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(w-right,yy);ctx.stroke();ctx.fillStyle='#9cb0c7';ctx.fillText(fmt(v),w-right+6,yy+4);}rows.forEach((r,i)=>{const x=left+step*(i+.5);ctx.fillStyle=ctx.strokeStyle=!r.complete?'#ffcf7a':r.close>=r.open?'#79dcb4':'#f18391';ctx.beginPath();ctx.moveTo(x,y(r.high));ctx.lineTo(x,y(r.low));ctx.stroke();ctx.fillRect(x-Math.max(1,step*.6)/2,Math.min(y(r.open),y(r.close)),Math.max(1,step*.6),Math.max(1,Math.abs(y(r.close)-y(r.open))));});ctx.fillStyle='#9cb0c7';ctx.fillText(rows[0].time.slice(11,16)+' UTC',left,h-7);ctx.fillText(rows[rows.length-1].time.slice(11,16)+' UTC',Math.max(left,w-right-70),h-7);}
async function history(){await action(async()=>{chartRows=[];draw();$('rows').replaceChildren();const epic=$('epic').value,res=$('resolution').value;$('historyInfo').textContent=epic+' · '+res+' · заявка за нова история…';const d=await api('/api/candles?epic='+encodeURIComponent(epic)+'&resolution='+res);chartRows=d.candles||[];draw();$('historyInfo').textContent=epic+' · '+res+' · затворени: '+d.closed_count+' · незавършени: '+d.forming_count+' · невалидни: '+d.invalid_count+' · пропуски: '+d.gap_count+(d.history_stale?' · ОСТАРЯЛА ИСТОРИЯ':'')+' · получени: '+d.fetched_at;for(const r of chartRows.slice(-12).reverse()){const tr=document.createElement('tr');for(const value of [r.time.slice(0,19).replace('T',' '),fmt(r.open),fmt(r.high),fmt(r.low),fmt(r.close),r.complete?'Затворена':'Текуща'])tr.append(element('td',value));$('rows').append(tr);}message(d.success?'Свещите са заредени.':d.error,!d.success);});}
$('refresh').onclick=refresh;$('history').onclick=history;
$('diagnostics').onclick=()=>action(async()=>{const d=await api('/api/diagnostics');message(d.success?'Връзката работи.':'Виж диагностиката за грешката.',!d.success);$('result').parentElement.open=true;});
$('accounts').onclick=()=>action(async()=>{await api('/api/check');message('Демо акаунтите са прочетени.');$('result').parentElement.open=true;});
$('clear').onclick=()=>{$('auto').checked=false;$('token').value='';$('markets').replaceChildren();$('rows').replaceChildren();chartRows=[];draw();lastQuoteAt=0;$('result').textContent='Няма данни.';$('updated').textContent='Няма заредени данни.';$('historyInfo').textContent='Избери инструмент.';message('Токенът и данните са изчистени.');};
for(const id of ['epic','resolution'])$(id).onchange=()=>{chartRows=[];draw();$('rows').replaceChildren();$('historyInfo').textContent='Натисни „Зареди 120 свещи“ за новия избор.';};
setInterval(()=>{if($('auto').checked&&!document.hidden&&!busy&&$('token').value.trim())refresh();},30000);
setInterval(()=>{if(lastQuoteAt&&Date.now()-lastQuoteAt>60000){$('updated').textContent='Показаната снимка е на повече от 60 секунди. Обнови пазарите.';for(const p of $('markets').querySelectorAll('.good')){p.className='warn';p.textContent='СТАРА СНИМКА — ОБНОВИ';}}},5000);
window.addEventListener('resize',draw);draw();
</script></body></html>
`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== 'GET') return json({success: false, error: 'METHOD_NOT_ALLOWED'}, 405);
    if (url.pathname === '/') return new Response(PAGE, {headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
    }});
    if (url.pathname === '/health') return json({success: true, ...INFO});
    if (!['/api/check', '/api/markets', '/api/diagnostics', '/api/dashboard', '/api/candles'].includes(url.pathname)) return json({success: false, error: 'NOT_FOUND'}, 404);
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return json({success: false, error: 'ADMIN_TOKEN_MISSING_OR_TOO_SHORT'}, 503);
    if (req.headers.get('Authorization') !== 'Bearer ' + env.ADMIN_TOKEN) return json({success: false, error: 'UNAUTHORIZED'}, 401);
    try {
      if (url.pathname === '/api/diagnostics') return json(await diagnose(env));
      const missing = missingSecrets(env);
      if (missing.length) return json({success: false, ...INFO, error: 'MISSING_SECRETS', missing}, 503);
      if (url.pathname === '/api/dashboard') return json(await dashboard(env));
      if (url.pathname === '/api/candles') return json(await candles(env, url.searchParams.get('epic') ?? '', url.searchParams.get('resolution') ?? 'MINUTE'));
      if (url.pathname === '/api/check') {
        const data = await get(env, '/accounts');
        if (!Array.isArray(data.accounts)) throw new Fault('CAPITAL_INVALID_ACCOUNTS_RESPONSE');
        return json({success: true, ...INFO, checked_at: new Date().toISOString(), accounts: data.accounts.map((a: Obj) => ({
          currency: a.currency ?? null, status: a.status ?? null, type: a.accountType ?? null,
          preferred: a.preferred === true, balance: number(a.balance?.balance), available: number(a.balance?.available),
          profit_loss: number(a.balance?.profitLoss)
        }))});
      }
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q || q.length > 60 || /[\x00-\x1f]/.test(q)) return json({success: false, error: 'QUERY_REQUIRED_MAX_60_CHARACTERS'}, 400);
      const data = await get(env, '/markets?searchTerm=' + encodeURIComponent(q));
      if (!Array.isArray(data.markets)) throw new Fault('CAPITAL_INVALID_MARKETS_RESPONSE');
      return json({success: true, ...INFO, query: q, fetched_at: new Date().toISOString(), count: data.markets.length,
        markets: data.markets.map(quote), note: 'Котировките са моментна снимка; fetched_at не е времето на последната пазарна сделка.'});
    } catch (error) {
      return json({...INFO, ...failure(error)}, error instanceof Fault ? error.status : 500);
    }
  }
};
