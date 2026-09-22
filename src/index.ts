// Market Pulse V1.2.0 — Capital.com DEMO signal engine. READ ONLY. No trading endpoints.
interface Env {
  CAPITAL_API_KEY: string;
  CAPITAL_IDENTIFIER: string;
  CAPITAL_API_PASSWORD: string;
  ADMIN_TOKEN: string;
}
type Obj = Record<string, any>;
const BASE = 'https://demo-api-capital.backend-capital.com/api/v1';
const VERSION = '1.3.1';
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
    note: 'BID свещи. Затваряне по UTC начало + интервал и 2 секунди буфер. Пропуските не се запълват; могат да са извън пазарната сесия. /api/signal изчислява READ-ONLY сигнал само от затворени свещи; няма сделки.'};
}


function round(value: number | null, digits = 5): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return out;
  let seed = 0;
  for (let i=0;i<period;i++) seed += values[i];
  let prev = seed / period;
  out[period-1] = prev;
  const k = 2 / (period + 1);
  for (let i=period;i<values.length;i++) { prev = values[i] * k + prev * (1-k); out[i] = prev; }
  return out;
}
function rsiSeries(values: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gains=0, losses=0;
  for (let i=1;i<=period;i++) { const d=values[i]-values[i-1]; if (d>0) gains+=d; else losses-=d; }
  let avgGain=gains/period, avgLoss=losses/period;
  const calc=()=>avgLoss===0 ? 100 : 100-(100/(1+avgGain/avgLoss));
  out[period]=calc();
  for (let i=period+1;i<values.length;i++) {
    const d=values[i]-values[i-1], gain=Math.max(d,0), loss=Math.max(-d,0);
    avgGain=(avgGain*(period-1)+gain)/period; avgLoss=(avgLoss*(period-1)+loss)/period; out[i]=calc();
  }
  return out;
}
function atrSeries(rows: Obj[], period = 14): Array<number | null> {
  const tr: number[] = rows.map((r,i)=> i===0 ? r.high-r.low : Math.max(r.high-r.low, Math.abs(r.high-rows[i-1].close), Math.abs(r.low-rows[i-1].close)));
  const out: Array<number | null> = Array(rows.length).fill(null);
  if (tr.length < period) return out;
  let prev=tr.slice(0,period).reduce((a,b)=>a+b,0)/period; out[period-1]=prev;
  for (let i=period;i<tr.length;i++) { prev=(prev*(period-1)+tr[i])/period; out[i]=prev; }
  return out;
}
function signalFromClosed(rows: Obj[]) {
  if (rows.length < 30) return {ready:false, reason:'INSUFFICIENT_CLOSED_CANDLES', required:30, received:rows.length};
  const closes=rows.map(r=>Number(r.close));
  const ema9=emaSeries(closes,9), ema21=emaSeries(closes,21), rsi14=rsiSeries(closes,14), atr14=atrSeries(rows,14);
  const i=rows.length-1, last=rows[i];
  const e9=ema9[i], e21=ema21[i], rsi=rsi14[i], atr=atr14[i];
  if (e9===null || e21===null || rsi===null || atr===null || atr<=0) return {ready:false, reason:'INDICATORS_NOT_READY'};
  const trendRaw=(e9-e21)/atr;
  const trend=clamp(trendRaw*35,-100,100);
  const rsiComponent=clamp((rsi-50)*2,-100,100);
  const lookback=5;
  const momentumRaw=(last.close-rows[i-lookback].close)/atr;
  const momentum=clamp(momentumRaw*35,-100,100);
  const structureRaw=(last.close-e21)/atr;
  const structure=clamp(structureRaw*30,-100,100);
  // Balanced first research model. It is a signal score, not a profitability claim.
  const score=Math.round(clamp(trend*0.40 + momentum*0.25 + rsiComponent*0.20 + structure*0.15,-100,100));
  const direction=score>=60?'LONG':score<=-60?'SHORT':'NEUTRAL';
  const strength=Math.abs(score)>=80?'STRONG':Math.abs(score)>=60?'ACTIVE':Math.abs(score)>=35?'WATCH':'WEAK';
  return {ready:true, candle_time:last.time, close:last.close,
    indicators:{ema9:round(e9),ema21:round(e21),rsi14:round(rsi,2),atr14:round(atr)},
    components:{trend:round(trend,2),momentum_5:round(momentum,2),rsi:round(rsiComponent,2),structure:round(structure,2)},
    signal_score:score,direction,strength,
    thresholds:{long:60,short:-60},
    model:'EMA9/21 40% + MOMENTUM5 25% + RSI14 20% + EMA21 STRUCTURE 15%'};
}
async function signal(env: Env, epic: string, resolution: string) {
  const history=await candles(env,epic,resolution);
  const closed=(history.candles as Obj[]).filter(x=>x.complete===true);
  const result=signalFromClosed(closed);
  return {success:result.ready===true,...INFO,module:'SIGNAL_ENGINE',epic,resolution,price_basis:'BID',
    fetched_at:history.fetched_at,closed_count:closed.length,history_stale:history.history_stale,
    signal:result,trading:'DISABLED',execution:'NONE',
    note:'Research signal calculated only from CLOSED broker candles. No order is created or sent.'};
}


