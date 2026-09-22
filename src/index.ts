// Market Pulse V1.6.3 — Capital.com DEMO Order Test Session Fix + Paper Analytics. READ ONLY. No trading endpoints.
interface Env {
  CAPITAL_API_KEY: string;
  CAPITAL_IDENTIFIER: string;
  CAPITAL_API_PASSWORD: string;
  ADMIN_TOKEN: string;
  DB: D1Database;
}
type Obj = Record<string, any>;
const BASE = 'https://demo-api-capital.backend-capital.com/api/v1';
const VERSION = '1.6.3';
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
const RESOLUTIONS: Record<string, number> = {MINUTE: 60000, MINUTE_5: 300000, MINUTE_30: 1800000};
function utcMs(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(value)) return null;
  const timestamp = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value + 'Z');
  return Number.isFinite(timestamp) ? timestamp : null;
}
// Use the search route already verified against this demo account.
// Four read requests, at most two concurrently; Oil supplies both exact oil epics.


async function capitalTradeRequest(env:Env,path:string,method:'POST'|'DELETE',body?:Obj){
  const current=await session(env);
  const started=Date.now();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  try{
    const response=await fetch(BASE+path,{
      method,
      headers:{
        'Accept':'application/json',
        'Content-Type':'application/json',
        'X-CAP-API-KEY':env.CAPITAL_API_KEY,
        'CST':current.cst,
        'X-SECURITY-TOKEN':current.token
      },
      ...(body?{body:JSON.stringify(body)}:{}),
      signal:controller.signal
    });
    const ct=(response.headers.get('content-type')??'').toLowerCase();
    const data=ct.includes('json')?await response.json().catch(()=>({})): {};
    if(!response.ok)throw new Fault('CAPITAL_TRADE_HTTP_'+response.status,502,response.status,{
      endpoint:path,method,http_status:response.status,elapsed_ms:Date.now()-started,
      error_code:(data as Obj)?.errorCode??null
    });
    return data as Obj;
  }catch(error){
    if(error instanceof Fault)throw error;
    throw new Fault('CAPITAL_TRADE_REQUEST_FAILED',502,undefined,{endpoint:path,method,elapsed_ms:Date.now()-started});
  }finally{clearTimeout(timer);}
}

async function demoOrderTest(env:Env){
  // Manual DEMO test only. No guard and no CRON path.
  if(!BASE.includes('demo-api-capital.backend-capital.com'))throw new Fault('DEMO_BASE_URL_REQUIRED',409);

  const epic='GOLD', direction='BUY';
  const market=await get(env,'/markets/'+encodeURIComponent(epic));
  const rule=market.dealingRules?.minDealSize;
  const minSize=number(rule?.value);
  const status=market.snapshot?.marketStatus??null;
  if(status!=='TRADEABLE')throw new Fault('DEMO_TEST_MARKET_NOT_TRADEABLE',409,undefined,{epic,market_status:status});
  if(minSize===null||minSize<=0)throw new Fault('DEMO_TEST_MIN_SIZE_UNAVAILABLE',409,undefined,{epic,min_deal_size:rule??null});
  if(minSize!==0.01)throw new Fault('DEMO_TEST_MIN_SIZE_CHANGED',409,undefined,{epic,expected:0.01,observed:minSize,unit:rule?.unit??null});

  const placed=await capitalTradeRequest(env,'/positions','POST',{
    epic,direction,size:minSize,guaranteedStop:false
  });
  const dealReference=typeof placed.dealReference==='string'?placed.dealReference:null;
  if(!dealReference)throw new Fault('DEMO_ORDER_NO_DEAL_REFERENCE',502,undefined,{epic,direction,size:minSize,response_keys:Object.keys(placed)});

  let confirmation:Obj|null=null;
  let confirmError:string|null=null;
  for(let i=0;i<4;i++){
    if(i)await new Promise(r=>setTimeout(r,500));
    try{confirmation=await get(env,'/confirms/'+encodeURIComponent(dealReference));confirmError=null;break;}
    catch(e){confirmError=e instanceof Fault?e.code:'CONFIRM_FAILED';}
  }

  const affected=Array.isArray(confirmation?.affectedDeals)?confirmation!.affectedDeals:[];
  const opened=affected.find((x:Obj)=>x?.status==='OPENED')??affected[0]??null;
  const dealId=confirmation?.dealId??opened?.dealId??null;

  let position:Obj|null=null;
  try{
    const all=await get(env,'/positions');
    if(Array.isArray(all.positions)){
      position=all.positions.find((x:Obj)=>
        String(x?.position?.dealId??'')===String(dealId??'') ||
        (String(x?.market?.epic??'')===epic &&
         String(x?.position?.dealReference??'')===dealReference)
      )??null;
    }
  }catch{}

  return {
    success:true,...INFO,module:'DEMO_ORDER_TEST',
    demo_only:true,manual_only:true,cron_can_execute:false,paper_engine_unchanged:true,
    order_sent:true,
    order_request:{epic,direction,size:minSize,guaranteedStop:false},
    order_response:{deal_reference:dealReference},
    confirmation:confirmation?{
      deal_status:confirmation.dealStatus??null,status:confirmation.status??null,
      reason:confirmation.reason??null,epic:confirmation.epic??null,
      direction:confirmation.direction??null,size:number(confirmation.size),
      level:number(confirmation.level),deal_id:dealId,
      affected_deals:affected.map((x:Obj)=>({deal_id:x?.dealId??null,status:x?.status??null}))
    }:{available:false,error:confirmError},
    open_position_verified:position!==null,
    position:position?{
      deal_id:position.position?.dealId??null,
      deal_reference:position.position?.dealReference??null,
      epic:position.market?.epic??epic,
      direction:position.position?.direction??null,
      size:number(position.position?.size),
      level:number(position.position?.level),
      upl:number(position.position?.upl),
      market_status:position.market?.marketStatus??null
    }:null,
    close_sent:false,
    next_step:'Inspect confirmation and open position. Closing remains a separate manual test.',
    trading:'DEMO_TEST'
  };
}

