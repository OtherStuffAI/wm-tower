import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { generateSecretKey, getPublicKey, nip19, finalizeEvent, verifyEvent } from 'nostr-tools';
import { buildNstackConsoleHtml, consoleAsset } from '../src/nstack-console';

// Disposable local HTTP fixture: every request is intercepted here, no real workspace.
test('console archive preview/cancel/short confirmation/restore and second-workspace targeting on desktop/mobile', async () => {
  const secret = generateSecretKey(), pubkey = getPublicKey(secret), owner = nip19.npubEncode(pubkey);
  const identity = nip19.npubEncode(getPublicKey(generateSecretKey()));
  const entry = (app: string, name: string, extra = {}) => ({ id: app, app_npub:app, app_name:name, enabled:true, capabilities:['graph'], created_at:'2026-09-01T08:00:00Z', updated_at:'2026-09-01T08:00:00Z', archived:false, archive_revision:'0', shared_rows:'0', shared_collections:0, schema_name:null, database_tables:null, schema_manifests:0, typed_workspaces:0,current_publishers:0,previous_publishers:1,active_installations:0,active_grants:0,active_launchers:0,...extra });
  const entries: Record<string, any[]> = {
    [owner]: [entry(identity,'Historical publisher'),entry('active-publisher','Active publisher',{ archived:true,current_publishers:1,previous_publishers:0,active_installations:1 })],
    'fixture-second-owner': [entry('second-app-12345678','Second workspace entry')],
  };
  const mutations: any[] = [], previews: any[] = []; let failMutation = false;
  const server = Bun.serve({ hostname:'127.0.0.1',port:0,async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === '/ui') return new Response(buildNstackConsoleHtml(url.origin),{headers:{'content-type':'text/html'}});
    if (path.startsWith('/ui/assets/')) { const file=consoleAsset(path.split('/').pop()!); return file ? new Response(file) : new Response('',{status:404}); }
    const raw = req.method === 'GET' ? '' : await req.text();
    const event = JSON.parse(Buffer.from((req.headers.get('authorization')||'').slice(6),'base64').toString());
    expect(verifyEvent(event)).toBe(true); expect(event.tags).toContainEqual(['u',req.url]); expect(event.tags).toContainEqual(['method',req.method]);
    if (raw) expect(event.tags).toContainEqual(['payload',createHash('sha256').update(raw).digest('hex')]);
    const body = raw ? JSON.parse(raw) : null;
    const address = decodeURIComponent(path.split('/')[4] || '');
    if (path === '/api/v4/flightdeck-pg/workspaces') return Response.json({workspaces:[]});
    if (path === '/api/v4/workspaces') return Response.json({workspaces:[{workspace_id:'one',workspace_owner_npub:owner,creator_npub:owner,name:'First workspace'},{workspace_id:'two',workspace_owner_npub:'fixture-second-owner',creator_npub:owner,name:'Second workspace'}]});
    if (path.endsWith('/namespace-inventory')) return Response.json({workspace_owner_npub:address,scope:'owner_app_namespace',provenance:'Disposable fixture',apps:entries[address],coverage:'Graph and other unmeasured stores retained',truncated:false});
    if (path.includes('/namespace-inventory/')) {
      const target = decodeURIComponent(path.split('/')[6]), e = entries[address].find(x=>x.app_npub===target);
      const confirmation = body.action.toUpperCase()+' '+target.slice(-8);
      if (path.endsWith('/preview')) { previews.push({address,target}); return Response.json({workspace_owner_npub:address,app_npub:target,entry:e,action:body.action,allowed:!e.active_installations||body.action==='restore',confirmation,preview_token:'fixture-token-'+target,impact:'All data and access retained. Permanent deletion is unavailable.'}); }
      if (failMutation) { failMutation=false; return Response.json({error:'Preview changed; review a new preview'},{status:409}); }
      expect(body.confirmation).toBe(confirmation); expect(body.preview_token).toBe('fixture-token-'+target);
      e.archived=body.action==='archive'; mutations.push({address,target,action:body.action}); return Response.json({archived:e.archived});
    }
    if (path.endsWith('/apps')) return Response.json({apps:[]});
    if (path.endsWith('/usage')) return Response.json({record_bytes:0,object_bytes:0});
    if (path.endsWith('/storage/objects')) return Response.json({objects:[],total:0});
    return Response.json({error:'Unexpected '+path},{status:404});
  } });
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}}); page.setDefaultTimeout(8000); const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.exposeFunction('fixtureSign',(e:any)=>finalizeEvent(e,secret));
    await page.addInitScript(({pubkey})=>{(window as any).nostr={getPublicKey:async()=>pubkey,signEvent:(e:any)=>(window as any).fixtureSign(e)};},{pubkey});
    await page.goto(server.url+'ui'); await page.locator('#connect').click();
    await page.locator('#inventory').getByText('Historical publisher',{exact:true}).waitFor();
    expect(await page.locator('#inventory').textContent()).toContain('Graph dataNot measured here');
    // Active state overrides an old archive preference and offers restore, never archive.
    const active = page.locator('#inventory article').filter({hasText:'Active publisher'});
    expect(await active.isVisible()).toBe(true); expect(await active.getByRole('button',{name:'Archive from console',exact:true}).count()).toBe(0);
    const historical = () => page.locator('#inventory article').filter({hasText:'Historical publisher'});
    await historical().getByRole('button',{name:'Archive from console'}).click();
    await page.locator('#archiveConfirmation').waitFor(); expect(await page.locator('#approveReview').isDisabled()).toBe(true); expect(await page.locator('#reviewBody').textContent()).toContain(owner);
    await page.locator('#cancelReview').click(); expect(mutations).toHaveLength(0);
    await historical().getByRole('button',{name:'Archive from console'}).click();
    await page.locator('#archiveConfirmation').fill('ARCHIVE wrong'); expect(await page.locator('#approveReview').isDisabled()).toBe(true);
    await page.locator('#archiveConfirmation').fill('ARCHIVE '+identity.slice(-8));
    await page.locator('#approveReview').click(); await page.locator('#reviewDialog').waitFor({state:'hidden'});
    expect(await historical().count()).toBe(0); expect(mutations).toHaveLength(1);
    await page.locator('#inventory').getByLabel('Show archived entries (2)').check();
    await historical().getByRole('button',{name:'Restore entry'}).click(); await page.locator('#archiveConfirmation').fill('RESTORE '+identity.slice(-8));await page.locator('#approveReview').click();await page.locator('#reviewDialog').waitFor({state:'hidden'});
    expect(mutations.at(-1).action).toBe('restore');expect(await historical().isVisible()).toBe(true);
    // Across-workspaces action binds exact second owner while current selection stays first.
    await page.locator('[data-view="allApps"]').click();
    const second = page.locator('#allApps article').filter({hasText:'Second workspace entry'});
    await second.getByRole('button',{name:'Archive from console'}).click();
    await page.locator('#reviewBody').filter({hasText:'fixture-second-owner'}).waitFor(); expect(await page.locator('#reviewBody').textContent()).toContain('fixture-second-owner');
    await page.locator('#archiveConfirmation').fill('ARCHIVE 12345678');failMutation=true;
    await page.locator('#approveReview').click(); await page.locator('#reviewError').filter({hasText:'Preview changed'}).waitFor();
    expect(mutations).toHaveLength(2);await page.locator('#cancelReview').click();
    await second.getByRole('button',{name:'Archive from console'}).click();await page.locator('#archiveConfirmation').fill('ARCHIVE 12345678');
    await page.locator('#approveReview').click();await page.locator('#reviewDialog').waitFor({state:'hidden'});
    expect(mutations.at(-1)).toEqual({address:'fixture-second-owner',target:'second-app-12345678',action:'archive'});
    const section = page.locator('#allApps section').filter({has:page.getByRole('heading',{name:'Second workspace',exact:true})});
    await section.getByLabel('Show archived entries (1)').check();await section.getByRole('button',{name:'Restore entry'}).click();await page.locator('#archiveConfirmation').fill('RESTORE 12345678');await page.locator('#approveReview').click();await page.locator('#reviewDialog').waitFor({state:'hidden'});
    expect(mutations.at(-1).address).toBe('fixture-second-owner');
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});await page.locator('[data-view="overview"]').click();
      await historical().getByRole('button',{name:'Archive from console'}).click();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
      if (process.env.CONSOLE_SCREENSHOT_DIR) await page.screenshot({path:process.env.CONSOLE_SCREENSHOT_DIR+'/archive-'+width+'.png',fullPage:true});
      await page.keyboard.press('Escape'); expect(mutations).toHaveLength(4);
    }
    expect(errors).toEqual([]);expect(previews.length).toBeGreaterThan(4);
  } finally {await browser.close();server.stop(true);}
},60_000);