// ============================================================
// V1.3.0 NEWS / MACRO ENGINE — official-source RSS only.
// Research-only. News score is context, not a trading instruction.
// ============================================================
const NEWS_FEEDS = [
  {id:'FED_ALL', name:'Federal Reserve', url:'https://www.federalreserve.gov/feeds/press_all.xml', trust:100},
  {id:'FED_MONETARY', name:'Federal Reserve Monetary Policy', url:'https://www.federalreserve.gov/feeds/press_monetary.xml', trust:100},
  {id:'ECB_MID', name:'European Central Bank', url:'https://mid.ecb.europa.eu/rss/mid.xml', trust:100},
  {id:'CFTC_GENERAL', name:'CFTC', url:'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', trust:100}
] as const;
type NewsItem = {id:string;source_id:string;source_name:string;source_trust:number;title:string;text:string;url:string|null;published_at:string|null;published_ms:number|null;age_minutes:number|null};
function xmlText(s:string){return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();}
function xmlField(block:string,tag:string){const m=block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'));return m?xmlText(m[1]):'';}
function parseNews(xml:string,source:(typeof NEWS_FEEDS)[number]):NewsItem[]{const blocks=xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi)??xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi)??[];return blocks.slice(0,20).map((b,i)=>{const title=xmlField(b,'title'),desc=xmlField(b,'description')||xmlField(b,'summary')||xmlField(b,'content');let link=xmlField(b,'link');if(!link){const m=b.match(/<link[^>]+href=["']([^"']+)["']/i);link=m?.[1]??'';}const ds=xmlField(b,'pubDate')||xmlField(b,'updated')||xmlField(b,'published');const ms=ds?Date.parse(ds):NaN;const pm=Number.isFinite(ms)?ms:null;return{id:xmlField(b,'guid')||link||source.id+':'+title+':'+i,source_id:source.id,source_name:source.name,source_trust:source.trust,title,text:(title+' '+desc).trim(),url:link||null,published_at:pm!==null?new Date(pm).toISOString():ds||null,published_ms:pm,age_minutes:pm===null?null:Math.max(0,(Date.now()-pm)/60000)};});}
async function newsFeed(source:(typeof NEWS_FEEDS)[number]){try{const r=await fetch(source.url,{headers:{'user-agent':'market-pulse-readonly/1.3.1','accept':'application/rss+xml, application/xml, text/xml, */*'}});const t=await r.text();return{source:source.id,ok:r.ok,status:r.status,items:r.ok?parseNews(t,source):[] as NewsItem[]};}catch{return{source:source.id,ok:false,status:0,items:[] as NewsItem[]};}}
function has(t:string,words:string[]){const x=t.toLowerCase();return words.some(w=>x.includes(w));}
type NewsCategory='MONETARY_POLICY'|'INFLATION'|'LABOR'|'RATES'|'FX'|'ENERGY_OPEC'|'ROUTINE_DATA'|'ENFORCEMENT'|'REGULATION'|'OTHER';
function newsCategory(t:string,source:string):NewsCategory{const x=t.toLowerCase();if(has(x,['enforcement action','enforcement actions','termination of enforcement','fraud','whistleblower','court order','charges ']))return'ENFORCEMENT';if(has(x,['euro foreign exchange reference rates','euro-short-term-rate','€str','ester','publication message','compounded_']))return'ROUTINE_DATA';if(has(x,['fomc statement','monetary policy','target range','policy rate','rate hike','rate cut','interest rate decision','economic projections','central bank rate']))return'MONETARY_POLICY';if(has(x,['cpi','consumer price','pce','inflation','price pressures','core inflation']))return'INFLATION';if(has(x,['nonfarm payroll','non-farm payroll','payrolls','unemployment','employment','labor market','labour market','jobless claims']))return'LABOR';if(has(x,['treasury yield','bond yield','interest rates','yield curve','rate expectations']))return'RATES';if(has(x,['foreign exchange','exchange rate','currency','dollar','usd','euro','eur']))return'FX';if(has(x,['opec','oil','crude','brent','petroleum','energy','production cut','output cut','inventory','inventories','supply disruption']))return'ENERGY_OPEC';if(source==='CFTC_GENERAL')return'REGULATION';return'OTHER';}
function categoryBaseImpact(c:NewsCategory){return c==='MONETARY_POLICY'?95:c==='INFLATION'?90:c==='LABOR'?88:c==='ENERGY_OPEC'?88:c==='RATES'?78:c==='FX'?65:c==='REGULATION'?25:c==='ROUTINE_DATA'?8:c==='ENFORCEMENT'?5:15;}
function newsRelevance(epic:string,t:string,source:string,category:NewsCategory){if(category==='ENFORCEMENT')return 2;if(category==='ROUTINE_DATA')return epic==='EURUSD'?12:2;if(category==='REGULATION')return (epic==='OIL_CRUDE'||epic==='OIL_BRENT')&&has(t,['energy','oil','crude','petroleum'])?45:8;let r=0;if(epic==='EURUSD'){if(['MONETARY_POLICY','INFLATION','LABOR','RATES'].includes(category))r=90;else if(category==='FX')r=85;else r=10;if(source==='FED_MONETARY')r=Math.max(r,90);}else if(epic==='GOLD'||epic==='SILVER'){if(['MONETARY_POLICY','INFLATION','RATES'].includes(category))r=85;else if(category==='LABOR')r=70;else if(category==='FX')r=65;else r=8;}else if(epic==='OIL_CRUDE'||epic==='OIL_BRENT'){if(category==='ENERGY_OPEC')r=95;else if(['MONETARY_POLICY','INFLATION','LABOR'].includes(category))r=35;else r=5;}return Math.min(100,r);}
function newsDirection(epic:string,t:string,category:NewsCategory){if(['ROUTINE_DATA','ENFORCEMENT','REGULATION','OTHER'].includes(category))return 0;let usd=0,oil=0;const hawkish=['rate hike','raises rates','raised rates','higher rates','restrictive','inflation remains elevated','inflation elevated','tightening','upside risks to inflation'];const dovish=['rate cut','cuts rates','cut rates','lower rates','easing','reduce the target range','lower the target range','downside risks to employment'];const usdStrong=['stronger dollar','dollar strengthens','usd strengthens'];const usdWeak=['weaker dollar','dollar weakens','usd weakens'];if(has(t,hawkish))usd+=1;if(has(t,dovish))usd-=1;if(has(t,usdStrong))usd+=1;if(has(t,usdWeak))usd-=1;if(has(t,['production cut','output cut','supply disruption','supply shortage','lower production','decline in inventories']))oil+=1;if(has(t,['production increase','increase production','higher production','inventory build','rise in inventories','supply increase']))oil-=1;if(epic==='EURUSD')return usd===0?0:(usd>0?-1:1);if(epic==='GOLD'||epic==='SILVER')return usd===0?0:(usd>0?-1:1);if(epic==='OIL_CRUDE'||epic==='OIL_BRENT')return oil===0?0:(oil>0?1:-1);return 0;}
function newsDecay(age:number|null,category:NewsCategory){if(age===null)return 0;const maxAge=category==='MONETARY_POLICY'?10080:category==='INFLATION'||category==='LABOR'?4320:category==='ENERGY_OPEC'?2880:category==='RATES'||category==='FX'?1440:360;if(age>maxAge)return 0;const halfLife=category==='MONETARY_POLICY'?2160:category==='INFLATION'||category==='LABOR'?1080:category==='ENERGY_OPEC'?720:category==='RATES'||category==='FX'?360:120;return Math.exp(-Math.LN2*age/halfLife);}
function newsForEpic(epic:string,items:NewsItem[]){const classified=items.map(item=>{const category=newsCategory(item.text,item.source_id);const relevance=newsRelevance(epic,item.text,item.source_id,category);const direction=newsDirection(epic,item.text,category);const decay=newsDecay(item.age_minutes,category);const impact=categoryBaseImpact(category);const signed=direction*relevance/100*impact/100*decay*100;const active=relevance>=35&&impact>=35&&decay>=0.05;return{source:item.source_name,title:item.title,url:item.url,published_at:item.published_at,age_minutes:item.age_minutes===null?null:Math.round(item.age_minutes),category,relevance:Math.round(relevance),impact,decay:Math.round(decay*1000)/1000,direction:direction>0?'BULLISH':direction<0?'BEARISH':'NEUTRAL',signed_score:Math.round(signed*100)/100,active};}).sort((a,b)=>Number(b.active)-Number(a.active)||Math.abs(b.signed_score)-Math.abs(a.signed_score)||b.impact-a.impact);const active=classified.filter(x=>x.active);const directional=active.filter(x=>x.direction!=='NEUTRAL');const denom=directional.reduce((s,x)=>s+x.relevance*x.impact*x.decay,0);const score=denom?directional.reduce((s,x)=>s+x.signed_score*x.relevance*x.impact*x.decay,0)/denom:0;const categories:Record<string,number>={};for(const x of classified)categories[x.category]=(categories[x.category]||0)+1;return{epic,items_considered:classified.length,active_items:active.length,directional_active_items:directional.length,signed_score:Math.round(score*100)/100,bias:score>=5?'BULLISH':score<=-5?'BEARISH':'NEUTRAL',category_counts:categories,top_items:classified.slice(0,10)};}
async function newsEngine(epic:string){if(!WATCHLIST.some(x=>x.epic===epic))throw new Fault('EPIC_NOT_ALLOWED',400);const results=await Promise.all(NEWS_FEEDS.map(newsFeed));const seen=new Set<string>(),items:NewsItem[]=[];for(const x of results)for(const item of x.items){const k=item.url||item.id;if(!seen.has(k)){seen.add(k);items.push(item);}}return{success:results.some(x=>x.ok),...INFO,module:'NEWS_MACRO_ENGINE',epic,fetched_at:new Date().toISOString(),source_health:{configured:results.length,working:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length,sources:results.map(x=>({source:x.source,ok:x.ok,status:x.status,items:x.items.length}))},news:newsForEpic(epic,items),trading:'DISABLED',execution:'NONE',classifier_version:'1.3.1',note:'Official-source RSS research classifier with category-specific relevance, impact and time decay. Routine/enforcement items are suppressed. Direction is context, not a prediction or trade instruction.'};}