async function demoTradingDiagnostic(env: Env) {
  // READ ONLY: GET requests only. Never POST /positions or PUT account settings here.
  const accountsData=await get(env,'/accounts');
  const prefs=await get(env,'/accounts/preferences');
  const sess=await get(env,'/session');
  if(!Array.isArray(accountsData.accounts))throw new Fault('CAPITAL_INVALID_ACCOUNTS_RESPONSE');
  const preferred=accountsData.accounts.find((a:Obj)=>a?.preferred===true)??accountsData.accounts[0]??null;
  const markets:Obj[]=[];
  for(const item of WATCHLIST){
    try{
      const m=await get(env,'/markets/'+encodeURIComponent(item.epic));
      const i=m.instrument??{}, d=m.dealingRules??{}, q=m.snapshot??{};
      markets.push({
        epic:item.epic,label:item.label,success:true,
        instrument:{
          name:i.name??null,type:i.type??null,currency:i.currency??null,lot_size:number(i.lotSize),
          margin_factor:number(i.marginFactor),margin_factor_unit:i.marginFactorUnit??null,
          guaranteed_stop_allowed:i.guaranteedStopAllowed===true,streaming_prices_available:i.streamingPricesAvailable===true
        },
        dealing_rules:{
          min_deal_size:d.minDealSize??null,max_deal_size:d.maxDealSize??null,min_size_increment:d.minSizeIncrement??null,
          min_stop_or_profit_distance:d.minStopOrProfitDistance??null,max_stop_or_profit_distance:d.maxStopOrProfitDistance??null,
          market_order_preference:d.marketOrderPreference??null,trailing_stops_preference:d.trailingStopsPreference??null
        },
        market:{
          status:q.marketStatus??null,bid:number(q.bid),offer:number(q.offer),
          spread:number(q.bid)!==null&&number(q.offer)!==null?Number((Number(q.offer)-Number(q.bid)).toPrecision(10)):null,
          market_modes:Array.isArray(q.marketModes)?q.marketModes:[]
        }
      });
    }catch(error){
      markets.push({epic:item.epic,label:item.label,success:false,...failure(error)});
    }
  }
  return{
    success:true,...INFO,module:'DEMO_TRADING_DIAGNOSTIC',safe_read_only:true,
    order_endpoints_called:false,account_settings_modified:false,
    session:{
      account_id:sess.accountId??null,client_id:sess.clientId??null,
      timezone_offset:sess.timezoneOffset??null,locale:sess.locale??null,
      currency:sess.currency??preferred?.currency??null
    },
    active_account:preferred?{
      account_id:preferred.accountId??null,account_name:preferred.accountName??null,
      status:preferred.status??null,type:preferred.accountType??null,preferred:preferred.preferred===true,
      currency:preferred.currency??null,balance:number(preferred.balance?.balance),
      available:number(preferred.balance?.available),profit_loss:number(preferred.balance?.profitLoss)
    }:null,
    account_preferences:{
      hedging_mode:prefs.hedgingMode===true,
      leverages:prefs.leverages??null
    },
    readiness:{
      demo_base_url:BASE.includes('demo-api-capital.backend-capital.com'),
      account_enabled:preferred?.status==='ENABLED',
      session_account_matches_preferred:preferred?String(sess.accountId??'')===String(preferred.accountId??''):null,
      watchlist_markets_returned:markets.filter(x=>x.success===true).length,
      watchlist_tradeable_now:markets.filter(x=>x.success===true&&x.market?.status==='TRADEABLE').length,
      note:'Diagnostic only. No position is opened and no account preference is changed.'
    },
    markets,
    next_step:'Review min deal sizes, increments, account mode and market status before implementing any one-shot DEMO order test.',
    trading:'DISABLED',execution:'NONE'
  };
}

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
async function newsFeed(source:(typeof NEWS_FEEDS)[number]){try{const r=await fetch(source.url,{headers:{'user-agent':'market-pulse-readonly/1.4.0','accept':'application/rss+xml, application/xml, text/xml, */*'}});const t=await r.text();return{source:source.id,ok:r.ok,status:r.status,items:r.ok?parseNews(t,source):[] as NewsItem[]};}catch{return{source:source.id,ok:false,status:0,items:[] as NewsItem[]};}}
function has(t:string,words:string[]){const x=t.toLowerCase();return words.some(w=>x.includes(w));}
type NewsCategory='MONETARY_POLICY'|'INFLATION'|'LABOR'|'RATES'|'FX'|'ENERGY_OPEC'|'ROUTINE_DATA'|'ENFORCEMENT'|'REGULATION'|'OTHER';
function newsCategory(t:string,source:string):NewsCategory{const x=t.toLowerCase();if(has(x,['enforcement action','enforcement actions','termination of enforcement','fraud','whistleblower','court order','charges ']))return'ENFORCEMENT';if(has(x,['euro foreign exchange reference rates','euro-short-term-rate','€str','ester','publication message','compounded_']))return'ROUTINE_DATA';if(has(x,['fomc statement','monetary policy','target range','policy rate','rate hike','rate cut','interest rate decision','economic projections','central bank rate']))return'MONETARY_POLICY';if(has(x,['cpi','consumer price','pce','inflation','price pressures','core inflation']))return'INFLATION';if(has(x,['nonfarm payroll','non-farm payroll','payrolls','unemployment','employment','labor market','labour market','jobless claims']))return'LABOR';if(has(x,['treasury yield','bond yield','interest rates','yield curve','rate expectations']))return'RATES';if(has(x,['foreign exchange','exchange rate','currency','dollar','usd','euro','eur']))return'FX';if(has(x,['opec','oil','crude','brent','petroleum','energy','production cut','output cut','inventory','inventories','supply disruption']))return'ENERGY_OPEC';if(source==='CFTC_GENERAL')return'REGULATION';return'OTHER';}
function categoryBaseImpact(c:NewsCategory){return c==='MONETARY_POLICY'?95:c==='INFLATION'?90:c==='LABOR'?88:c==='ENERGY_OPEC'?88:c==='RATES'?78:c==='FX'?65:c==='REGULATION'?25:c==='ROUTINE_DATA'?8:c==='ENFORCEMENT'?5:15;}
function newsRelevance(epic:string,t:string,source:string,category:NewsCategory){if(category==='ENFORCEMENT')return 2;if(category==='ROUTINE_DATA')return epic==='EURUSD'?12:2;if(category==='REGULATION')return (epic==='OIL_CRUDE'||epic==='OIL_BRENT')&&has(t,['energy','oil','crude','petroleum'])?45:8;let r=0;if(epic==='EURUSD'){if(['MONETARY_POLICY','INFLATION','LABOR','RATES'].includes(category))r=90;else if(category==='FX')r=85;else r=10;if(source==='FED_MONETARY')r=Math.max(r,90);}else if(epic==='GOLD'||epic==='SILVER'){if(['MONETARY_POLICY','INFLATION','RATES'].includes(category))r=85;else if(category==='LABOR')r=70;else if(category==='FX')r=65;else r=8;}else if(epic==='OIL_CRUDE'||epic==='OIL_BRENT'){if(category==='ENERGY_OPEC')r=95;else if(['MONETARY_POLICY','INFLATION','LABOR'].includes(category))r=35;else r=5;}return Math.min(100,r);}
function newsDirection(epic:string,t:string,category:NewsCategory){if(['ROUTINE_DATA','ENFORCEMENT','REGULATION','OTHER'].includes(category))return 0;let usd=0,oil=0;const hawkish=['rate hike','raises rates','raised rates','higher rates','restrictive','inflation remains elevated','inflation elevated','tightening','upside risks to inflation'];const dovish=['rate cut','cuts rates','cut rates','lower rates','easing','reduce the target range','lower the target range','downside risks to employment'];const usdStrong=['stronger dollar','dollar strengthens','usd strengthens'];const usdWeak=['weaker dollar','dollar weakens','usd weakens'];if(has(t,hawkish))usd+=1;if(has(t,dovish))usd-=1;if(has(t,usdStrong))usd+=1;if(has(t,usdWeak))usd-=1;if(has(t,['production cut','output cut','supply disruption','supply shortage','lower production','decline in inventories']))oil+=1;if(has(t,['production increase','increase production','higher production','inventory build','rise in inventories','supply increase']))oil-=1;if(epic==='EURUSD')return usd===0?0:(usd>0?-1:1);if(epic==='GOLD'||epic==='SILVER')return usd===0?0:(usd>0?-1:1);if(epic==='OIL_CRUDE'||epic==='OIL_BRENT')return oil===0?0:(oil>0?1:-1);return 0;}
function newsDecay(age:number|null,category:NewsCategory){if(age===null)return 0;const maxAge=category==='MONETARY_POLICY'?10080:category==='INFLATION'||category==='LABOR'?4320:category==='ENERGY_OPEC'?2880:category==='RATES'||category==='FX'?1440:360;if(age>maxAge)return 0;const halfLife=category==='MONETARY_POLICY'?2160:category==='INFLATION'||category==='LABOR'?1080:category==='ENERGY_OPEC'?720:category==='RATES'||category==='FX'?360:120;return Math.exp(-Math.LN2*age/halfLife);}
function newsForEpic(epic:string,items:NewsItem[]){const classified=items.map(item=>{const category=newsCategory(item.text,item.source_id);const relevance=newsRelevance(epic,item.text,item.source_id,category);const direction=newsDirection(epic,item.text,category);const decay=newsDecay(item.age_minutes,category);const impact=categoryBaseImpact(category);const signed=direction*relevance/100*impact/100*decay*100;const active=relevance>=35&&impact>=35&&decay>=0.05;return{source:item.source_name,title:item.title,url:item.url,published_at:item.published_at,age_minutes:item.age_minutes===null?null:Math.round(item.age_minutes),category,relevance:Math.round(relevance),impact,decay:Math.round(decay*1000)/1000,direction:direction>0?'BULLISH':direction<0?'BEARISH':'NEUTRAL',signed_score:Math.round(signed*100)/100,active};}).sort((a,b)=>Number(b.active)-Number(a.active)||Math.abs(b.signed_score)-Math.abs(a.signed_score)||b.impact-a.impact);const active=classified.filter(x=>x.active);const directional=active.filter(x=>x.direction!=='NEUTRAL');const denom=directional.reduce((s,x)=>s+x.relevance*x.impact*x.decay,0);const score=denom?directional.reduce((s,x)=>s+x.signed_score*x.relevance*x.impact*x.decay,0)/denom:0;const categories:Record<string,number>={};for(const x of classified)categories[x.category]=(categories[x.category]||0)+1;return{epic,items_considered:classified.length,active_items:active.length,directional_active_items:directional.length,signed_score:Math.round(score*100)/100,bias:score>=5?'BULLISH':score<=-5?'BEARISH':'NEUTRAL',category_counts:categories,top_items:classified.slice(0,10)};}
async function newsEngine(epic:string){if(!WATCHLIST.some(x=>x.epic===epic))throw new Fault('EPIC_NOT_ALLOWED',400);const results=await Promise.all(NEWS_FEEDS.map(newsFeed));const seen=new Set<string>(),items:NewsItem[]=[];for(const x of results)for(const item of x.items){const k=item.url||item.id;if(!seen.has(k)){seen.add(k);items.push(item);}}return{success:results.some(x=>x.ok),...INFO,module:'NEWS_MACRO_ENGINE',epic,fetched_at:new Date().toISOString(),source_health:{configured:results.length,working:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).length,sources:results.map(x=>({source:x.source,ok:x.ok,status:x.status,items:x.items.length}))},news:newsForEpic(epic,items),trading:'DISABLED',execution:'NONE',classifier_version:'1.3.1',note:'Official-source RSS research classifier with category-specific relevance, impact and time decay. Routine/enforcement items are suppressed. Direction is context, not a prediction or trade instruction.'};}


