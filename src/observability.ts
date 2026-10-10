import { identifier, integer, invariant } from './validation.js';
/** Only public, explicitly supplied aggregate metrics; no media, tokens, precise locations or people inference. */
export type EngineHealth = 'healthy' | 'degraded' | 'unavailable' | 'unknown';
export interface EngineSignal {
  componentId: string;
  observedAtMs: number;
  status: EngineHealth;
  activeSessions: number | null;
  errorCount: number | null;
  costMinor: string | null;
  currency: string | null;
}
export interface EngineSnapshot {
  observedAtMs: number;
  health: EngineHealth;
  components: EngineSignal[];
  activeSessions: number | null;
  errors: number | null;
  costMinorByCurrency: {currency:string;amountMinor:string}[];
  freshness: 'fresh' | 'stale' | 'unobserved';
}
const allowed = new Set<EngineHealth>(['healthy','degraded','unavailable','unknown']);
export function normalizeEngineSignal(source: EngineSignal): EngineSignal {
  invariant(source && Object.keys(source).sort().join(',') === 'activeSessions,componentId,costMinor,currency,errorCount,observedAtMs,status', 'INVALID_ENGINE_SIGNAL_FIELDS');
  const value=structuredClone(source); identifier(value.componentId); integer(value.observedAtMs);
  invariant(allowed.has(value.status),'INVALID_ENGINE_SIGNAL_STATUS');
  for(const key of ['activeSessions','errorCount'] as const) if(value[key] !== null) integer(value[key],0,1_000_000_000);
  invariant((value.currency === null) === (value.costMinor === null),'INVALID_ENGINE_COST');
  if(value.currency !== null) {
    invariant(/^[A-Z]{3}$/.test(value.currency),'INVALID_ENGINE_CURRENCY');
    invariant(typeof value.costMinor === 'string' && /^(0|[1-9][0-9]{0,24})$/.test(value.costMinor), 'INVALID_ENGINE_COST');
  }
  return value;
}
export function summarizeEngineSignals(signals: readonly EngineSignal[], nowMs: number, maximumAgeMs: number): EngineSnapshot {
  integer(nowMs); integer(maximumAgeMs,1,86_400_000);
  invariant(signals.length <= 2048,'ENGINE_SIGNAL_LIMIT');
  const records=signals.map(normalizeEngineSignal).sort((a,b)=>a.componentId < b.componentId?-1:a.componentId>b.componentId?1:0);
  invariant(new Set(records.map(x=>x.componentId)).size === records.length, 'DUPLICATE_ENGINE_COMPONENT');
  invariant(records.every(x=>x.observedAtMs <= nowMs),'FUTURE_ENGINE_SIGNAL');
  const fresh=records.filter(x=>nowMs-x.observedAtMs <= maximumAgeMs);
  const freshness: EngineSnapshot['freshness']=records.length===0?'unobserved':records.length===fresh.length?'fresh':'stale';
  const status:EngineHealth = freshness!=='fresh'?'unknown':fresh.some(x=>x.status==='unavailable')?'unavailable':fresh.some(x=>x.status==='degraded')?'degraded':fresh.some(x=>x.status==='unknown')?'unknown':'healthy';
  const total=(key:'activeSessions'|'errorCount'):number|null=>freshness==='fresh' && fresh.every(x=>x[key]!==null)?fresh.reduce((sum,x)=>sum+(x[key] as number),0):null;
  const byCurrency = new Map<string,bigint>();
  for (const s of fresh) if(s.costMinor!==null && s.currency!==null) byCurrency.set(s.currency,(byCurrency.get(s.currency)??0n)+BigInt(s.costMinor));
  const costMinorByCurrency=freshness==='fresh' && fresh.every(x=>x.costMinor!==null)
    ? [...byCurrency].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([currency,total])=>({currency,amountMinor:String(total)}))
    : [];
  const activeSessions=total('activeSessions'), errors=total('errorCount');
  if(activeSessions!==null) integer(activeSessions,0,Number.MAX_SAFE_INTEGER);
  if(errors!==null) integer(errors,0,Number.MAX_SAFE_INTEGER);
  return { observedAtMs:nowMs, health:status, components:records, activeSessions, errors, costMinorByCurrency, freshness };
}