const PAGE = `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Market Pulse</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0b1320;color:#e5edf7}*{box-sizing:border-box}body{max-width:1180px;margin:0 auto;padding:24px}header{display:flex;justify-content:space-between;gap:12px;align-items:center}h1{margin:0;font-size:28px}h2{font-size:19px;margin:0 0 14px}.muted,small{color:#9cb0c7}.badge{color:#85e4bd;border:1px solid #285947;padding:7px 10px;border-radius:20px;font-size:12px}.panel{background:#111e30;border:1px solid #24374d;border-radius:14px;padding:18px;margin-top:18px}.bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}input,button,select{font:inherit;border:1px solid #36506b;border-radius:8px;padding:10px;background:#16273b;color:#e5edf7}input[type=password]{flex:1;min-width:180px}button{cursor:pointer;background:#79dcb4;color:#09231b;font-weight:650}button.secondary{background:#1b3048;color:#dce8f5}button:disabled{opacity:.5;cursor:wait}label{font-size:14px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:12px;margin-top:16px}.card{background:#142439;border:1px solid #2c435d;border-radius:10px;padding:16px}.card h3{margin:0 0 6px;font-size:17px}.price{font-size:22px;font-variant-numeric:tabular-nums;margin:14px 0}.good{color:#85e4bd}.warn{color:#ffcf7a}.bad{color:#ff959d}canvas{width:100%;height:300px;display:block;margin-top:14px;background:#0d1929;border-radius:8px}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px;white-space:nowrap}td,th{text-align:right;padding:9px;border-bottom:1px solid #263a52}td:first-child,th:first-child{text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:460px;overflow:auto;font-size:12px}#message{min-height:24px;margin:12px 0 0}details{margin-top:16px}summary{cursor:pointer}@media(max-width:500px){body{padding:14px}.panel{padding:12px}header{align-items:flex-start}.grid{grid-template-columns:1fr}h1{font-size:24px}}
</style></head><body>
<header><div><h1>Market Pulse</h1><small>V1.3.1 · Capital.com · News Classifier Fix</small></div><span class="badge">DEMO · READ ONLY</span></header>
<p class="muted">Пет пазара · котировки и исторически свещи · търговията е изключена</p>
<section class="panel"><label for="token">ADMIN_TOKEN</label><div class="bar"><input id="token" type="password" autocomplete="off" placeholder="Токенът на Market Pulse"><button id="refresh">Обнови пазарите</button><button class="secondary" id="clear">Изчисти</button></div><small>Токенът остава само в това поле. Не въвеждай Capital.com API ключ.</small>
<div class="bar" style="margin-top:12px"><label><input type="checkbox" id="auto"> Котировки през 30 секунди</label><button class="secondary" id="diagnostics">Диагностика</button><button class="secondary" id="accounts">Акаунти</button></div><p id="message" role="status">Въведи токена и обнови пазарите.</p></section>
<section class="panel"><h2>Пазарен преглед</h2><small id="updated">Все още няма заредени данни.</small><div class="grid" id="markets"></div><small>Спредът е в ценови единици; само EUR/USD показва и пипсове. FRESH ≤ 60 секунди.</small></section>
<section class="panel"><h2>Исторически свещи</h2><div class="bar"><select id="epic" aria-label="Инструмент"><option value="EURUSD">EUR / USD</option><option value="GOLD">Злато</option><option value="SILVER">Сребро</option><option value="OIL_CRUDE">Crude Oil</option><option value="OIL_BRENT">Brent Oil</option></select><select id="resolution" aria-label="Интервал"><option value="MINUTE">1 минута</option><option value="MINUTE_5">5 минути</option></select><button id="history">Зареди 120 свещи</button></div>
<p class="muted" id="historyInfo">Избери инструмент. Историята се зарежда ръчно.</p><canvas id="chart" aria-label="Графика на BID свещите" role="img"></canvas><small>BID цени · зелено: покачване · червено: спад · жълто: незавършена свещ. Разстоянията са по ред на свещите, не по изминало време.</small>
<div class="scroll"><table><thead><tr><th>UTC</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Статус</th></tr></thead><tbody id="rows"></tbody></table></div></section>
<section class="panel"><h2>Signal Engine</h2><div class="bar"><button id="signal">Анализирай избрания пазар</button><small>Използва само затворени BID свещи. Няма изпълнение на сделки.</small></div><p class="muted" id="signalInfo">Няма изчислен сигнал.</p><div class="grid"><div class="card"><h3>Посока</h3><div class="price" id="signalDirection">—</div><small id="signalStrength">—</small></div><div class="card"><h3>Signal Score</h3><div class="price" id="signalScore">—</div><small>LONG ≥ +60 · SHORT ≤ −60</small></div><div class="card"><h3>EMA 9 / 21</h3><div class="price" id="signalEma">—</div><small>Trend component: <span id="signalTrend">—</span></small></div><div class="card"><h3>RSI 14</h3><div class="price" id="signalRsi">—</div><small>RSI component: <span id="signalRsiComponent">—</span></small></div><div class="card"><h3>ATR 14</h3><div class="price" id="signalAtr">—</div><small>Volatility scale</small></div><div class="card"><h3>Momentum / Structure</h3><div class="price" id="signalMomentum">—</div><small>Structure: <span id="signalStructure">—</span></small></div></div></section>
<section class="panel"><h2>News / Macro Engine</h2><div class="bar"><button id="news">Зареди новини за избрания пазар</button><small>Официални RSS източници · Fed · ECB · CFTC · READ ONLY</small></div><p class="muted" id="newsInfo">Няма зареден news/macro контекст.</p><div class="grid"><div class="card"><h3>News Bias</h3><div class="price" id="newsBias">—</div><small>Signed score: <span id="newsScore">—</span></small></div><div class="card"><h3>Източници</h3><div class="price" id="newsSources">—</div><small>работещи / конфигурирани</small></div><div class="card"><h3>Активни новини</h3><div class="price" id="newsActive">—</div><small>релевантни за избрания актив</small></div></div><div class="scroll"><table><thead><tr><th>Източник</th><th>Новина</th><th>Възраст</th><th>Relevance</th><th>Impact</th><th>Посока</th><th>Score</th></tr></thead><tbody id="newsRows"></tbody></table></div></section>
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
async function analyzeSignal(){await action(async()=>{const epic=$('epic').value,res=$('resolution').value;$('signalInfo').textContent=epic+' · '+res+' · изчисляване от затворени свещи…';const d=await api('/api/signal?epic='+encodeURIComponent(epic)+'&resolution='+encodeURIComponent(res));const x=d.signal||{};if(!x.ready){$('signalDirection').textContent='NOT READY';$('signalDirection').className='price warn';$('signalScore').textContent='—';$('signalInfo').textContent=(x.reason||'SIGNAL_NOT_READY')+' · затворени: '+(d.closed_count??'—');message('Signal Engine няма достатъчно валидни данни.',true);return;}$('signalDirection').textContent=x.direction;$('signalDirection').className='price '+(x.direction==='NEUTRAL'?'warn':'good');$('signalStrength').textContent=x.strength||'—';$('signalScore').textContent=(x.signal_score>0?'+':'')+x.signal_score;$('signalEma').textContent=fmt(x.indicators?.ema9)+' / '+fmt(x.indicators?.ema21);$('signalTrend').textContent=fmt(x.components?.trend);$('signalRsi').textContent=fmt(x.indicators?.rsi14);$('signalRsiComponent').textContent=fmt(x.components?.rsi);$('signalAtr').textContent=fmt(x.indicators?.atr14);$('signalMomentum').textContent=fmt(x.components?.momentum_5);$('signalStructure').textContent=fmt(x.components?.structure);$('signalInfo').textContent=epic+' · '+res+' · candle '+(x.candle_time||'—')+' · closed candles: '+d.closed_count+(d.history_stale?' · ОСТАРЯЛА ИСТОРИЯ':'');message('Signal Engine е изчислен. Няма изпратена сделка.');});}

async function loadNews(){await action(async()=>{const epic=$('epic').value;$('newsInfo').textContent=epic+' · зареждане на официални източници…';const d=await api('/api/news?epic='+encodeURIComponent(epic));const n=d.news||{},h=d.source_health||{};$('newsBias').textContent=n.bias||'NEUTRAL';$('newsBias').className='price '+(n.bias==='NEUTRAL'?'warn':'good');$('newsScore').textContent=(n.signed_score>0?'+':'')+(n.signed_score??0);$('newsSources').textContent=(h.working??0)+' / '+(h.configured??0);$('newsActive').textContent=n.active_items??0;$('newsRows').replaceChildren();for(const x of n.top_items||[]){const tr=document.createElement('tr');for(const v of [x.source,x.title,x.category??'OTHER',(x.age_minutes??'—')+'m',x.relevance,x.impact,x.direction,(x.signed_score>0?'+':'')+x.signed_score])tr.append(element('td',String(v)));$('newsRows').append(tr);}$('newsInfo').textContent=epic+' · '+(n.items_considered??0)+' новини проверени · '+(n.active_items??0)+' активни · '+d.fetched_at;message(d.success?'News/Macro Engine е обновен.':'Няма работещ официален news feed.',!d.success);});}
$('refresh').onclick=refresh;$('history').onclick=history;$('signal').onclick=analyzeSignal;$('news').onclick=loadNews;
$('diagnostics').onclick=()=>action(async()=>{const d=await api('/api/diagnostics');message(d.success?'Връзката работи.':'Виж диагностиката за грешката.',!d.success);$('result').parentElement.open=true;});
$('accounts').onclick=()=>action(async()=>{await api('/api/check');message('Демо акаунтите са прочетени.');$('result').parentElement.open=true;});
$('clear').onclick=()=>{$('auto').checked=false;$('token').value='';$('markets').replaceChildren();$('rows').replaceChildren();chartRows=[];draw();lastQuoteAt=0;$('result').textContent='Няма данни.';$('updated').textContent='Няма заредени данни.';$('historyInfo').textContent='Избери инструмент.';message('Токенът и данните са изчистени.');};
for(const id of ['epic','resolution'])$(id).onchange=()=>{chartRows=[];draw();$('rows').replaceChildren();$('historyInfo').textContent='Натисни „Зареди 120 свещи“ за новия избор.';$('signalInfo').textContent='Няма изчислен сигнал за новия избор.';$('signalDirection').textContent='—';$('signalDirection').className='price';$('signalScore').textContent='—';$('signalEma').textContent='—';$('signalTrend').textContent='—';$('signalRsi').textContent='—';$('signalRsiComponent').textContent='—';$('signalAtr').textContent='—';$('signalMomentum').textContent='—';$('signalStructure').textContent='—';$('newsInfo').textContent='Няма зареден news/macro контекст за новия избор.';$('newsBias').textContent='—';$('newsScore').textContent='—';$('newsSources').textContent='—';$('newsActive').textContent='—';$('newsRows').replaceChildren();};
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
    if (!['/api/check', '/api/markets', '/api/diagnostics', '/api/dashboard', '/api/candles', '/api/signal', '/api/news'].includes(url.pathname)) return json({success: false, error: 'NOT_FOUND'}, 404);
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return json({success: false, error: 'ADMIN_TOKEN_MISSING_OR_TOO_SHORT'}, 503);
    if (req.headers.get('Authorization') !== 'Bearer ' + env.ADMIN_TOKEN) return json({success: false, error: 'UNAUTHORIZED'}, 401);
    try {
      if (url.pathname === '/api/diagnostics') return json(await diagnose(env));
      const missing = missingSecrets(env);
      if (missing.length) return json({success: false, ...INFO, error: 'MISSING_SECRETS', missing}, 503);
      if (url.pathname === '/api/dashboard') return json(await dashboard(env));
      if (url.pathname === '/api/candles') return json(await candles(env, url.searchParams.get('epic') ?? '', url.searchParams.get('resolution') ?? 'MINUTE'));
      if (url.pathname === '/api/signal') return json(await signal(env, url.searchParams.get('epic') ?? 'EURUSD', url.searchParams.get('resolution') ?? 'MINUTE_5'));
      if (url.pathname === '/api/news') return json(await newsEngine(url.searchParams.get('epic') ?? 'EURUSD'));
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