// ============================================================
// V1.4.0 D1 SNAPSHOT HISTORY — 1m / 5m / 30m
// One synchronized research snapshot per epic per UTC minute.
// No trading or order endpoints.
// ============================================================
const SNAPSHOT_RESOLUTIONS = ['MINUTE','MINUTE_5','MINUTE_30'] as const;
async function ensureSnapshotSchema(env: Env) {
  if (!env.DB) throw new Fault('D1_BINDING_MISSING', 503);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_key TEXT NOT NULL UNIQUE,
    captured_at TEXT NOT NULL,
    captured_minute TEXT NOT NULL,
    epic TEXT NOT NULL,
    price REAL,
    signal_1m REAL, direction_1m TEXT, candle_1m TEXT,
    signal_5m REAL, direction_5m TEXT, candle_5m TEXT,
    signal_30m REAL, direction_30m TEXT, candle_30m TEXT,
    ema9_1m REAL, ema21_1m REAL, rsi14_1m REAL, atr14_1m REAL,
    ema9_5m REAL, ema21_5m REAL, rsi14_5m REAL, atr14_5m REAL,
    ema9_30m REAL, ema21_30m REAL, rsi14_30m REAL, atr14_30m REAL,
    news_score REAL, news_bias TEXT,
    combined_score REAL, combined_direction TEXT,
    payload_json TEXT NOT NULL
  )`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_market_snapshots_epic_time ON market_snapshots(epic, captured_at DESC)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_market_snapshots_time ON market_snapshots(captured_at DESC)').run();
}
function minuteBucket(ms=Date.now()) { return new Date(Math.floor(ms/60000)*60000).toISOString(); }
function compactSignal(x: Obj) {
  return {ready:x?.ready===true, candle_time:x?.candle_time??null, close:number(x?.close), signal_score:number(x?.signal_score), direction:x?.direction??'NOT_READY', strength:x?.strength??null, indicators:x?.indicators??null, components:x?.components??null};
}
function combinedSnapshotScore(s1: Obj, s5: Obj, s30: Obj, news: Obj) {
  const readiness = {
    signal_1m: s1?.ready === true && number(s1?.signal_score) !== null,
    signal_5m: s5?.ready === true && number(s5?.signal_score) !== null,
    signal_30m: s30?.ready === true && number(s30?.signal_score) !== null
  };
  if (!readiness.signal_1m || !readiness.signal_5m || !readiness.signal_30m) {
    return {
      ready: false,
      score: null,
      direction: 'NOT_READY',
      readiness,
      weights: {signal_1m:0.20,signal_5m:0.40,signal_30m:0.30,news:0.10},
      reason: 'ONE_OR_MORE_TIMEFRAMES_NOT_READY'
    };
  }
  const a=number(s1.signal_score)!, b=number(s5.signal_score)!, c=number(s30.signal_score)!;
  const n=number(news?.signed_score)??0;
  // 5m is the main timeframe; 30m context; 1m timing; news remains context-only at 10%.
  const score=Math.max(-100,Math.min(100,a*0.20+b*0.40+c*0.30+n*0.10));
  return {
    ready:true,
    score:Math.round(score*100)/100,
    direction:score>=60?'LONG':score<=-60?'SHORT':'NEUTRAL',
    readiness,
    weights:{signal_1m:0.20,signal_5m:0.40,signal_30m:0.30,news:0.10}
  };
}
async function buildSnapshot(env: Env, epic: string, sharedNewsItems?: NewsItem[]) {
  const histories: Obj[]=[];
  // Sequential requests are intentional: gentler on the broker API than a 15-request burst.
  for (const resolution of SNAPSHOT_RESOLUTIONS) histories.push(await candles(env,epic,resolution));
  const sigs=histories.map(h=>signalFromClosed((h.candles as Obj[]).filter(x=>x.complete===true)));
  let news: Obj;
  if (sharedNewsItems) news=newsForEpic(epic,sharedNewsItems);
  else news=(await newsEngine(epic)).news;
  const c=combinedSnapshotScore(sigs[0],sigs[1],sigs[2],news);
  const price=number(sigs[0]?.close)??number(sigs[1]?.close)??number(sigs[2]?.close);
  return {epic,price,signal_1m:compactSignal(sigs[0]),signal_5m:compactSignal(sigs[1]),signal_30m:compactSignal(sigs[2]),news:{signed_score:news.signed_score,bias:news.bias,active_items:news.active_items,directional_active_items:news.directional_active_items},combined:c,history_stale:{minute:histories[0].history_stale,minute_5:histories[1].history_stale,minute_30:histories[2].history_stale}};
}
async function fetchSharedNewsItems(){const results=await Promise.all(NEWS_FEEDS.map(newsFeed));const seen=new Set<string>(),items:NewsItem[]=[];for(const x of results)for(const item of x.items){const k=item.url||item.id;if(!seen.has(k)){seen.add(k);items.push(item);}}return{results,items};}
async function saveSnapshot(env: Env, snapshot: Obj, capturedAt: string) {
  const minute=minuteBucket(Date.parse(capturedAt));
  const key=snapshot.epic+'|'+minute;
  const s1=snapshot.signal_1m??{},s5=snapshot.signal_5m??{},s30=snapshot.signal_30m??{};
  const i1=s1.indicators??{},i5=s5.indicators??{},i30=s30.indicators??{};
  const r=await env.DB.prepare(`INSERT OR IGNORE INTO market_snapshots (
    snapshot_key,captured_at,captured_minute,epic,price,
    signal_1m,direction_1m,candle_1m,signal_5m,direction_5m,candle_5m,signal_30m,direction_30m,candle_30m,
    ema9_1m,ema21_1m,rsi14_1m,atr14_1m,ema9_5m,ema21_5m,rsi14_5m,atr14_5m,ema9_30m,ema21_30m,rsi14_30m,atr14_30m,
    news_score,news_bias,combined_score,combined_direction,payload_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    key,capturedAt,minute,snapshot.epic,snapshot.price,
    s1.signal_score,s1.direction,s1.candle_time,s5.signal_score,s5.direction,s5.candle_time,s30.signal_score,s30.direction,s30.candle_time,
    i1.ema9,i1.ema21,i1.rsi14,i1.atr14,i5.ema9,i5.ema21,i5.rsi14,i5.atr14,i30.ema9,i30.ema21,i30.rsi14,i30.atr14,
    snapshot.news?.signed_score,snapshot.news?.bias,snapshot.combined?.score,snapshot.combined?.direction,JSON.stringify(snapshot)
  ).run();
  return {snapshot_key:key,inserted:(r.meta?.changes??0)>0};
}
async function snapshotRun(env: Env) {
  await ensureSnapshotSchema(env);
  const capturedAt=new Date().toISOString();
  const shared=await fetchSharedNewsItems();
  const rows:Obj[]=[];
  for(const item of WATCHLIST){
    try{const snap=await buildSnapshot(env,item.epic,shared.items);const saved=await saveSnapshot(env,snap,capturedAt);rows.push({success:true,...saved,...snap});}
    catch(error){rows.push({success:false,epic:item.epic,...failure(error)});}
  }
  return {success:rows.some(x=>x.success),...INFO,module:'D1_SNAPSHOT_HISTORY',captured_at:capturedAt,timeframes:['1m','5m','30m'],source_health:{news_working:shared.results.filter(x=>x.ok).length,news_configured:shared.results.length},inserted:rows.filter(x=>x.inserted).length,duplicates:rows.filter(x=>x.success&&!x.inserted).length,failed:rows.filter(x=>!x.success).length,snapshots:rows,trading:'DISABLED',execution:'NONE',note:'Research snapshots only. One row per epic per UTC minute; duplicate CRON retries are ignored.'};
}
async function snapshotHistory(env: Env, epic: string, limitRaw: string|null) {
  await ensureSnapshotSchema(env);
  if(!WATCHLIST.some(x=>x.epic===epic))throw new Fault('EPIC_NOT_ALLOWED',400);
  const limit=Math.max(1,Math.min(500,Number(limitRaw)||60));
  const r=await env.DB.prepare(`SELECT captured_at,epic,price,signal_1m,direction_1m,signal_5m,direction_5m,signal_30m,direction_30m,news_score,news_bias,combined_score,combined_direction FROM market_snapshots WHERE epic=? ORDER BY captured_at DESC LIMIT ?`).bind(epic,limit).all();
  return {success:true,...INFO,module:'D1_SNAPSHOT_HISTORY',epic,count:r.results?.length??0,rows:r.results??[],trading:'DISABLED'};
}

