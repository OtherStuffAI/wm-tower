import { test, expect } from 'bun:test';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent, nip19, nip44 } from 'nostr-tools';
import { buildNstackConsoleHtml, consoleAsset } from '../src/nstack-console';

// Entirely disposable HTTP fixtures. No request reaches a real Tower or workspace.
test('workspace console: signed bootstrap, isolation, consent boundaries, storage, mobile and keyboard', async () => {
  const secret = generateSecretKey(), pubkey = getPublicKey(secret), npub = nip19.npubEncode(pubkey);
  const appNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
  const workspaces: any[] = [
    { workspace_id: 'fixture-a', workspace_owner_npub: 'fixture-owner-a', name: 'Example Studio', description: 'Disposable browser fixture', creator_npub: npub },
    { workspace_id: 'fixture-b', workspace_owner_npub: 'fixture-owner-b', name: 'Example Archive', creator_npub: npub },
    { workspace_id: 'fixture-c', workspace_owner_npub: 'fixture-owner-c', name: 'Example Member', creator_npub: npub },
  ];
  const apps: Record<string, any[]> = { 'fixture-owner-a': [{ app_npub: appNpub, app_name: 'Example Notes', enabled: true, capabilities: ['notes'] }] };
  const writes: { path: string; body: any }[] = [], requests: string[] = [], signedEvents: any[] = [];
  let delayApps = false, releaseApps: (() => void) | undefined, responseLoss = false, typedUnavailable = false, rejectWrap = false;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === '/ui') return new Response(buildNstackConsoleHtml(url.origin), { headers: { 'Content-Type': 'text/html' } });
    if (path.startsWith('/ui/assets/')) { const f = consoleAsset(path.split('/').pop()!); return f ? new Response(f) : new Response('', { status: 404 }); }
    requests.push(path + url.search);
    const raw = req.method === 'GET' ? '' : await req.text();
    const event = JSON.parse(Buffer.from((req.headers.get('authorization') || '').replace('Nostr ', ''), 'base64').toString());
    expect(verifyEvent(event)).toBe(true); expect(event.tags).toContainEqual(['u', req.url]); expect(event.tags).toContainEqual(['method', req.method]);
    if (raw) expect(event.tags).toContainEqual(['payload', createHash('sha256').update(raw).digest('hex')]);
    signedEvents.push(event);
    const body = raw ? JSON.parse(raw) : null;
    const owner = decodeURIComponent(path.split('/')[4] || '');
    if (req.method !== 'GET') writes.push({ path, body });
    if (path === '/api/v4/flightdeck-pg/workspaces' && typedUnavailable) return Response.json({ error: 'Temporarily unavailable' }, { status: 503 });
    if (path === '/api/v4/flightdeck-pg/workspaces') return Response.json({ workspaces: [{ identity: { workspace_id: 'typed-fixture', workspace_owner_npub: 'human-owner-not-service', workspace_service_npub: 'typed-service', app_npub: appNpub }, label: 'Example Typed Workspace', v4_workspace_id: null }] });
    if (path.includes('/typed-fixture/storage-usage')) return Response.json({ categories: [{ label: 'Database', status: 'measured', bytes: 1024, measurement: 'Logical estimate' }, { label: 'Git', status: 'unavailable', bytes: null, reason: 'No attribution' }], total_description: 'Partial estimate' });
    if (path === '/api/v4/workspaces' && req.method === 'GET') return Response.json({ workspaces });
    if (path === '/api/v4/workspaces' && req.method === 'POST') {
      const key = nip44.getConversationKey(secret, pubkey);
      const decoded = nip19.decode(nip44.decrypt(body.wrapped_workspace_nsec, key));
      expect(decoded.type).toBe('nsec'); expect(nip19.npubEncode(getPublicKey(decoded.data as Uint8Array))).toBe(body.workspace_owner_npub);
      for (const kind of ['default_group', 'admin_group', 'private_group']) {
        const mk = body[kind + '_member_keys'][0]; expect(mk.member_npub).toBe(npub); expect(mk.wrapped_by_npub).toBe(npub);
        const groupSecret = nip19.decode(nip44.decrypt(mk.wrapped_group_nsec, key));
        expect(nip19.npubEncode(getPublicKey(groupSecret.data as Uint8Array))).toBe(body[kind + '_npub']);
      }
      expect(JSON.stringify(body)).not.toMatch(/nsec1/);
      workspaces.push({ workspace_id: 'fixture-created', workspace_owner_npub: body.workspace_owner_npub, name: body.name, description: body.description, creator_npub: npub });
      if (responseLoss) return new Response('lost response', { status: 502 });
      return Response.json({ workspace_owner_npub: body.workspace_owner_npub }, { status: 201 });
    }
    if (owner === 'fixture-owner-c') return Response.json({ error: 'Not authorized' }, { status: 403 });
    if (path.endsWith('/apps') && req.method === 'GET') {
      if (delayApps && owner === 'fixture-owner-a') await new Promise<void>(r => { releaseApps = r; });
      return Response.json({ apps: apps[owner] || [] });
    }
    if (path.endsWith('/apps') && req.method === 'POST') { const existing = (apps[owner] ||= []).find(a => a.app_npub === body.app_npub); if (existing) Object.assign(existing, body); else apps[owner].push(body); return Response.json({ app: body }, { status: 201 }); }
    if (path.endsWith('/descriptor')) return Response.json({ descriptor: { tower_base_url: url.origin, workspace_service_npub: owner, app_npub: appNpub, enabled: true } });
    if (path.endsWith('/connection-token')) return Response.json({ connection_token: 'example-public-locator' });
    if (path.endsWith('/usage')) return Response.json({ record_bytes: 0, object_bytes: 2048 });
    if (path.endsWith('/storage/metadata')) return Response.json({ total: owner === 'fixture-owner-a' ? 1 : 0, objects: owner === 'fixture-owner-a' ? [{ object_id: 'example-object', file_name: 'Example private file.txt', content_type: 'text/plain', size_bytes: 7, is_public: false, completed_at: '2026-01-01' }] : [] });
    if (path === '/api/v4/storage/example-object') return Response.json({ object_id: 'example-object', owner_npub: 'fixture-owner-a', access_group_ids: ['example-group'], is_public: false, completed_at: '2026-01-01', size_bytes: 7 });
    if (path.endsWith('/content')) return new Response('example', { headers: { 'Content-Type': 'text/plain' } });
    return Response.json({ error: 'Unexpected fixture route ' + path }, { status: 404 });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage(); page.setDefaultTimeout(8000); const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('fixtureSign', (event: any) => finalizeEvent(event, secret));
    await page.exposeFunction('fixtureEncrypt', (peer: string, value: string) => { if (rejectWrap) throw new Error('Signer request cancelled'); return nip44.encrypt(value, nip44.getConversationKey(secret, peer)); });
    await page.addInitScript(({ pubkey }) => { (window as any).nostr = { getPublicKey: async () => pubkey, signEvent: (e: any) => (window as any).fixtureSign(e), nip44: { encrypt: (peer: string, value: string) => (window as any).fixtureEncrypt(peer, value) } }; }, { pubkey });
    await page.goto(server.url + 'ui');
    await page.keyboard.press('Tab'); expect(await page.locator('.skip').evaluate(e => e === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter'); expect(await page.locator('#main').evaluate(e => e === document.activeElement)).toBe(true);
    await page.locator('#connect').click(); await page.locator('#workspaceName').filter({ hasText: 'Example Studio' }).waitFor();
    await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Viewing'));
    expect(await page.locator('#usage').textContent()).toContain('0 B'); expect(await page.locator('#usage').textContent()).toContain('2.0 KB');
    if (process.env.CONSOLE_SCREENSHOT_DIR) await page.screenshot({ path: process.env.CONSOLE_SCREENSHOT_DIR + '/desktop.png', fullPage: true });
    await page.locator('[data-view="apps"]').click(); expect(await page.locator('#apps').textContent()).toContain('Namespace enabled');
    await page.getByRole('button', { name: 'Disable namespace', exact: true }).click(); expect(writes.length).toBe(0);
    expect(await page.locator('#reviewBody').textContent()).toContain('does not revoke browser consent');
    await page.locator('#cancelReview').click(); expect(writes.length).toBe(0);
    await page.getByRole('button', { name: 'Disable namespace', exact: true }).click(); await page.locator('#approveReview').click();
    await page.getByText('Namespace disabled', { exact: true }).waitFor(); expect(writes.at(-1)!.body.enabled).toBe(false); expect(writes.at(-1)!.path).toContain('fixture-owner-a');
    await page.getByRole('button', { name: 'Connection instructions' }).click(); await page.getByRole('button', { name: 'Get connection token' }).click(); await page.locator('#connectionToken').waitFor(); expect(await page.locator('#connectionToken').inputValue()).toBe('example-public-locator'); await page.keyboard.press('Escape');
    await page.locator('[data-view="storage"]').click(); await page.getByRole('button', { name: 'Inspect access' }).click(); await page.locator('#objectDetails').filter({ hasText: 'example-group' }).waitFor(); expect(await page.locator('#objectDetails').textContent()).toContain('example-group'); await page.keyboard.press('Escape');
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download file' }).click(); expect((await download).suggestedFilename()).toBe('Example private file.txt');
    await page.locator('#workspace').selectOption('fixture-owner-c'); await page.waitForFunction(() => document.getElementById('manageHint')!.textContent!.includes('Management unavailable'));
    expect(await page.locator('#editWorkspace').isHidden()).toBe(true); expect(await page.locator('#addApp').isDisabled()).toBe(true); expect(await page.locator('#usage').textContent()).toContain('unavailable'); expect(await page.locator('#storage').textContent()).not.toContain('Example private file');
    await page.locator('[data-view="allApps"]').click(); await page.locator('#allApps').getByText('App list unavailable.', { exact: false }).first().waitFor(); expect(await page.locator('#allApps').textContent()).toContain('Example Member');
    await page.locator('#workspace').selectOption('typed:typed-fixture'); await page.locator('[data-view="overview"]').click(); await page.getByText('Partial estimate', { exact: true }).waitFor(); expect(await page.locator('#usage').textContent()).toContain('Unavailable'); expect(await page.locator('#workspaceIdentity').textContent()).toContain('typed-service'); expect(await page.locator('#addApp').isDisabled()).toBe(true); expect(requests.some(p => p.includes('/human-owner-not-service/apps'))).toBe(false);
    // Hold an old response while switching; it must never enter the new workspace.
    delayApps = true; await page.locator('#workspace').selectOption('fixture-owner-a');
    await page.waitForTimeout(100); await page.locator('#workspace').selectOption('fixture-owner-b'); releaseApps?.(); delayApps = false;
    await page.waitForFunction(() => document.getElementById('status')!.textContent!.startsWith('Viewing Example Archive'));
    expect(await page.locator('#apps').textContent()).not.toContain('Example Notes');
    await page.locator('#newWorkspace').click(); await page.locator('#newName').fill('Example New Workspace'); await page.locator('#newDescription').fill('Disposable test data'); await page.getByRole('button', { name: 'Review workspace', exact: true }).click();
    const count = writes.length; await page.locator('#approveReview').click(); await page.locator('#workspaceName').filter({ hasText: 'Example New Workspace' }).waitFor(); expect(writes.length).toBe(count + 1);
    const createdOwner = workspaces.at(-1).workspace_owner_npub;
    await page.locator('[data-view="apps"]').click(); await page.locator('#addApp').click(); await page.locator('#appName').fill('Example Connected App'); await page.locator('#appIdentity').fill(appNpub); await page.getByRole('button', { name: 'Review connection' }).click(); expect(await page.locator('#reviewBody').textContent()).toContain('does not grant private data access'); await page.locator('#approveReview').click(); await page.getByRole('heading', { name: 'Example Connected App', exact: true }).waitFor(); expect(writes.at(-1)!.path).toContain(createdOwner); expect(writes.at(-1)!.body.capabilities).toEqual([]);
    // A successful write with a lost response must reconcile without a second POST.
    responseLoss = true; await page.locator('#newWorkspace').click(); await page.locator('#newName').fill('Example Lost Response'); await page.getByRole('button', { name: 'Review workspace', exact: true }).click(); await page.locator('#approveReview').click(); await page.locator('#reviewError').filter({ hasText: 'unreadable response' }).waitFor(); const writesBeforeRetry = writes.length; await page.locator('#approveReview').click(); await page.waitForFunction(() => !document.getElementById('reviewDialog')!.hasAttribute('open')); expect(writes.length).toBe(writesBeforeRetry); await page.locator('#refresh').click(); await page.waitForFunction(() => !document.getElementById('refresh')!.hasAttribute('disabled')); expect(await page.locator('#workspace').textContent()).toContain('Example Lost Response');
    responseLoss = false; typedUnavailable = true; await page.locator('#refresh').click(); await page.locator('#workspaceCoverage').filter({ hasText: 'Typed app workspace list unavailable' }).waitFor(); expect(await page.locator('#workspace').textContent()).toContain('Example Studio');
    rejectWrap = true; await page.locator('#newWorkspace').click(); await page.locator('#newName').fill('Example Cancelled Setup'); await page.getByRole('button', { name: 'Review workspace', exact: true }).click(); const beforeCancel = writes.length; await page.locator('#approveReview').click(); await page.locator('#reviewError').filter({ hasText: 'Signer request cancelled' }).waitFor(); expect(writes.length).toBe(beforeCancel); await page.locator('#cancelReview').click(); rejectWrap = false;
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('[data-view="overview"]').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.CONSOLE_SCREENSHOT_DIR) await page.screenshot({ path: process.env.CONSOLE_SCREENSHOT_DIR + '/mobile.png', fullPage: true });
    await page.locator('#newWorkspace').click(); await page.keyboard.press('Tab'); expect(await page.locator('#setupDialog').evaluate(d => d.contains(document.activeElement))).toBe(true); await page.keyboard.press('Escape'); expect(await page.locator('#newWorkspace').evaluate(e => e === document.activeElement)).toBe(true);
    await page.locator('#disconnect').click(); expect(await page.locator('#workspace').isDisabled()).toBe(true); expect(await page.locator('#allApps').textContent()).not.toContain('Example Notes');
    expect(writes.every(w => !/revoke|publish|delete/.test(w.path))).toBe(true); expect(requests.every(p => p.startsWith('/api/v4/'))).toBe(true); expect(signedEvents.length).toBeGreaterThan(10); expect(errors).toEqual([]);
    await page.evaluate(() => { delete (window as any).nostr; }); await page.locator('#connect').click(); await page.locator('#status').filter({ hasText: 'A Nostr browser signer is needed' }).waitFor(); expect(await page.locator('#newWorkspace').isDisabled()).toBe(true);
  } finally { await browser.close(); server.stop(true); secret.fill(0); }
}, 60000);
