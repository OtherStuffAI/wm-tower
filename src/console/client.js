import { generateSecretKey, getPublicKey, nip19 } from '/ui/assets/crypto.js';
const API_BASE = "__API_BASE__";
const $ = (id) => document.getElementById(id);
const state = { pubkey: null, npub: null, workspaces: [], active: null, generation: 0, session: 0, view: 'overview', apps: [], offset: 0, review: null, connecting: false };
const ownerOf = (w) => w?.kind === 'typed' ? 'typed:' + w.workspace_id : w?.workspace_owner_npub;
const text = (tag, value, className) => { const el = document.createElement(tag); el.textContent = value ?? ''; if (className) el.className = className; return el; };
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function bytes(value) { if (value == null || !Number.isFinite(Number(value))) return 'Unavailable'; const n = Number(value); return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
function details(entries) { const dl = document.createElement('dl'); for (const [label, value] of entries) { dl.append(text('dt', label), text('dd', value ?? 'Unavailable')); } return dl; }
function empty(target, message) { $(target).replaceChildren(text('p', message, 'empty')); }
function button(label, action, className) { const b = text('button', label, className); b.type = 'button'; b.addEventListener('click', () => run(b, action)); return b; }
async function run(control, action) {
  if (control.disabled) return;
  const session = state.session, generation = state.generation;
  control.disabled = true;
  try { await action(); }
  catch (e) {
    if (control.id === 'connect' || (session === state.session && still(generation))) {
      const message = e.message || 'Request failed. Try again.';
      status(message, true);
      const dialog = control.closest('dialog');
      if (dialog?.open) {
        let error = dialog.querySelector('.action-error');
        if (!error) { error = text('p', '', 'action-error'); error.setAttribute('role', 'alert'); dialog.append(error); }
        error.textContent = message;
      }
    }
  } finally { control.disabled = false; }
}
const still = (generation) => state.generation === generation;
function showView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== 'view-' + view);
  document.querySelectorAll('[data-view]').forEach(el => { if (el.dataset.view === view) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  $('heading').textContent = ({ overview: state.active?.name || 'A workspace for your apps.', apps: 'Apps and namespaces', storage: 'Storage', allApps: 'Apps across workspaces' })[view];
  $('context').textContent = view === 'allApps' ? 'All accessible workspaces' : state.active ? 'Active workspace · ' + state.active.name : 'Welcome to NStack';
}
async function digest(raw) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function signedFetch(path, method = 'GET', body) {
  const session = state.session;
  if (!state.pubkey || !window.nostr?.signEvent) throw new Error('Connect a Nostr browser signer first.');
  const expected = state.pubkey;
  if (await window.nostr.getPublicKey() !== expected) throw new Error('Your signer identity changed. Disconnect and connect again.');
  const url = API_BASE + path, raw = body === undefined ? '' : JSON.stringify(body);
  const tags = [['u', url], ['method', method]];
  if (raw) tags.push(['payload', await digest(raw)]);
  const event = await window.nostr.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' });
  if (session !== state.session || event.pubkey !== expected) throw new Error('Connection changed. Try again with the current signer.');
  return fetch(url, { method, cache: 'no-store', headers: { Authorization: 'Nostr ' + btoa(JSON.stringify(event)), ...(raw ? { 'Content-Type': 'application/json' } : {}) }, ...(raw ? { body: raw } : {}) });
}
async function api(path, method = 'GET', body) {
  const session = state.session;
  const response = await signedFetch(path, method, body);
  let result; try { result = await response.json(); } catch { throw new Error('The backend returned an unreadable response (' + response.status + ').'); }
  if (session !== state.session) throw new Error('Connection changed. Discarding the previous response.');
  if (!response.ok) { const e = new Error(response.status === 403 ? 'Administrator access required or access is no longer available.' : result.error || 'Request failed (' + response.status + ').'); e.status = response.status; throw e; }
  return result;
}
const workspacePath = (w, tail) => '/api/v4/workspaces/' + encodeURIComponent(w.workspace_owner_npub) + tail;
function resetWorkspace() {
  state.generation++; state.active = null; state.apps = []; state.offset = 0;
  $('overview').hidden = true; $('welcome').hidden = false; $('addApp').disabled = true;
  $('previous').disabled = true; $('next').disabled = true; $('pageLabel').textContent = '';
  for (const id of ['apps', 'storage', 'inventory', 'appInventory']) empty(id, 'Choose a workspace to continue.');
  $('workspaceIdentity').replaceChildren(); $('workspaceName').textContent = ''; $('workspaceDescription').textContent = '';
  $('editName').value = ''; $('editDescription').value = ''; $('visibility').value = ''; $('completion').value = '';
  $('objectDialog').close(); $('objectDetails').replaceChildren(); $('editWorkspace').hidden = true; $('manageHint').textContent = 'Checking workspace management access…'; empty('usage', 'Measurements unavailable until a workspace is loaded.');
  $('reviewDialog').close(); $('setupDialog').close(); $('appDialog').close(); state.review = null; empty('allApps', 'Use Apps across workspaces to refresh this view.');
}
function renderWorkspaceOptions() {
  $('workspace').replaceChildren(new Option('Choose a workspace', ''));
  for (const w of state.workspaces) $('workspace').add(new Option(w.name + (w.kind === 'typed' ? ' · Typed app' : ' · Encrypted records'), ownerOf(w)));
  $('workspace').value = ownerOf(state.active) || '';
  $('workspace').disabled = !state.npub;
}
async function loadWorkspaces(preferred) {
  const session = state.session;
  const [legacy, typed] = await Promise.allSettled([api('/api/v4/workspaces?member_npub=' + encodeURIComponent(state.npub)), api('/api/v4/flightdeck-pg/workspaces?limit=500')]);
  if (legacy.status === 'rejected' && typed.status === 'rejected') throw legacy.reason;
  const payload = legacy.status === 'fulfilled' ? legacy.value : { workspaces: [] };
  if (session !== state.session) return;
  // Keep only public workspace information in UI state; never persist wrapped keys.
  state.workspaces = (payload.workspaces || []).map(w => ({ workspace_id: w.workspace_id, workspace_owner_npub: w.workspace_owner_npub, name: w.name, description: w.description, creator_npub: w.creator_npub, default_group_id: w.default_group_id, admin_group_id: w.admin_group_id }));
  if (typed.status === 'fulfilled') for (const w of typed.value.workspaces || []) {
    if (!w.identity?.workspace_id || !w.identity?.app_npub) continue;
    state.workspaces.push({ kind: 'typed', workspace_id: w.identity.workspace_id, workspace_owner_npub: w.identity.workspace_owner_npub, workspace_service_npub: w.identity.workspace_service_npub, app_npub: w.identity.app_npub, name: w.label, description: w.description, v4_workspace_id: w.v4_workspace_id });
  }
  $('workspaceCoverage').textContent = (legacy.status === 'rejected' ? 'Encrypted-record list unavailable. ' : '') + (typed.status === 'rejected' ? 'Typed app workspace list unavailable. ' : '') + 'Lists are limited to workspaces accessible to your current identity; typed app list is capped at 500.';
  renderWorkspaceOptions();
  const chosen = state.workspaces.find(w => ownerOf(w) === preferred) || state.workspaces[0];
  if (chosen) await selectWorkspace(ownerOf(chosen));
  else { resetWorkspace(); showView('overview'); status('No accessible workspaces yet. Create your first workspace to get started.'); }
}
async function connect() {
  if (!window.nostr?.getPublicKey || !window.nostr?.signEvent) throw new Error('A Nostr browser signer is needed. Enable your signer, then choose Connect with Nostr again.');
  state.pubkey = await window.nostr.getPublicKey(); state.npub = nip19.npubEncode(state.pubkey); state.session++;
  $('connect').hidden = true; $('disconnect').hidden = false; $('newWorkspace').disabled = false; $('refresh').disabled = false;
  status('Connected. Loading accessible workspaces…');
  await loadWorkspaces();
}
function disconnect() {
  state.session++; resetWorkspace(); state.npub = null; state.pubkey = null; state.workspaces = [];
  renderWorkspaceOptions(); $('workspaceCoverage').textContent = ''; $('connect').hidden = false; $('disconnect').hidden = true;
  $('newWorkspace').disabled = true; $('refresh').disabled = true; empty('allApps', 'Connect to load accessible workspaces.');
  $('setupDialog').close(); $('appDialog').close(); $('appForm').reset(); $('setupForm').reset(); showView('overview');
  status('Disconnected from this console. Your signer and existing app permissions are unchanged.');
}
async function selectWorkspace(owner) {
  resetWorkspace();
  state.active = state.workspaces.find(w => ownerOf(w) === owner) || null;
  renderWorkspaceOptions(); showView(state.view);
  if (!state.active) { status('Choose a workspace to continue.'); return; }
  const w = state.active, generation = state.generation;
  $('welcome').hidden = true; $('overview').hidden = false;
  $('workspaceName').textContent = w.name; $('workspaceDescription').textContent = w.description || 'Add a description to help people recognise this workspace.';
  $('workspaceIdentity').replaceChildren(details([['Workspace ID', w.workspace_id], ['Data model', w.kind === 'typed' ? 'Typed PG · shared tables partitioned by UUID' : 'Encrypted records · workspace service address'], ['Backing workspace mapping (not authority)', w.v4_workspace_id || 'None declared'], ['Workspace service identity', w.workspace_service_npub || w.workspace_owner_npub], [w.kind === 'typed' ? 'Owner identity' : 'Creator identity', w.kind === 'typed' ? w.workspace_owner_npub : w.creator_npub]]));
  $('editName').value = w.name; $('editDescription').value = w.description || '';
  status('Loading ' + w.name + '…');
  await Promise.all([loadApps(w, generation), loadStorage(w, generation), loadUsage(w, generation), loadInventory(w, generation)]);
  if (still(generation)) { status('Viewing ' + w.name + '. Some operations require workspace administrator access.'); if (state.view === 'allApps') await loadAllApps(); }
}
function appCard(app, w, allowActions) {
  const card = document.createElement('article');
  card.append(text('span', app.enabled ? 'Namespace enabled' : 'Namespace disabled', 'badge'), text('h3', app.app_name || 'Unnamed app'), text('p', app.app_npub, 'app-id'));
  card.append(text('p', 'Declared capabilities: ' + (app.capabilities?.join(', ') || 'None declared'), 'hint'));
  card.append(text('p', 'Access still depends on the app’s supported consent, membership and data permissions.', 'hint'));
  if (allowActions) {
    const actions = document.createElement('div'); actions.className = 'actions';
    actions.append(button('Connection instructions', () => connectionDetails(app, w)), button(app.enabled ? 'Disable namespace' : 'Enable namespace', () => reviewNamespace(app, w), app.enabled ? 'danger' : ''));
    card.append(actions);
  }
  return card;
}
async function loadApps(w = state.active, generation = state.generation) {
  if (!w) return;
  if (w.kind === 'typed') {
    $('apps').replaceChildren(typedAppCard(w)); $('addApp').disabled = true; $('editWorkspace').hidden = true;
    $('manageHint').textContent = 'Manage typed workspace details and permissions in its owning app. This console does not infer legacy namespace authority.';
    return;
  }
  empty('apps', 'Loading registered apps…');
  try {
    const payload = await api(workspacePath(w, '/apps'));
    if (!still(generation)) return;
    state.apps = payload.apps || []; $('apps').replaceChildren(); $('addApp').disabled = false; $('editWorkspace').hidden = false; $('manageHint').textContent = 'You can manage this workspace.';
    if (!state.apps.length) empty('apps', 'No apps registered in ' + w.name + '. Choose Connect an app to review a new connection.');
    else for (const app of state.apps) $('apps').append(appCard(app, w, true));
  } catch (e) { if (still(generation)) { empty('apps', 'App list unavailable. ' + e.message + ' Use Refresh to try again.'); $('addApp').disabled = true; $('editWorkspace').hidden = true; $('manageHint').textContent = 'Management unavailable. ' + e.message; } }
}
async function loadUsage(w, generation) {
  empty('usage', 'Loading stored-byte counters…');
  try {
    if (w.kind === 'typed') {
      const usage = await api('/api/v4/flightdeck-pg/workspaces/' + encodeURIComponent(w.workspace_id) + '/storage-usage?app_npub=' + encodeURIComponent(w.app_npub));
      if (!still(generation)) return;
      $('usage').replaceChildren(details((usage.categories || []).map(c => [c.label + ' · ' + c.status, bytes(c.bytes) + ' — ' + (c.reason || c.measurement || '')])), text('p', usage.total_description || 'Partial covered subtotal; not total backend disk usage.', 'hint'));
      return;
    }
    const usage = await api(workspacePath(w, '/usage'));
    if (!still(generation)) return;
    $('usage').replaceChildren(details([['Encrypted record bytes (all versions)', bytes(usage.record_bytes)], ['Completed object bytes (registered metadata)', bytes(usage.object_bytes)]]));
  } catch (e) { if (still(generation)) empty('usage', 'Measurements unavailable. ' + e.message); }
}
const inventoryPath = (w) => workspacePath(w, '/namespace-inventory');
function inventoryContent(payload, w) {
  const container = document.createElement('div');
  container.append(text('p', 'Owner/app namespace scope · ' + payload.workspace_owner_npub, 'app-id'));
  if (w.kind === 'typed') container.append(text('p', 'These registrations belong to the owner address and may be shared across typed workspaces. They are not installations in this workspace. Access is checked independently of typed membership and backing mappings.', 'hint'));
  container.append(text('p', 'Source: ' + payload.provenance, 'hint'));
  const archivedCount = (payload.apps || []).filter(a => a.archived).length;
  const toggleLabel = text('label', 'Show archived entries (' + archivedCount + ')', 'archive-toggle');
  const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggleLabel.prepend(toggle);
  container.append(toggleLabel);
  const grid = document.createElement('div'); grid.className = 'cards'; container.append(grid);
  function render() {
    grid.replaceChildren();
    for (const app of payload.apps || []) {
      const active = app.active_installations > 0 || app.active_grants > 0 || app.active_launchers > 0;
      if (app.archived && !toggle.checked && !active) continue;
      const card = document.createElement('article');
      card.append(text('span', app.archived ? 'Archived from console' : app.enabled ? 'Registered · enabled' : 'Registered · disabled', 'badge'), text('h3', app.app_name || app.app_slug || 'Unnamed registration'), text('p', app.app_npub, 'app-id'));
      card.append(details([['Declared capabilities / services', app.capabilities?.join(', ') || 'None declared'], ['Graph data', 'Not measured here · declared capabilities do not establish quantity'], ['Registration source', 'workspace_apps'], ['Created', app.created_at ? new Date(app.created_at).toLocaleString() : 'Unavailable'], ['Publisher role at this owner', app.current_publishers > 0 ? 'Current publisher' : app.previous_publishers > 0 ? 'Previous publisher · history retained' : 'No publisher reference measured'], ['Active installation / grant / launcher', [app.active_installations, app.active_grants, app.active_launchers].map(v => v ?? 'Unavailable').join(' / ')], ['Shared app rows · workspace_app_rows', app.shared_rows ?? 'Unavailable'], ['Shared app collections', app.shared_collections == null ? 'Unavailable' : String(app.shared_collections)], ['WApp database schema', app.schema_name || 'No allocated schema recorded'], ['App tables in allocated schema', app.database_tables == null ? 'Not applicable' : String(app.database_tables)], ['Stored bytes', 'Unavailable — not measured by this inventory']]));
      if (active && app.archived) card.append(text('p', 'Active publisher is shown despite its earlier archive preference. Restore entry to clear that preference.', 'hint'));
      if (active && !app.archived) card.append(text('p', 'Archive protected: current publisher has active installation, grant or launcher references.', 'hint'));
      else card.append(button(app.archived ? 'Restore entry' : 'Archive from console', () => reviewInventoryArchive(app, w)));
      grid.append(card);
    }
    if (!grid.children.length) grid.append(text('p', archivedCount ? 'No unarchived registrations. Use Show archived entries to restore them.' : 'No registrations at this owner address. This does not prove no typed data or files exist.', 'hint'));
  }
  toggle.addEventListener('change', render); render();
  if (payload.truncated) container.append(text('p', 'Inventory truncated at 500 registrations; additional entries are not shown.', 'hint'));
  container.append(text('p', payload.coverage, 'hint'));
  return container;
}
async function reviewInventoryArchive(app, w) {
  const session = state.session, generation = state.generation;
  const action = app.archived ? 'restore' : 'archive';
  const path = inventoryPath(w) + '/' + encodeURIComponent(app.app_npub);
  const preview = await api(path + '/preview', 'POST', { action });
  if (session !== state.session || !still(generation)) return;
  const checkTarget = () => { if (session !== state.session || !still(generation)) throw new Error('Workspace or signer changed. Start a new review.'); };
  checkTarget();
  const entry = preview.entry;
  const label = text('label', 'Type this exact confirmation: ' + preview.confirmation);
  const input = document.createElement('input'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
  input.id = 'archiveConfirmation'; label.htmlFor = input.id;
  review(action === 'archive' ? 'Archive from console?' : 'Restore entry?', [
    details([['Owner address · shared across workspaces', preview.workspace_owner_npub], ['Exact app identity', preview.app_npub], ['Name', entry.app_name], ['Created', entry.created_at], ['Shared rows retained', entry.shared_rows], ['Custom tables retained', entry.database_tables ?? 'No allocated schema'], ['Schema manifests retained', entry.schema_manifests], ['Typed workspace references retained', entry.typed_workspaces], ['Current / previous publisher references retained', entry.current_publishers + ' / ' + entry.previous_publishers], ['Active installation / grant / launcher', [entry.active_installations, entry.active_grants, entry.active_launchers].join(' / ')]]),
    text('p', preview.impact), ...(preview.blocked_reason ? [text('p', preview.blocked_reason)] : []), label, input,
  ], action === 'archive' ? 'Archive from console' : 'Restore entry', async () => {
    checkTarget();
    if (!preview.allowed || input.value !== preview.confirmation) throw new Error('Exact confirmation required.');
    await api(path + '/visibility', 'POST', { action, preview_token: preview.preview_token, confirmation: input.value });
    if (session === state.session) {
      await loadInventory(state.active, state.generation);
      if (state.view === 'allApps') await loadAllApps();
      status(action === 'archive' ? 'Entry archived from console. All data and access retained.' : 'Entry restored to console. All data and access retained.');
    }
  });
  const check = () => { $('approveReview').disabled = !preview.allowed || input.value !== preview.confirmation; };
  input.addEventListener('input', check); check(); input.focus();
}
async function loadInventory(w, generation) {
  for (const id of ['inventory', 'appInventory']) empty(id, 'Loading namespace inventory…');
  try {
    const payload = await api(inventoryPath(w));
    if (!still(generation)) return;
    for (const id of ['inventory', 'appInventory']) $(id).replaceChildren(...(w.kind === 'typed' ? [typedAppCard(w)] : []), inventoryContent(payload, w));
  } catch (e) {
    if (still(generation)) for (const id of ['inventory', 'appInventory']) $(id).replaceChildren(...(w.kind === 'typed' ? [typedAppCard(w)] : []), text('p', 'Namespace inventory unavailable. ' + e.message + ' This is not an empty inventory.', 'empty'));
  }
}
function typedAppCard(w) {
  const card = document.createElement('article');
  card.append(text('span', 'Typed workspace app identity', 'badge'), text('h3', w.app_npub === 'npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5' ? 'Ambulando / Flight Deck namespace' : 'Typed app namespace'), text('p', w.app_npub, 'app-id'), text('p', 'Source: flightdeck_pg_workspaces.app_npub. Shared public flightdeck_pg_* tables hold typed data partitioned by workspace UUID. Several workspaces and clients can use the same app identity. Client branding does not establish a separate namespace. This is not an installed-app or online-connection inventory.', 'hint'));
  return card;
}
async function loadAllApps() {
  if (!state.npub) return;
  const session = state.session, generation = state.generation;
  empty('allApps', 'Loading apps across accessible workspaces…');
  const cards = [], seenOwners = new Map();
  for (const w of state.workspaces) {
    if (session !== state.session || !still(generation)) return;
    const section = document.createElement('section'); section.className = 'workspace-apps'; section.append(text('h2', w.name));
    if (w.kind === 'typed') section.append(typedAppCard(w));
    const previousOwner = seenOwners.get(w.workspace_owner_npub);
    if (previousOwner) section.append(text('p', 'Shared owner/app inventory shown under ' + previousOwner + '. The same owner scope is not counted again.', 'hint'));
    else try {
      seenOwners.set(w.workspace_owner_npub, w.name);
      const result = await api(inventoryPath(w));
      if (session !== state.session || !still(generation)) return;
      section.append(inventoryContent(result, w));
    } catch (e) { section.append(text('p', 'App list unavailable. Namespace inventory unavailable. ' + e.message + ' This is not an empty inventory.', 'hint')); }
    section.append(button('Open workspace', async () => { showView('apps'); await selectWorkspace(ownerOf(w)); })); cards.push(section);
  }
  if (session !== state.session || !still(generation)) return;
  $('allApps').replaceChildren(...cards);
  if (!cards.length) empty('allApps', 'No accessible workspaces. Create a workspace first.');
}
function review(title, content, label, action) {
  state.review = action; $('reviewTitle').textContent = title; $('reviewBody').replaceChildren(...content); $('approveReview').textContent = label; $('reviewError').textContent = ''; $('approveReview').disabled = false; $('cancelReview').disabled = false; $('reviewDialog').showModal();
}
function guard(w, session) { if (session !== state.session || ownerOf(state.active) !== ownerOf(w)) throw new Error('The active workspace or signer changed. Start again.'); }
async function reviewApp(event) {
  event.preventDefault(); $('appError').textContent = '';
  if (!state.active) return status('Choose a workspace first.', true);
  const w = state.active, session = state.session, name = $('appName').value.trim(), npub = $('appIdentity').value.trim();
  try { if (nip19.decode(npub).type !== 'npub') throw new Error(); } catch { return $('appError').textContent = 'Enter a valid public app identity beginning with npub.'; }
  if (!name) return;
  if (state.apps.some(a => a.app_npub === npub)) return $('appError').textContent = 'This app is already registered. Manage it from the app list.';
  $('appDialog').close();
  review('Register ' + name + '?', [details([['Workspace', w.name], ['Workspace service identity', ownerOf(w)], ['App public identity', npub], ['Declared capabilities', 'None — start with no capabilities']]), text('p', 'This registers an app namespace. It does not grant private data access, publish files, or approve browser signing on the app’s behalf. Complete the app’s own supported consent flow separately.'), text('p', 'Verify this public identity against the app before approving.', 'hint')], 'Register app', async () => {
    guard(w, session);
    // Check fresh registration state before writing: never silently re-enable an existing app.
    const fresh = await api(workspacePath(w, '/apps')); guard(w, session);
    if ((fresh.apps || []).some(a => a.app_npub === npub)) throw new Error('This app was registered elsewhere. Cancel and refresh to review its current state.');
    await api(workspacePath(w, '/apps'), 'POST', { app_npub: npub, app_name: name, capabilities: [], enabled: true });
    if (session === state.session) { $('appForm').reset(); await loadApps(); status('App namespace registered. Open Connection instructions to continue in the app.'); }
  });
}
function reviewNamespace(app, w) {
  const session = state.session;
  review((app.enabled ? 'Disable ' : 'Enable ') + app.app_name + ' namespace?', [details([['Workspace', w.name], ['App identity', app.app_npub], ['New namespace state', app.enabled ? 'Disabled' : 'Enabled']]), text('p', 'This changes only the namespace enabled flag. It does not revoke browser consent, device keys, membership, or independently granted app access. Manage those permissions in the app or browser that issued them.'), text('p', 'Existing data is retained. You can change this flag again.', 'hint')], app.enabled ? 'Disable namespace' : 'Enable namespace', async () => {
    guard(w, session);
    await api(workspacePath(w, '/apps'), 'POST', { app_npub: app.app_npub, app_name: app.app_name, enabled: !app.enabled });
    if (session === state.session) { await loadApps(); status('Namespace flag updated. Independent access grants are unchanged.'); }
  });
}
async function connectionDetails(app, w) {
  const generation = state.generation;
  const result = await api(workspacePath(w, '/apps/' + encodeURIComponent(app.app_npub) + '/descriptor'));
  if (!still(generation)) return;
  const d = result.descriptor;
  $('objectTitle').textContent = 'Continue in ' + app.app_name;
  $('objectDetails').replaceChildren(text('p', 'Use the app’s own Connect backend flow. Verify these public details, then review the access it requests in your browser. This console does not approve that consent.'), details([['Backend URL', d.tower_base_url], ['Workspace service identity', d.workspace_service_npub], ['App identity', d.app_npub], ['Schema ready', d.enabled ? 'Published and enabled' : 'Not ready — the app may need to publish its schema']]), text('p', 'For apps that accept the existing NStack connection token, get it below and paste it into their Connect backend screen. Typed apps may still require their own workspace setup. Never share a private key.', 'hint'));
  const controls = document.createElement('div'); controls.className = 'actions';
  controls.append(button('Get connection token', async () => {
    const result = await api(workspacePath(w, '/apps/' + encodeURIComponent(app.app_npub) + '/connection-token'));
    if (!still(generation)) return;
    const label = text('label', 'Connection token — public locator, not an access grant'); label.htmlFor = 'connectionToken';
    const output = document.createElement('textarea'); output.id = 'connectionToken'; output.readOnly = true; output.value = result.connection_token;
    controls.replaceChildren(label, output, button('Copy token', async () => { await navigator.clipboard.writeText(output.value); status('Connection token copied. Review access separately in the app.'); }));
  }));
  $('objectDetails').append(controls);
  $('objectDialog').showModal();
}
function reviewWorkspace(event) {
  event.preventDefault(); $('setupError').textContent = '';
  const name = $('newName').value.trim(), description = $('newDescription').value.trim(), session = state.session;
  if (!name) return;
  if (!state.npub) return status('Connect your signer first.', true);
  if (!window.nostr?.nip44?.encrypt) return $('setupError').textContent = 'Your signer needs NIP-44 encryption for workspace setup. Enable it in your signer or use a compatible signer, then try again.';
  $('setupDialog').close();
  let preparedPayload = null;
  review('Create ' + name + '?', [details([['Name', name], ['Description', description || 'No description'], ['Creator', state.npub]]), text('p', 'Your browser will generate a workspace identity and shared, administrator and private group identities. Your signer will encrypt their keys to your personal identity, then sign the creation request.'), text('p', 'Only encrypted keys are sent to NStack. Keep access to this Nostr identity: it is needed to recover the workspace. No app is connected and no file is published by this step.', 'hint')], 'Create workspace', async () => {
    if (session !== state.session) throw new Error('Signer changed. Start workspace setup again.');
    if (preparedPayload) {
      const listed = await api('/api/v4/workspaces?member_npub=' + encodeURIComponent(state.npub));
      if ((listed.workspaces || []).some(w => w.workspace_owner_npub === preparedPayload.workspace_owner_npub)) {
        $('setupForm').reset(); showView('overview'); await loadWorkspaces(preparedPayload.workspace_owner_npub); status('Workspace creation confirmed. The earlier request was saved.'); return;
      }
    }
    const payload = preparedPayload || { name, description, wrapped_by_npub: state.npub };
    if (!preparedPayload) for (const kind of ['workspace', 'default_group', 'admin_group', 'private_group']) {
      const secret = generateSecretKey();
      try {
        const publicIdentity = nip19.npubEncode(getPublicKey(secret));
        const wrapped = await window.nostr.nip44.encrypt(state.pubkey, nip19.nsecEncode(secret));
        if (session !== state.session) throw new Error('Signer changed. Start workspace setup again.');
        if (kind === 'workspace') { payload.workspace_owner_npub = publicIdentity; payload.wrapped_workspace_nsec = wrapped; }
        else { payload[kind + '_npub'] = publicIdentity; payload[kind + '_member_keys'] = [{ member_npub: state.npub, wrapped_group_nsec: wrapped, wrapped_by_npub: state.npub }]; }
      } finally { secret.fill(0); }
    }
    preparedPayload = payload;
    const result = await api('/api/v4/workspaces', 'POST', payload);
    if (session !== state.session) return;
    $('setupForm').reset(); showView('overview');
    // Creation succeeded even if subsequent listing fails: never repeat the write automatically.
    status('Workspace created. Loading its setup…');
    try { await loadWorkspaces(result.workspace_owner_npub); status('Workspace created. Next, connect an app or add a description.'); }
    catch (e) { status('Workspace created, but its view could not refresh. Use Refresh; do not create it again. ' + e.message, true); }
  });
}
async function loadStorage(w = state.active, generation = state.generation) {
  if (!w) return;
  if (w.kind === 'typed') { empty('storage', 'Typed workspace files are managed in the owning app. The generic object-metadata API does not list files by this workspace UUID. See Stored data on the overview for available covered measurements.'); return; }
  const offset = state.offset;
  empty('storage', 'Loading object metadata…'); $('previous').disabled = true; $('next').disabled = true; $('pageLabel').textContent = '';
  const params = new URLSearchParams({ limit: '20', offset: String(offset) });
  if ($('visibility').value) params.set('public', $('visibility').value);
  if ($('completion').value) params.set('completed', $('completion').value);
  try {
    const result = await api(workspacePath(w, '/storage/metadata?' + params));
    if (!still(generation) || offset !== state.offset) return;
    $('storage').replaceChildren();
    const objects = result.objects || [];
    if (!objects.length) empty('storage', 'No objects match these filters in ' + w.name + '.');
    for (const obj of objects) {
      const card = document.createElement('article');
      card.append(text('span', (obj.is_public ? 'Public' : 'Private') + ' · ' + (obj.completed_at ? 'Upload complete' : 'Upload pending'), 'badge'), text('h3', obj.file_name || 'Unnamed object'), text('p', bytes(obj.size_bytes) + ' · ' + (obj.content_type || 'Unknown type'), 'hint'), text('p', obj.object_id, 'app-id'));
      const actions = document.createElement('div'); actions.className = 'actions';
      actions.append(button('Inspect access', () => inspectObject(obj.object_id)));
      if (obj.completed_at) actions.append(button('Download file', () => downloadObject(obj)));
      card.append(actions); $('storage').append(card);
    }
    $('pageLabel').textContent = objects.length ? 'Objects ' + (offset + 1) + '–' + (offset + objects.length) + ' · 20 per page' : 'No objects on this page';
    $('previous').disabled = offset === 0; $('next').disabled = Number.isFinite(result.total) ? offset + objects.length >= result.total : objects.length < 20;
  } catch (e) { if (still(generation)) empty('storage', 'Storage list unavailable. ' + e.message + ' Use Refresh to try again.'); }
}
async function inspectObject(id) {
  const generation = state.generation;
  const o = await api('/api/v4/storage/' + encodeURIComponent(id));
  if (!still(generation)) return;
  $('objectTitle').textContent = o.file_name || 'Object access details';
  $('objectDetails').replaceChildren(details([['Object ID', o.object_id], ['Owner identity', o.owner_npub], ['Owner group ID', o.owner_group_id || 'None'], ['Access group IDs', o.access_group_ids?.join('\n') || 'None listed'], ['Visibility', o.is_public ? 'Public — anonymous reads permitted' : 'Private — server checks access'], ['Upload', o.completed_at ? 'Completed' : 'Pending'], ['Size', bytes(o.size_bytes)], ['Content type', o.content_type], ['SHA-256', o.sha256_hex || 'Not supplied']]), text('p', 'Workspace management does not automatically grant file-content access. Access rules are enforced by the server.', 'hint'));
  $('objectDialog').showModal();
}
async function downloadObject(obj) {
  const generation = state.generation;
  status('Checking access and downloading…');
  const response = await signedFetch('/api/v4/storage/' + encodeURIComponent(obj.object_id) + '/content');
  if (!response.ok) throw new Error('Download unavailable (' + response.status + '). Your identity may not have permission to read this object.');
  const blob = await response.blob();
  if (!still(generation)) return;
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = (obj.file_name || obj.object_id).replace(/[\\/]/g, '_'); document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('Download requested. Encrypted content remains encrypted.');
}
$('backend').textContent = API_BASE;
$('connect').addEventListener('click', () => run($('connect'), connect));
$('disconnect').addEventListener('click', disconnect);
$('workspace').addEventListener('change', () => selectWorkspace($('workspace').value).catch(e => status(e.message, true)));
$('refresh').addEventListener('click', () => run($('refresh'), async () => { const current = ownerOf(state.active); resetWorkspace(); await loadWorkspaces(current); if (state.view === 'allApps') await loadAllApps(); }));
$('newWorkspace').addEventListener('click', () => $('setupDialog').showModal());
$('addApp').addEventListener('click', () => $('appDialog').showModal());
$('setupForm').addEventListener('submit', reviewWorkspace); $('appForm').addEventListener('submit', reviewApp);
$('editWorkspace').addEventListener('submit', event => { event.preventDefault(); const b = event.submitter; run(b, async () => {
  const w = state.active, generation = state.generation; if (!w) throw new Error('Choose a workspace first.');
  const result = await api(workspacePath(w, ''), 'PATCH', { name: $('editName').value.trim(), description: $('editDescription').value.trim() });
  if (!still(generation)) return;
  Object.assign(w, { name: result.name, description: result.description }); renderWorkspaceOptions(); $('workspaceName').textContent = w.name; $('workspaceDescription').textContent = w.description; showView(state.view); status('Workspace details saved.');
}); });
$('approveReview').addEventListener('click', async () => {
  const action = state.review; if (!action || $('approveReview').disabled) return;
  $('approveReview').disabled = true; $('cancelReview').disabled = true; $('reviewError').textContent = 'Waiting for your signer and backend…';
  try { await action(); $('reviewDialog').close(); state.review = null; }
  catch (e) { $('reviewError').textContent = (e.message || 'Could not complete the request.') + ' You can cancel and refresh. Retrying uses the same reviewed request; a changed preview requires a new review.'; $('approveReview').textContent = 'Check result & retry'; }
  finally { $('approveReview').disabled = !state.review; $('cancelReview').disabled = false; }
});
$('cancelReview').addEventListener('click', () => { $('reviewDialog').close(); state.review = null; });
// Do not close a mutation review while its signer/backend operation is pending.
$('reviewDialog').addEventListener('cancel', event => { if ($('cancelReview').disabled) event.preventDefault(); });
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => { if (b.closest('dialog').id === 'reviewDialog' && $('cancelReview').disabled) return; b.closest('dialog').close(); });
for (const b of document.querySelectorAll('[data-view], [data-go]')) b.addEventListener('click', () => { const view = b.dataset.view || b.dataset.go; showView(view); if (view === 'allApps') loadAllApps().catch(e => status(e.message, true)); });
for (const id of ['visibility', 'completion']) $(id).addEventListener('change', () => { state.offset = 0; state.generation++; loadStorage(); });
$('previous').addEventListener('click', () => { state.offset = Math.max(0, state.offset - 20); state.generation++; loadStorage(); });
$('next').addEventListener('click', () => { state.offset += 20; state.generation++; loadStorage(); });