function round2(v: number|null){return v===null?null:Math.round(v*100)/100;}
function avgNums(values: number[]){return values.length?values.reduce((a,b)=>a+b,0)/values.length:null;}
function persistenceWindow(rows: Obj[], minutes: number) {
  if(!rows.length)return{minutes,samples:0,avg_score:null,min_score:null,max_score:null,delta:null,long_share:null,short_share:null,neutral_share:null};
  const newest=Date.parse(String(rows[0].captured_at));
  const selected=rows.filter(r=>{
    const t=Date.parse(String(r.captured_at));
    return Number.isFinite(t)&&newest-t<=minutes*60000;
  });
  const scores=selected.map(r=>number(r.combined_score)).filter((x):x is number=>x!==null);
  if(!scores.length)return{minutes,samples:selected.length,avg_score:null,min_score:null,max_score:null,delta:null,long_share:null,short_share:null,neutral_share:null};
  const dirs=selected.map(r=>String(r.combined_direction??'NEUTRAL'));
  const oldest=scores[scores.length-1], latest=scores[0];
  return {
    minutes,samples:selected.length,
    avg_score:round2(avgNums(scores)),
    min_score:round2(Math.min(...scores)),
    max_score:round2(Math.max(...scores)),
    delta:round2(latest-oldest),
    long_share:round2(dirs.filter(x=>x==='LONG').length/dirs.length),
    short_share:round2(dirs.filter(x=>x==='SHORT').length/dirs.length),
    neutral_share:round2(dirs.filter(x=>x==='NEUTRAL').length/dirs.length)
  };
}
function regimeFromScore(score: number|null) {
  if(score===null)return 'NOT_READY';
  return score>=35?'BULLISH':score<=-35?'BEARISH':'NEUTRAL';
}
function regimeStreak(rows: Obj[]) {
  if(!rows.length)return{regime:'NONE',count:0};
  const first=regimeFromScore(number(rows[0].combined_score));
  let count=0;
  for(const r of rows){if(regimeFromScore(number(r.combined_score))!==first)break;count++;}
  return{regime:first,count};
}
function persistenceState(current: number|null, w5: Obj, w15: Obj, w30: Obj) {
  if(current===null)return{bias:'NOT_READY',strength:'NOT_READY',trend:'UNKNOWN',acceleration:null,score:null};
  const avgs=[w5.avg_score,w15.avg_score,w30.avg_score].filter((x):x is number=>typeof x==='number');
  const base=avgs.length?avgs.reduce((a,b)=>a+b,0)/avgs.length:current;
  const persistenceScore=Math.max(-100,Math.min(100,current*0.45+base*0.55));
  const bias=regimeFromScore(persistenceScore);
  const abs=Math.abs(persistenceScore);
  const strength=abs>=60?'STRONG':abs>=35?'MODERATE':'WEAK';
  const d5=typeof w5.delta==='number'?w5.delta:0;
  const d15=typeof w15.delta==='number'?w15.delta:0;
  const acceleration=round2(d5*0.65+d15*0.35);

  let trend='STABLE';
  if(bias==='BULLISH'){
    if(acceleration!==null&&acceleration>3)trend='BULLISH_STRENGTHENING';
    else if(acceleration!==null&&acceleration<-3)trend='BULLISH_FADING';
    else trend='BULLISH_STABLE';
  } else if(bias==='BEARISH'){
    if(acceleration!==null&&acceleration<-3)trend='BEARISH_STRENGTHENING';
    else if(acceleration!==null&&acceleration>3)trend='BEARISH_FADING';
    else trend='BEARISH_STABLE';
  } else {
    if(acceleration!==null&&acceleration>5)trend='NEUTRAL_TILTING_BULLISH';
    else if(acceleration!==null&&acceleration<-5)trend='NEUTRAL_TILTING_BEARISH';
    else trend='NEUTRAL_STABLE';
  }
  return{bias,strength,trend,acceleration,score:round2(persistenceScore)};
}
async function persistenceForEpic(env: Env, epic: string) {
  await ensureSnapshotSchema(env);
  if(!WATCHLIST.some(x=>x.epic===epic))throw new Fault('EPIC_NOT_ALLOWED',400);
  const r=await env.DB.prepare(`SELECT captured_at,combined_score,combined_direction,signal_1m,signal_5m,signal_30m,news_score
    FROM market_snapshots WHERE epic=? ORDER BY captured_at DESC LIMIT 90`).bind(epic).all();
  const rows=(r.results??[]) as Obj[];
  const current=rows.length?number(rows[0].combined_score):null;
  const w5=persistenceWindow(rows,5), w15=persistenceWindow(rows,15), w30=persistenceWindow(rows,30);
  const state=persistenceState(current,w5,w15,w30);
  return {
    success:true,...INFO,module:'PERSISTENCE_ENGINE',epic,
    current:{captured_at:rows[0]?.captured_at??null,combined_score:current,direction:rows[0]?.combined_direction??'NOT_READY'},
    windows:{m5:w5,m15:w15,m30:w30},
    regime_streak:regimeStreak(rows),
    persistence:state,
    samples_available:rows.length,
    model:'CURRENT 45% + MEAN(5m/15m/30m) 55% · REGIME ±35 · DIRECTIONAL ACCELERATION',
    note:'Research diagnostic only. Regime streak and directional acceleration do not change the live combined signal or enable trading.',
    trading:'DISABLED',execution:'NONE'
  };
}
async function persistenceAll(env: Env) {
  const assets:Obj[]=[];
  for(const x of WATCHLIST)assets.push(await persistenceForEpic(env,x.epic));
  return{success:true,...INFO,module:'PERSISTENCE_ENGINE_ALL',assets,trading:'DISABLED',execution:'NONE'};
}



