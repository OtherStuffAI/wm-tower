import { getDb } from '../db';
import { collectWorkspaceStorageUsage } from './workspace-storage-usage';
import type { WorkspaceStorageUsage } from '../types';
type Db = ReturnType<typeof getDb>;
export const USD_UNITS = 144_000_000_000n;
export const centsUnits = (cents: number) => BigInt(cents) * (USD_UNITS / 100n);
export function unitsUsd(value: string | bigint): string {
  const units = BigInt(value), negative = units < 0n, abs = negative ? -units : units;
  // Display only. All ledger/balance arithmetic retains exact integer tariff units.
  return `${negative ? '-' : ''}${abs / USD_UNITS}.${((abs % USD_UNITS) * 1_000_000_000_000n / USD_UNITS).toString().padStart(12, '0')}`;
}
export class HostingError extends Error { constructor(public status: number, public code: string) { super(code); } }
export async function linkHostedAccount(workspaceId: string, ownerActorId: string, db: Db) {
  const [owner]=await db`SELECT w.workspace_owner_npub,a.npub FROM flightdeck_pg_workspaces w JOIN flightdeck_pg_actors a ON a.id=${ownerActorId} WHERE w.id=${workspaceId}`;
  if(!owner||owner.workspace_owner_npub!==owner.npub)throw new HostingError(409,'billing_owner_conflict');
  await db`SELECT pg_advisory_xact_lock(hashtext(${`hosting-owner:${ownerActorId}`}))`;
  const [account] = await db`INSERT INTO hosting_accounts(owner_actor_id) VALUES(${ownerActorId})
    ON CONFLICT(owner_actor_id) DO UPDATE SET owner_actor_id=EXCLUDED.owner_actor_id RETURNING *`;
  await db`INSERT INTO hosting_ledger(account_id,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason)
    VALUES(${account!.id},'welcome',720000000000,0,720000000000,'welcome:v1','One customer welcome credit; expires after 30 days')
    ON CONFLICT(account_id,idempotency_key) DO NOTHING`;
  await db`INSERT INTO hosting_workspace_accounts(workspace_id,account_id) VALUES(${workspaceId},${account!.id}) ON CONFLICT(workspace_id) DO NOTHING`;
  const [link] = await db`SELECT account_id FROM hosting_workspace_accounts WHERE workspace_id=${workspaceId}`;
  if (link!.account_id !== account!.id) throw new HostingError(409,'billing_owner_conflict');
  return account!;
}
export async function lockedAccount(id: string, db: Db, now: Date) {
  let [a] = await db`SELECT * FROM hosting_accounts WHERE id=${id} FOR UPDATE`;
  if (!a) throw new HostingError(404,'billing_account_not_found');
  if (new Date(a.promo_expires_at).getTime() <= now.getTime() && BigInt(a.promo_units)>0n) {
    await db`INSERT INTO hosting_ledger(account_id,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason)
      VALUES(${id},'promo_expiry',${(-BigInt(a.promo_units)).toString()},${a.paid_units},0,'promo-expiry:v1','Welcome credit expired') ON CONFLICT DO NOTHING`;
    [a] = await db`UPDATE hosting_accounts SET promo_units=0 WHERE id=${id} RETURNING *`;
  }
  return a!;
}
export async function grantHostingCredit(accountId: string, cents: number, key: string, reason: string, actor: string, db: Db=getDb()) {
  if (!Number.isSafeInteger(cents)||cents<=0||cents>1_000_000||typeof key!=='string'||!key||key.length>100||typeof reason!=='string'||!reason.trim()||reason.length>1000) throw new HostingError(400,'invalid_grant');
  return db.begin(async tx=> {
    const sql=tx as unknown as Db, a=await lockedAccount(accountId,sql,new Date());
    const [prior]=await sql`SELECT * FROM hosting_ledger WHERE account_id=${accountId} AND idempotency_key=${`admin:${key}`}`;
    const amount=centsUnits(cents).toString();
    if(prior) { if(prior.amount_units!==amount||prior.reason!==reason||prior.actor_npub!==actor) throw new HostingError(409,'idempotency_conflict'); return prior; }
    const paid=(BigInt(a.paid_units)+BigInt(amount)).toString();
    await sql`UPDATE hosting_accounts SET paid_units=${paid},depleted_at=CASE WHEN ${paid}::numeric+promo_units>0 THEN NULL ELSE depleted_at END WHERE id=${accountId}`;
    const [entry]=await sql`INSERT INTO hosting_ledger(account_id,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason,actor_npub)
      VALUES(${accountId},'admin',${amount},${paid},${a.promo_units},${`admin:${key}`},${reason},${actor}) RETURNING *`;
    return entry;
  });
}
export function coveredBytes(usage: WorkspaceStorageUsage): bigint|null {
  const required=['objects','database'].map(id=>usage.categories.find(c=>c.id===id));
  if(required.some(c=>!c||c.bytes===null||c.status==='unavailable'||!Number.isSafeInteger(c.bytes)||c.bytes!<0))return null;
  return required.reduce((sum,c)=>sum+BigInt(c!.bytes!),0n);
}
export async function auditHostingHour(workspaceId: string, hour: Date, usage: WorkspaceStorageUsage|null, db: Db=getDb(), now=new Date()) {
  if(hour.getTime()%3_600_000!==0||hour>now)throw new HostingError(400,'invalid_hour');
  return db.begin(async tx=> {
    const sql=tx as unknown as Db;
    const [link]=await sql`SELECT * FROM hosting_workspace_accounts WHERE workspace_id=${workspaceId}`;
    if(!link)return null;
    const a=await lockedAccount(link.account_id,sql,now);
    const [prior]=await sql`SELECT * FROM hosting_usage_hours WHERE workspace_id=${workspaceId} AND hour=${hour}`;
    if(prior)return prior;
    const start=new Date(link.enabled_at).getTime();
    if(hour.getTime()<Math.floor(start/3_600_000)*3_600_000)return null;
    // A sample must belong to this hour. Never backfill past bytes using current measurements.
    const current=Math.floor(now.getTime()/3_600_000)*3_600_000;
    const sample=usage&&usage.workspace_id===workspaceId&&Math.floor(new Date(usage.collected_at).getTime()/3_600_000)*3_600_000===hour.getTime();
    const bytes=sample?coveredBytes(usage!):null;
    const status=hour.getTime()<start?'partial_hour':hour.getTime()!==current?'missed':bytes===null?'unavailable':'charged';
    const debit=status==='charged'?bytes!:0n;
    let promo=BigInt(a.promo_units),paid=BigInt(a.paid_units);
    if(status==='charged') {
      const fromPromo=promo<debit?promo:debit; promo-=fromPromo;paid-=debit-fromPromo;
      await sql`UPDATE hosting_accounts SET promo_units=${promo.toString()},paid_units=${paid.toString()},
        depleted_at=CASE WHEN ${promo.toString()}::numeric+${paid.toString()}::numeric<=0 THEN COALESCE(depleted_at,${now}) ELSE NULL END WHERE id=${a.id}`;
      if (debit>0n) await sql`INSERT INTO hosting_ledger(account_id,workspace_id,kind,amount_units,paid_after_units,promo_after_units,idempotency_key,reason)
        VALUES(${a.id},${workspaceId},'usage',${(-debit).toString()},${paid.toString()},${promo.toString()},${`usage:${workspaceId}:${hour.toISOString()}`},'USD v1: covered byte-hours at $5/decimal GB/720 hours')`;
    }
    const [row]=await sql`INSERT INTO hosting_usage_hours(workspace_id,hour,account_id,status,bytes,debit_units,evidence)
      VALUES(${workspaceId},${hour},${a.id},${status},${bytes?.toString()??null},${debit.toString()},${sql.json(JSON.parse(JSON.stringify(usage??{reason:'No contemporaneous sample retained'})))}) RETURNING *`;
    return row;
  });
}
export async function hostingStatus(workspaceId:string,db:Db=getDb(),now=new Date()) {
  const [a]=await db`SELECT a.*, l.enabled_at FROM hosting_workspace_accounts l JOIN hosting_accounts a ON a.id=l.account_id WHERE l.workspace_id=${workspaceId}`;
  if(!a)return {version:1,billing_mode:'legacy_unlinked',workspace_id:workspaceId,stripe:stripeAvailability()};
  const promo=new Date(a.promo_expires_at)>now?BigInt(a.promo_units):0n, balance=BigInt(a.paid_units)+promo;
  const hours=await db`SELECT DISTINCT ON(workspace_id) workspace_id,status,bytes,debit_units,hour,evidence FROM hosting_usage_hours WHERE account_id=${a.id} ORDER BY workspace_id,hour DESC`;
  const [count]=await db`SELECT count(*)::int AS total FROM hosting_workspace_accounts WHERE account_id=${a.id}`;
  const complete=hours.length===count!.total&&hours.length>0&&hours.every(h=>h.status==='charged'&&new Date(h.hour).getTime()===Math.floor(now.getTime()/3600000)*3600000);
  const burn=complete?hours.reduce((s,h)=>s+BigInt(h.debit_units),0n):null;
  let runout: string|null=null;
  if(burn&&balance>0n) {
    let duration=balance*3600000n/burn;
    const untilExpiry=BigInt(Math.max(0,new Date(a.promo_expires_at).getTime()-now.getTime()));
    if(promo>0n&&duration>untilExpiry) {
      const spent=burn*untilExpiry/3600000n;
      const paidRemaining=BigInt(a.paid_units)-(spent>promo?spent-promo:0n);
      duration=untilExpiry+(paidRemaining>0n?paidRemaining*3600000n/burn:0n);
    }
    const timestamp=BigInt(now.getTime())+duration;
    // Tiny covered usage can project beyond the representable date range.
    if(timestamp<=8640000000000000n)runout=new Date(Number(timestamp)).toISOString();
  }
  const state=balance>0n?'active':a.depleted_at?'read_only_grace':'measurement_pending';
  return {version:1,billing_mode:'usd_prepaid',workspace_id:workspaceId,account_id:a.id,currency:'USD',tariff:{usd_per_gb_month:'5',gb_bytes:1000000000,month_hours:720,units_per_usd:USD_UNITS.toString()},
    balance_units:balance.toString(),balance_usd:unitsUsd(balance),promo_units:promo.toString(),promo_usd:unitsUsd(promo),promo_expires_at:a.promo_expires_at,
    paid_usd:unitsUsd(a.paid_units),billing_state:state,depleted_at:a.depleted_at,grace_ends_at:a.depleted_at?new Date(new Date(a.depleted_at).getTime()+21*86400000).toISOString():null,
    hourly_burn_usd:burn===null?null:unitsUsd(burn),estimated_runout_at:runout,
    coverage:'objects_and_logical_pg_rows',measurements:hours,stripe:stripeAvailability()};
}
export function stripeAvailability(){return {configured:Boolean(process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_WEBHOOK_SECRET&&process.env.HOSTING_STRIPE_RETURN_URLS),mode:process.env.HOSTING_STRIPE_MODE||'test',live_rollout_blocked:true};}
export async function hostingWriteBlock(workspaceId:string) {
  const [a]=await getDb()`SELECT a.* FROM hosting_workspace_accounts l JOIN hosting_accounts a ON a.id=l.account_id WHERE l.workspace_id=${workspaceId}`;
  if(!a||!a.depleted_at)return null;
  const promo=new Date(a.promo_expires_at)>new Date()?BigInt(a.promo_units):0n;
  return BigInt(a.paid_units)+promo<=0n?{code:'hosting_balance_exhausted',error:'Hosting balance exhausted',status:402,grace_ends_at:new Date(new Date(a.depleted_at).getTime()+21*86400000).toISOString(),automatic_deletion:false}:null;
}
export async function runHostingBillingTick(db:Db=getDb(),now=new Date(),collect=collectWorkspaceStorageUsage) {
  // Session-level singleton lock on a reserved connection; released even on failure.
  const connection=await db.reserve();
  try {
    const [lock]=await connection`SELECT pg_try_advisory_lock(1440000720) AS acquired`;
    if(!lock?.acquired)return;
    const links=await db`SELECT l.*,max(h.hour) AS last_hour FROM hosting_workspace_accounts l LEFT JOIN hosting_usage_hours h USING(workspace_id) GROUP BY l.workspace_id`;
    for(const l of links) {
      const current=Math.floor(now.getTime()/3600000)*3600000;
      const start=l.last_hour?new Date(l.last_hour).getTime()+3600000:Math.floor(new Date(l.enabled_at).getTime()/3600000)*3600000;
      // Bounded restart work; next tick resumes remaining hours.
      for(let h=start,count=0;h<=current&&count<744;h+=3600000,count++) {
        const usage=h===current?await collect(l.workspace_id,db):null;
        await auditHostingHour(l.workspace_id,new Date(h),usage,db,now);
      }
    }
  } finally {await connection`SELECT pg_advisory_unlock(1440000720)`;connection.release();}
}
export function startHostingBillingRunner() {
  let running=false;
  const tick=async()=>{if(running)return;running=true;try{await runHostingBillingTick();}catch{console.error('[hosting-billing] tick failed; retry next minute');}finally{running=false;}};
  void tick();const timer=setInterval(()=>void tick(),60000);timer.unref();return ()=>clearInterval(timer);
}