const PAPER_CFG = {
  entry_score: 60,
  persistence_score: 35,
  min_regime_streak: 3,
  min_abs_acceleration: 3,
  notional: 100
} as const;
const PAPER_MATRIX = [
  {id:'A',tp_pct:0.15,sl_pct:0.10,max_hold_minutes:30},
  {id:'B',tp_pct:0.20,sl_pct:0.15,max_hold_minutes:30},
  {id:'C',tp_pct:0.25,sl_pct:0.15,max_hold_minutes:45},
  {id:'D',tp_pct:0.30,sl_pct:0.20,max_hold_minutes:45},
  {id:'E',tp_pct:0.35,sl_pct:0.25,max_hold_minutes:60},
  {id:'F',tp_pct:0.50,sl_pct:0.30,max_hold_minutes:60}
] as const;

async function ensurePaperSchema(env: Env) {
  if(!env.DB)throw new Fault('D1_BINDING_MISSING',500);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS paper_observations (
    id TEXT PRIMARY KEY, epic TEXT NOT NULL, side TEXT NOT NULL, status TEXT NOT NULL,
    entry_time TEXT NOT NULL, entry_price REAL NOT NULL, entry_combined_score REAL,
    entry_persistence_score REAL, entry_regime TEXT, entry_regime_streak INTEGER,
    entry_acceleration REAL, entry_atr_1m REAL, entry_atr_5m REAL, entry_atr_30m REAL,
    entry_atr_pct_1m REAL, entry_atr_pct_5m REAL, entry_atr_pct_30m REAL,
    volatility_regime TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();
  const paperObsCols=(await env.DB.prepare(`PRAGMA table_info(paper_observations)`).all()).results??[];
  const paperObsNames=new Set((paperObsCols as Obj[]).map((x:Obj)=>String(x.name)));
  for(const [name,type] of [
    ['entry_atr_1m','REAL'],['entry_atr_5m','REAL'],['entry_atr_30m','REAL'],
    ['entry_atr_pct_1m','REAL'],['entry_atr_pct_5m','REAL'],['entry_atr_pct_30m','REAL'],
    ['volatility_regime','TEXT']
  ] as const){
    if(!paperObsNames.has(name))await env.DB.prepare(`ALTER TABLE paper_observations ADD COLUMN ${name} ${type}`).run();
  }
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_paper_obs_epic_status ON paper_observations(epic,status)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS paper_matrix_trades (
    id TEXT PRIMARY KEY, observation_id TEXT NOT NULL, variant TEXT NOT NULL, epic TEXT NOT NULL,
    side TEXT NOT NULL, status TEXT NOT NULL, entry_time TEXT NOT NULL, entry_price REAL NOT NULL,
    tp_pct REAL NOT NULL, sl_pct REAL NOT NULL, max_hold_minutes INTEGER NOT NULL,
    exit_time TEXT, exit_price REAL, exit_reason TEXT, pnl_pct REAL, pnl_value REAL,
    max_favorable_pct REAL DEFAULT 0, max_adverse_pct REAL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_paper_matrix_obs ON paper_matrix_trades(observation_id)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_paper_matrix_status ON paper_matrix_trades(status,epic)`).run();
}
function paperMovePct(side:string, entry:number, price:number){
  if(!entry||!price)return 0;
  const raw=(price-entry)/entry*100;
  return side==='LONG'?raw:-raw;
}
async function latestSnapshotRow(env: Env, epic:string){
  return await env.DB.prepare(`SELECT captured_at,price,combined_score,combined_direction FROM market_snapshots WHERE epic=? ORDER BY captured_at DESC LIMIT 1`).bind(epic).first<Obj>();
}
function paperEntryDecision(snap:Obj,p:Obj){
  const score=number(snap.combined_score), ps=number(p.persistence?.score), acc=number(p.persistence?.acceleration);
  const bias=String(p.persistence?.bias??'NOT_READY'), streak=Number(p.regime_streak?.count??0);
  if(score===null||ps===null||acc===null)return{eligible:false,reason:'NOT_READY'};
  if(streak<PAPER_CFG.min_regime_streak)return{eligible:false,reason:'REGIME_STREAK_TOO_SHORT'};
  if(score>=PAPER_CFG.entry_score&&ps>=PAPER_CFG.persistence_score&&bias==='BULLISH'&&acc>=PAPER_CFG.min_abs_acceleration)
    return{eligible:true,side:'LONG',reason:'LONG_CONFIRMED'};
  if(score<=-PAPER_CFG.entry_score&&ps<=-PAPER_CFG.persistence_score&&bias==='BEARISH'&&acc<=-PAPER_CFG.min_abs_acceleration)
    return{eligible:true,side:'SHORT',reason:'SHORT_CONFIRMED'};
  return{eligible:false,reason:'ENTRY_FILTER_NOT_MET'};
}

async function entryVolatility(env:Env,epic:string,price:number){
  const frames=[['MINUTE','atr_1m','atr_pct_1m'],['MINUTE_5','atr_5m','atr_pct_5m'],['MINUTE_30','atr_30m','atr_pct_30m']] as const;
  const out:Obj={atr_1m:null,atr_5m:null,atr_30m:null,atr_pct_1m:null,atr_pct_5m:null,atr_pct_30m:null};
  for(const [resolution,ak,pk] of frames){
    try{
      const r=await signal(env,epic,resolution);
      const atr=number(r.signal?.indicators?.atr14);
      out[ak]=atr;
      out[pk]=atr!==null&&price>0?round2(atr/price*100):null;
    }catch{}
  }
  const basis=number(out.atr_pct_5m)??number(out.atr_pct_1m)??number(out.atr_pct_30m);
  out.volatility_regime=basis===null?'UNKNOWN':basis<0.03?'LOW':basis<0.08?'NORMAL':basis<0.15?'HIGH':'EXTREME';
  return out;
}
async function openMatrixObservation(env:Env, epic:string, side:string, snap:Obj, p:Obj){
  const now=String(snap.captured_at??new Date().toISOString()), price=number(snap.price);
  if(price===null)return null;
  const oid=`${epic}|${now}|${side}`;
  const vol=await entryVolatility(env,epic,price);
  await env.DB.prepare(`INSERT OR IGNORE INTO paper_observations
    (id,epic,side,status,entry_time,entry_price,entry_combined_score,entry_persistence_score,entry_regime,entry_regime_streak,entry_acceleration,
     entry_atr_1m,entry_atr_5m,entry_atr_30m,entry_atr_pct_1m,entry_atr_pct_5m,entry_atr_pct_30m,volatility_regime,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      oid,epic,side,'OPEN',now,price,number(snap.combined_score),number(p.persistence?.score),
      String(p.persistence?.bias??'NOT_READY'),Number(p.regime_streak?.count??0),number(p.persistence?.acceleration),
      vol.atr_1m,vol.atr_5m,vol.atr_30m,vol.atr_pct_1m,vol.atr_pct_5m,vol.atr_pct_30m,vol.volatility_regime,now,now).run();
  for(const v of PAPER_MATRIX){
    const id=`${oid}|${v.id}`;
    await env.DB.prepare(`INSERT OR IGNORE INTO paper_matrix_trades
      (id,observation_id,variant,epic,side,status,entry_time,entry_price,tp_pct,sl_pct,max_hold_minutes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,oid,v.id,epic,side,'OPEN',now,price,v.tp_pct,v.sl_pct,v.max_hold_minutes,now,now).run();
  }
  return oid;
}
async function updateMatrixTrade(env:Env,t:Obj,price:number,now:string){
  const move=paperMovePct(String(t.side),Number(t.entry_price),price);
  const fav=Math.max(number(t.max_favorable_pct)??0,move), adv=Math.min(number(t.max_adverse_pct)??0,move);
  const age=(Date.parse(now)-Date.parse(String(t.entry_time)))/60000;
  let reason:string|null=null;
  if(move>=Number(t.tp_pct))reason='TAKE_PROFIT';
  else if(move<=-Number(t.sl_pct))reason='STOP_LOSS';
  else if(age>=Number(t.max_hold_minutes))reason='MAX_HOLD';
  if(reason){
    const pnl=PAPER_CFG.notional*(move/100);
    await env.DB.prepare(`UPDATE paper_matrix_trades SET status='CLOSED',exit_time=?,exit_price=?,exit_reason=?,pnl_pct=?,pnl_value=?,max_favorable_pct=?,max_adverse_pct=?,updated_at=? WHERE id=?`)
      .bind(now,price,reason,move,pnl,fav,adv,now,String(t.id)).run();
    return true;
  }
  await env.DB.prepare(`UPDATE paper_matrix_trades SET max_favorable_pct=?,max_adverse_pct=?,updated_at=? WHERE id=?`)
    .bind(fav,adv,now,String(t.id)).run();
  return false;
}
async function paperRun(env:Env){
  await ensureSnapshotSchema(env);await ensurePaperSchema(env);
  const actions:Obj[]=[];
  for(const item of WATCHLIST){
    const epic=item.epic,snap=await latestSnapshotRow(env,epic);
    if(!snap){actions.push({epic,action:'SKIP',reason:'NO_SNAPSHOT'});continue;}
    const price=number(snap.price); if(price===null){actions.push({epic,action:'SKIP',reason:'NO_PRICE'});continue;}
    const now=String(snap.captured_at);
    const openObs=await env.DB.prepare(`SELECT * FROM paper_observations WHERE epic=? AND status='OPEN' ORDER BY entry_time DESC LIMIT 1`).bind(epic).first<Obj>();
    if(openObs){
      const trades=await env.DB.prepare(`SELECT * FROM paper_matrix_trades WHERE observation_id=? AND status='OPEN'`).bind(String(openObs.id)).all();
      let closed=0;
      for(const t of (trades.results??[]) as Obj[])if(await updateMatrixTrade(env,t,price,now))closed++;
      const left=await env.DB.prepare(`SELECT COUNT(*) c FROM paper_matrix_trades WHERE observation_id=? AND status='OPEN'`).bind(String(openObs.id)).first<Obj>();
      if(Number(left?.c??0)===0)await env.DB.prepare(`UPDATE paper_observations SET status='CLOSED',updated_at=? WHERE id=?`).bind(now,String(openObs.id)).run();
      actions.push({epic,action:'TRACK_MATRIX',observation_id:openObs.id,variants_open:Number(left?.c??0),variants_closed_now:closed});
      continue;
    }
    const p=await persistenceForEpic(env,epic), decision=paperEntryDecision(snap,p);
    if(decision.eligible){
      const oid=await openMatrixObservation(env,epic,String(decision.side),snap,p);
      actions.push({epic,action:'OPEN_MATRIX',observation_id:oid,side:decision.side,variants:PAPER_MATRIX.length,price});
    }else actions.push({epic,action:'WAIT',reason:decision.reason,combined_score:number(snap.combined_score),persistence_score:number(p.persistence?.score),regime:p.persistence?.bias,streak:p.regime_streak?.count,acceleration:p.persistence?.acceleration});
  }
  return{success:true,...INFO,module:'PAPER_MATRIX_ENGINE',config:PAPER_CFG,matrix:PAPER_MATRIX,actions,trading:'DISABLED',execution:'PAPER_ONLY',broker_orders_sent:false};
}
async function paperStatus(env:Env){
  await ensurePaperSchema(env);
  const obs=await env.DB.prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END),0) open,
    COALESCE(SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END),0) closed
    FROM paper_observations`).first<Obj>();
  const matrix=await env.DB.prepare(`SELECT variant,COUNT(*) trades,
    SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) closed,
    SUM(CASE WHEN status='CLOSED' AND pnl_pct>0 THEN 1 ELSE 0 END) wins,
    SUM(CASE WHEN status='CLOSED' AND pnl_pct<=0 THEN 1 ELSE 0 END) losses,
    ROUND(SUM(CASE WHEN status='CLOSED' THEN pnl_value ELSE 0 END),4) pnl_value,
    ROUND(AVG(CASE WHEN status='CLOSED' THEN pnl_pct END),4) expectancy_pct,
    ROUND(CASE WHEN ABS(SUM(CASE WHEN status='CLOSED' AND pnl_value<0 THEN pnl_value ELSE 0 END))>0
      THEN SUM(CASE WHEN status='CLOSED' AND pnl_value>0 THEN pnl_value ELSE 0 END)/
           ABS(SUM(CASE WHEN status='CLOSED' AND pnl_value<0 THEN pnl_value ELSE 0 END)) END,4) profit_factor,
    ROUND(AVG(CASE WHEN status='CLOSED' THEN max_favorable_pct END),4) avg_mfe_pct,
    ROUND(AVG(CASE WHEN status='CLOSED' THEN max_adverse_pct END),4) avg_mae_pct
    FROM paper_matrix_trades GROUP BY variant ORDER BY variant`).all();
  const byAsset=await env.DB.prepare(`SELECT epic,variant,COUNT(*) trades,
    SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) closed,
    SUM(CASE WHEN status='CLOSED' AND pnl_pct>0 THEN 1 ELSE 0 END) wins,
    ROUND(SUM(CASE WHEN status='CLOSED' THEN pnl_value ELSE 0 END),4) pnl_value,
    ROUND(AVG(CASE WHEN status='CLOSED' THEN pnl_pct END),4) expectancy_pct
    FROM paper_matrix_trades GROUP BY epic,variant ORDER BY epic,variant`).all();
  const byVol=await env.DB.prepare(`SELECT o.volatility_regime,t.variant,COUNT(*) trades,
    SUM(CASE WHEN t.status='CLOSED' THEN 1 ELSE 0 END) closed,
    SUM(CASE WHEN t.status='CLOSED' AND t.pnl_pct>0 THEN 1 ELSE 0 END) wins,
    ROUND(SUM(CASE WHEN t.status='CLOSED' THEN t.pnl_value ELSE 0 END),4) pnl_value,
    ROUND(AVG(CASE WHEN t.status='CLOSED' THEN t.pnl_pct END),4) expectancy_pct,
    ROUND(AVG(o.entry_atr_pct_5m),4) avg_entry_atr_pct_5m
    FROM paper_matrix_trades t JOIN paper_observations o ON o.id=t.observation_id
    GROUP BY o.volatility_regime,t.variant ORDER BY o.volatility_regime,t.variant`).all();
  const recent=await env.DB.prepare(`SELECT * FROM paper_observations ORDER BY entry_time DESC LIMIT 20`).all();
  return{success:true,...INFO,module:'PAPER_ANALYTICS_FOUNDATION',config:PAPER_CFG,matrix_definitions:PAPER_MATRIX,
    observations:obs??{},variants:matrix.results??[],by_asset:byAsset.results??[],by_volatility_regime:byVol.results??[],
    recent_observations:recent.results??[],
    analytics:{entry_atr_timeframes:['1m','5m','30m'],volatility_regimes:['LOW','NORMAL','HIGH','EXTREME','UNKNOWN'],
      note:'ATR is recorded at entry for research segmentation. It does not change entries or TP/SL variants in V1.5.2.'},
    trading:'DISABLED',execution:'PAPER_ONLY',broker_orders_sent:false};
}

async function snapshotStatus(env: Env){
  await ensureSnapshotSchema(env);
  const total=await env.DB.prepare('SELECT COUNT(*) AS total, MIN(captured_at) AS first_snapshot, MAX(captured_at) AS last_snapshot FROM market_snapshots').first<Obj>();
  const byEpic=await env.DB.prepare('SELECT epic, COUNT(*) AS count, MAX(captured_at) AS last_snapshot FROM market_snapshots GROUP BY epic ORDER BY epic').all();
  const rows=(byEpic.results??[]) as Obj[];
  const expected=WATCHLIST.map(x=>x.epic);
  const present=new Set(rows.map(x=>String(x.epic)));
  return {
    success:true,...INFO,module:'D1_SNAPSHOT_STATUS',
    total:total??{},
    expected_epics:expected.length,
    epics_with_snapshots:present.size,
    missing_epics:expected.filter(x=>!present.has(x)),
    all_watchlist_epics_present:expected.every(x=>present.has(x)),
    by_epic:rows,
    timeframes:['1m','5m','30m'],
    trading:'DISABLED'
  };
}

const PAGE = `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Market Pulse</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0b1320;color:#e5edf7}*{box-sizing:border-box}body{max-width:1180px;margin:0 auto;padding:24px}header{display:flex;justify-content:space-between;gap:12px;align-items:center}h1{margin:0;font-size:28px}h2{font-size:19px;margin:0 0 14px}.muted,small{color:#9cb0c7}.badge{color:#85e4bd;border:1px solid #285947;padding:7px 10px;border-radius:20px;font-size:12px}.panel{background:#111e30;border:1px solid #24374d;border-radius:14px;padding:18px;margin-top:18px}.bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}input,button,select{font:inherit;border:1px solid #36506b;border-radius:8px;padding:10px;background:#16273b;color:#e5edf7}input[type=password]{flex:1;min-width:180px}button{cursor:pointer;background:#79dcb4;color:#09231b;font-weight:650}button.secondary{background:#1b3048;color:#dce8f5}button:disabled{opacity:.5;cursor:wait}label{font-size:14px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:12px;margin-top:16px}.card{background:#142439;border:1px solid #2c435d;border-radius:10px;padding:16px}.card h3{margin:0 0 6px;font-size:17px}.price{font-size:22px;font-variant-numeric:tabular-nums;margin:14px 0}.good{color:#85e4bd}.warn{color:#ffcf7a}.bad{color:#ff959d}canvas{width:100%;height:300px;display:block;margin-top:14px;background:#0d1929;border-radius:8px}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px;white-space:nowrap}td,th{text-align:right;padding:9px;border-bottom:1px solid #263a52}td:first-child,th:first-child{text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:460px;overflow:auto;font-size:12px}#message{min-height:24px;margin:12px 0 0}details{margin-top:16px}summary{cursor:pointer}@media(max-width:500px){body{padding:14px}.panel{padding:12px}header{align-items:flex-start}.grid{grid-template-columns:1fr}h1{font-size:24px}}
</style></head><body>
<header><div><h1>Market Pulse</h1><small>V1.6.3 · Capital.com · DEMO ORDER TEST · SESSION FIX</small></div><span class="badge">DEMO · READ ONLY</span></header>
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

<section class="card" id="d1-controls">
  <h2>💾 D1 SNAPSHOT HISTORY</h2>
  <p class="muted">Research-only snapshots: EURUSD, GOLD, SILVER, Crude Oil and Brent · 1m / 5m / 30m.</p>
  <div class="actions">
    <button id="run-snapshot-btn" type="button">💾 RUN SNAPSHOT</button>
    <button id="snapshot-status-btn" type="button">📚 SNAPSHOT STATUS</button>
    <button id="persistence-btn" type="button">📈 PERSISTENCE</button>
    <button id="paper-run-btn" type="button">🧪 MATRIX RUN</button>
    <button id="paper-status-btn" type="button">📊 MATRIX STATUS</button>
    <button id="demo-trading-diag-btn" type="button">🔌 DEMO TRADING DIAG</button>
    <button id="demo-order-test-btn" type="button">🧪 DEMO BUY GOLD 0.01</button>
  </div>
  <pre id="snapshot-output">Няма стартирана D1 операция.</pre>
</section>
<script>

const mpGetAdminToken = () => {
  const ids = ['admin-token','adminToken','token','auth-token'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && typeof el.value === 'string' && el.value.trim()) return el.value.trim();
  }
  return (localStorage.getItem('market_pulse_admin_token') ||
          localStorage.getItem('admin_token') ||
          localStorage.getItem('ADMIN_TOKEN') || '').trim();
};
async function mpD1Call(path) {
  const out = document.getElementById('snapshot-output');
  const token = mpGetAdminToken();
  if (!token) {
    out.textContent = 'ADMIN_TOKEN липсва. Въведи token-а в полето на dashboard-а и опитай пак.';
    return;
  }
  out.textContent = 'Зареждане...';
  try {
    const r = await fetch(path, {headers:{'Authorization':'Bearer '+token,'Accept':'application/json'}});
    const body = await r.json().catch(()=>({success:false,error:'INVALID_JSON_RESPONSE',http_status:r.status}));
    out.textContent = JSON.stringify(body,null,2);
  } catch (e) {
    out.textContent = JSON.stringify({success:false,error:'DASHBOARD_REQUEST_FAILED'},null,2);
  }
}
document.getElementById('run-snapshot-btn')?.addEventListener('click',()=>mpD1Call('/api/snapshot-run'));
document.getElementById('snapshot-status-btn')?.addEventListener('click',()=>mpD1Call('/api/snapshot-status'));
document.getElementById('persistence-btn')?.addEventListener('click',()=>mpD1Call('/api/persistence'));
document.getElementById('paper-run-btn')?.addEventListener('click',()=>mpD1Call('/api/paper-run'));
document.getElementById('paper-status-btn')?.addEventListener('click',()=>mpD1Call('/api/paper-status'));
document.getElementById('demo-trading-diag-btn')?.addEventListener('click',()=>mpD1Call('/api/demo-trading-diagnostic'));
document.getElementById('demo-order-test-btn')?.addEventListener('click',async()=>{
  if(!confirm('DEMO ONLY: open a GOLD BUY position at the current minimum size 0.01? It will remain OPEN until we test closing separately.'))return;
  await mpD1Call('/api/demo-order-test');
});

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
    if (!['/api/check', '/api/markets', '/api/diagnostics', '/api/dashboard', '/api/candles', '/api/signal', '/api/news', '/api/snapshot-run', '/api/snapshots', '/api/snapshot-status', '/api/persistence', '/api/paper-run', '/api/paper-status', '/api/demo-trading-diagnostic', '/api/demo-order-test'].includes(url.pathname)) return json({success: false, error: 'NOT_FOUND'}, 404);
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
      if (url.pathname === '/api/snapshot-run') return json(await snapshotRun(env));
      if (url.pathname === '/api/snapshots') return json(await snapshotHistory(env, url.searchParams.get('epic') ?? 'EURUSD', url.searchParams.get('limit')));
      if (url.pathname === '/api/snapshot-status') return json(await snapshotStatus(env));
      if (url.pathname === '/api/persistence') {
        const epic=(url.searchParams.get('epic')??'').trim();
        return json(epic?await persistenceForEpic(env,epic):await persistenceAll(env));
      }
      if (url.pathname === '/api/paper-run') return json(await paperRun(env));
      if (url.pathname === '/api/paper-status') return json(await paperStatus(env));
      if (url.pathname === '/api/demo-trading-diagnostic') return json(await demoTradingDiagnostic(env));
      if (url.pathname === '/api/demo-order-test') return json(await demoOrderTest(env));
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
      if (error instanceof Fault) return json({...INFO, ...failure(error)}, error.status);
      return json({...INFO, success:false, error:'INTERNAL_ERROR',
        diagnostic:{exception_type:error instanceof Error?error.name:'Unknown',
          message:error instanceof Error?error.message.slice(0,300):'Unknown internal error'}},500);
    }
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async()=>{
      try {
        const snapshot=await snapshotRun(env);
        const paper=await paperRun(env);
        console.log(JSON.stringify({
          event:'MARKET_PULSE_CRON',
          version:VERSION,
          scheduled_time:event.scheduledTime,
          snapshot_success:snapshot.success,
          inserted:snapshot.inserted,
          duplicates:snapshot.duplicates,
          failed:snapshot.failed,
          paper_success:paper.success,
          paper_actions:paper.actions?.map((x:Obj)=>({epic:x.epic,action:x.action}))
        }));
      } catch (error) {
        const detail=failure(error);
        console.error(JSON.stringify({event:'MARKET_PULSE_CRON_ERROR',version:VERSION,scheduled_time:event.scheduledTime,...detail}));
        throw error;
      }
    })());
  }
};
