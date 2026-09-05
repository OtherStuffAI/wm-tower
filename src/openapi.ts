import { config } from './config';
import { flightDeckPgContractFixturePaths } from './types';

function docsHtml(specUrl: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SuperBased V4 API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
    <style>
      body { margin: 0; background: #faf7ef; }
      .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: ${JSON.stringify(specUrl)},
        dom_id: '#swagger-ui',
        deepLinking: true,
        docExpansion: 'list',
        defaultModelsExpandDepth: 1,
        persistAuthorization: true
      });
    </script>
  </body>
</html>`;
}

function adminInterfaceHtml(apiBaseUrl: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Tower Admin</title>
    <style>
      :root {
        --bg: #f7f8f8;
        --panel: #ffffff;
        --panel-2: #f1f5f4;
        --line: #cdd8d5;
        --text: #16201e;
        --muted: #60706c;
        --accent: #0f766e;
        --accent-dark: #115e59;
        --danger: #b91c1c;
        --warn: #a16207;
        --mono: "SFMono-Regular", "Menlo", monospace;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--text);
      }
      .app {
        min-height: 100vh;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding: 18px;
      }
      .shell {
        width: min(1180px, 100%);
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 0;
      }
      h1, h2, h3, p { margin: 0; }
      h1 { font-size: clamp(1.35rem, 3vw, 2rem); letter-spacing: 0; }
      h2 { font-size: 1.05rem; }
      h3 { font-size: 0.95rem; }
      .muted, label, .status, .empty { color: var(--muted); font-size: 0.9rem; }
      .status { min-height: 1.25rem; }
      .status.error { color: var(--danger); }
      .top-actions, .row, .tabs, .segmented { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      button, input, select, textarea {
        font: inherit;
      }
      button {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        color: var(--text);
        min-height: 40px;
        padding: 8px 12px;
        cursor: pointer;
      }
      button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
      button.primary:hover { background: var(--accent-dark); }
      button.danger { border-color: #efb4b4; color: var(--danger); background: #fff5f5; }
      button.active { background: #1f2937; border-color: #1f2937; color: #fff; }
      button:disabled { opacity: 0.55; cursor: default; }
      input, select, textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
        color: var(--text);
        padding: 10px 11px;
        min-height: 42px;
      }
      textarea { min-height: 128px; font-family: var(--mono); font-size: 0.78rem; }
      label { display: block; margin: 0 0 5px; }
      .card {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        padding: 14px;
      }
      .home-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }
      .action-card {
        min-height: 136px;
        text-align: left;
        align-items: flex-start;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 12px;
        padding: 14px;
      }
      .action-card strong { font-size: 1rem; }
      .section { display: none; }
      .section.active { display: block; }
      .section-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        margin-bottom: 12px;
      }
      .grid-2 {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 12px;
      }
      .grid-3 {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      .metric {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        padding: 12px;
        min-width: 0;
      }
      .metric strong { display: block; margin-top: 4px; font-size: 1.25rem; overflow-wrap: anywhere; }
      .form-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .full { grid-column: 1 / -1; }
      .table-wrap {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
        overflow-x: auto;
        overflow-y: auto;
        max-height: 68vh;
      }
      table {
        width: max-content;
        min-width: 100%;
        border-collapse: collapse;
      }
      th, td {
        max-width: 360px;
        min-width: 140px;
        border-bottom: 1px solid var(--line);
        padding: 9px 10px;
        text-align: left;
        vertical-align: top;
        font-size: 0.84rem;
      }
      th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--panel-2);
        color: #263532;
      }
      td code, th code {
        font-family: var(--mono);
        font-size: 0.76rem;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .workspace-list {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        max-height: 360px;
        overflow: auto;
      }
      .workspace-btn { text-align: left; min-height: 82px; }
      .workspace-btn.active { border-color: var(--accent); background: #eefaf7; }
      .pill {
        display: inline-flex;
        align-items: center;
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 2px 8px;
        color: var(--muted);
        font-size: 0.78rem;
      }
      .warning {
        border: 1px solid #f1c9c9;
        background: #fff7f7;
        color: #7f1d1d;
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 0.9rem;
      }
      .spacer { height: 8px; }
      .hidden { display: none !important; }
      @media (max-width: 860px) {
        .app { padding: 12px; }
        header, .section-head { flex-direction: column; align-items: stretch; }
        .home-grid, .grid-2, .grid-3, .form-grid, .workspace-list { grid-template-columns: 1fr; }
        .top-actions, .tabs, .segmented { align-items: stretch; }
        .top-actions button, .tabs button, .segmented button { flex: 1 1 auto; }
        th, td { min-width: 132px; max-width: 280px; }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <div class="shell">
        <header>
          <div>
            <h1>Tower Admin</h1>
            <div class="muted">Workspace operations, setup, storage, encrypted records, and Postgres inspection.</div>
          </div>
          <div class="top-actions">
            <span id="sessionPill" class="pill">Not connected</span>
            <button id="connectBtn" class="primary" type="button">Connect with Nostr</button>
            <button id="logoutBtn" type="button">Log out</button>
          </div>
        </header>

        <div id="status" class="status">Connect with the configured admin npub.</div>

        <nav class="tabs">
          <button class="nav-btn active" data-view="home" type="button">Home</button>
          <button class="nav-btn" data-view="workspace" type="button">View Workspace</button>
          <button class="nav-btn" data-view="newWorkspace" type="button">New Workspace</button>
          <button class="nav-btn" data-view="tables" type="button">Tables</button>
          <button class="nav-btn" data-view="setup" type="button">Setup</button>
          <button class="nav-btn" data-view="danger" type="button">Danger</button>
        </nav>

        <section id="view-home" class="section active">
          <div class="home-grid">
            <button class="card action-card" data-jump="workspace" type="button">
              <strong>View Workspace</strong>
              <span class="muted">Inspect usage, storage, Postgres app namespaces, and encrypted records.</span>
            </button>
            <button class="card action-card" data-jump="newWorkspace" type="button">
              <strong>New Workspace</strong>
              <span class="muted">Create a Postgres-backed Flight Deck workspace and copy its descriptor.</span>
            </button>
            <button class="card action-card" data-jump="tables" type="button">
              <strong>Browse Tables</strong>
              <span class="muted">Filter backend tables by Postgres, encrypted records, storage, or operations.</span>
            </button>
            <button class="card action-card" data-jump="setup" type="button">
              <strong>Admin Setup</strong>
              <span class="muted">Manage the Tower profile and generate encrypted/Yoke connection tokens.</span>
            </button>
          </div>
        </section>

        <section id="view-workspace" class="section">
          <div class="section-head">
            <div>
              <h2>View Workspace</h2>
              <p class="muted">Select a workspace, then switch between Postgres and encrypted-record views.</p>
            </div>
            <button id="refreshWorkspaceBtn" type="button">Refresh</button>
          </div>
          <div class="grid-2">
            <div class="card">
              <label for="workspaceSelect">Workspace</label>
              <select id="workspaceSelect"><option value="">Connect to load workspaces</option></select>
              <div id="workspaceList" class="workspace-list" style="margin-top:10px;"></div>
            </div>
            <div class="grid-3">
              <div class="metric"><span class="muted">Record storage</span><strong id="recordBytesMetric">-</strong></div>
              <div class="metric"><span class="muted">Object storage</span><strong id="objectBytesMetric">-</strong></div>
              <div class="metric"><span class="muted">Billable</span><strong id="billableMetric">-</strong></div>
            </div>
          </div>
          <div class="card" style="margin-top:12px;">
            <div class="segmented">
              <button class="workspace-mode active" data-mode="postgres" type="button">Postgres</button>
              <button class="workspace-mode" data-mode="encrypted" type="button">Encrypted Records</button>
              <button class="workspace-mode" data-mode="storage" type="button">Storage</button>
            </div>
            <div class="spacer"></div>
            <div id="workspaceSummary" class="muted">No workspace loaded.</div>
            <div class="spacer"></div>
            <div id="workspaceData"></div>
          </div>
        </section>

        <section id="view-newWorkspace" class="section">
          <div class="section-head">
            <div>
              <h2>New Workspace</h2>
              <p class="muted">Creates a Postgres-backed Flight Deck workspace using the admin setup API.</p>
            </div>
          </div>
          <div class="grid-2">
            <div class="card">
              <div class="form-grid">
                <div>
                  <label for="fdName">Workspace name</label>
                  <input id="fdName" type="text" placeholder="Acme Flight Deck">
                </div>
                <div>
                  <label for="fdAppNpub">App npub</label>
                  <input id="fdAppNpub" type="text" value="${config.flightDeck.appNpub}">
                </div>
                <div class="full">
                  <label for="fdDescription">Description</label>
                  <input id="fdDescription" type="text" placeholder="Postgres-backed Flight Deck workspace">
                </div>
                <div>
                  <label for="fdOwner">Workspace owner npub</label>
                  <input id="fdOwner" type="text" placeholder="Signed admin when blank">
                </div>
                <div>
                  <label for="fdService">Workspace service npub</label>
                  <input id="fdService" type="text" placeholder="Generated when blank">
                </div>
                <div>
                  <label for="fdScope">Optional smoke scope</label>
                  <input id="fdScope" type="text" placeholder="Leave blank for no starter scope">
                </div>
                <div>
                  <label for="fdChannel">Optional smoke channel</label>
                  <input id="fdChannel" type="text" placeholder="Leave blank for no starter channel">
                </div>
              </div>
              <div class="row" style="margin-top:12px;">
                <button id="createFdBtn" class="primary" type="button">Create Postgres Workspace</button>
                <button id="copyDescriptorBtn" type="button">Copy Descriptor</button>
              </div>
              <div class="warning" style="margin-top:12px;">Encrypted/Yoke workspaces need a prepared cryptographic bootstrap payload. Use Yoke or the documented POST /api/v4/workspaces flow for that path.</div>
            </div>
            <div class="card">
              <label for="descriptorOutput">Descriptor JSON</label>
              <textarea id="descriptorOutput" readonly placeholder="Created workspace descriptor appears here"></textarea>
              <label for="setupOutput" style="margin-top:10px;">Setup result</label>
              <textarea id="setupOutput" readonly placeholder="Workspace setup result appears here"></textarea>
            </div>
          </div>
        </section>

        <section id="view-tables" class="section">
          <div class="section-head">
            <div>
              <h2>Tables</h2>
              <p class="muted">Tables are horizontally scrollable and capped to sensible page sizes.</p>
            </div>
            <div class="row">
              <select id="tableLimit" style="width:120px;"><option value="50">50 rows</option><option value="100" selected>100 rows</option><option value="250">250 rows</option></select>
              <button id="prevTableBtn" type="button">Prev</button>
              <button id="nextTableBtn" type="button">Next</button>
            </div>
          </div>
          <div class="card">
            <div class="segmented">
              <button class="table-filter active" data-source="postgres" type="button">Postgres</button>
              <button class="table-filter" data-source="encrypted" type="button">Encrypted Records</button>
              <button class="table-filter" data-source="storage" type="button">Storage</button>
              <button class="table-filter" data-source="ops" type="button">Ops</button>
              <button class="table-filter" data-source="all" type="button">All</button>
            </div>
            <div class="form-grid" style="margin-top:12px;">
              <div>
                <label for="tableSelect">Table</label>
                <select id="tableSelect"><option value="">Connect to load tables</option></select>
              </div>
              <div>
                <label for="tableSearch">Filter table names</label>
                <input id="tableSearch" type="text" placeholder="records, messages, storage">
              </div>
            </div>
            <div id="tableSummary" class="muted" style="margin-top:10px;">No table loaded.</div>
            <div id="tableData" class="table-wrap" style="margin-top:10px;"><div class="empty" style="padding:12px;">No rows.</div></div>
          </div>
        </section>

        <section id="view-setup" class="section">
          <div class="section-head">
            <div>
              <h2>Admin Setup</h2>
              <p class="muted">Tower profile and encrypted/Yoke connection-token generation.</p>
            </div>
          </div>
          <div class="grid-2">
            <div class="card">
              <h3>Tower Profile</h3>
              <label for="towerName">Tower name</label>
              <input id="towerName" type="text" placeholder="My Tower">
              <label for="towerDescription" style="margin-top:10px;">Tower description</label>
              <textarea id="towerDescription" placeholder="Shared workspace backend"></textarea>
              <div class="row" style="margin-top:12px;">
                <button id="saveTowerBtn" class="primary" type="button">Save Profile</button>
              </div>
            </div>
            <div class="card">
              <h3>Encrypted/Yoke Connection Token</h3>
              <label for="tokenWorkspace">Workspace</label>
              <select id="tokenWorkspace"><option value="">Select workspace</option></select>
              <label for="tokenAppNpub" style="margin-top:10px;">App npub</label>
              <input id="tokenAppNpub" type="text" placeholder="npub1...">
              <div class="row" style="margin-top:12px;">
                <button id="generateTokenBtn" class="primary" type="button">Generate Token</button>
                <button id="copyTokenBtn" type="button">Copy Token</button>
              </div>
              <label for="tokenOutput" style="margin-top:10px;">Token</label>
              <textarea id="tokenOutput" readonly></textarea>
            </div>
          </div>
        </section>

        <section id="view-danger" class="section">
          <div class="card">
            <h2>Danger Zone</h2>
            <p class="muted" style="margin-top:6px;">Delete selected workspace database rows or reset Tower V4 SQL rows. These actions do not remove object-storage blobs or restart the service.</p>
            <div class="warning" style="margin-top:12px;">Bulk delete uses explicit checked workspace IDs only. Filtering by name helps find noisy test data, but it does not delete by prefix.</div>
            <div style="margin-top:14px;">
              <h3>Bulk Delete Workspaces</h3>
              <div class="form-grid" style="margin-top:10px;">
                <div>
                  <label for="bulkWorkspaceFilter">Filter workspace names</label>
                  <input id="bulkWorkspaceFilter" type="text" placeholder="test prefix or name">
                </div>
                <div>
                  <label for="bulkFilterMode">Filter mode</label>
                  <select id="bulkFilterMode">
                    <option value="contains">Contains</option>
                    <option value="starts">Starts with</option>
                  </select>
                </div>
              </div>
              <div class="row" style="margin-top:12px;">
                <label class="row" style="margin:0;"><input id="bulkDeleteFdPgRows" type="checkbox" checked style="width:auto;min-height:auto;"> Delete Postgres workspace rows</label>
                <label class="row" style="margin:0;"><input id="bulkDeleteStorageMetadata" type="checkbox" checked style="width:auto;min-height:auto;"> Delete storage metadata rows</label>
              </div>
              <div class="row" style="margin-top:12px;">
                <button id="bulkSelectVisibleBtn" type="button">Select Visible</button>
                <button id="bulkClearSelectionBtn" type="button">Clear Selection</button>
                <button id="bulkPreviewBtn" type="button">Preview Delete</button>
              </div>
              <div id="bulkWorkspaceResults" style="margin-top:12px;"></div>
              <label for="bulkDeleteConfirmation" style="margin-top:12px;">Confirm bulk delete phrase</label>
              <input id="bulkDeleteConfirmation" type="text" placeholder="DELETE 0 WORKSPACES">
              <div class="row" style="margin-top:12px;">
                <button id="bulkDeleteBtn" class="danger" type="button">Delete Checked Workspace Rows</button>
              </div>
              <textarea id="bulkDeleteOutput" readonly style="margin-top:12px;" placeholder="Bulk delete preview/result appears here"></textarea>
            </div>
            <div class="warning" style="margin-top:18px;">Single workspace delete removes selected workspace rows from Postgres. Type the workspace owner npub exactly before deleting.</div>
            <div class="form-grid" style="margin-top:12px;">
              <div>
                <label for="deleteWorkspaceSelect">Workspace</label>
                <select id="deleteWorkspaceSelect"><option value="">Select workspace</option></select>
              </div>
              <div>
                <label for="deleteWorkspaceConfirmation">Confirm owner npub</label>
                <input id="deleteWorkspaceConfirmation" type="text" placeholder="npub1...">
              </div>
            </div>
            <div class="row" style="margin-top:12px;">
              <label class="row" style="margin:0;"><input id="deleteFdPgRows" type="checkbox" checked style="width:auto;min-height:auto;"> Delete Postgres workspace rows</label>
              <label class="row" style="margin:0;"><input id="deleteStorageMetadata" type="checkbox" checked style="width:auto;min-height:auto;"> Delete storage metadata rows</label>
            </div>
            <div class="row" style="margin-top:12px;">
              <button id="deleteWorkspaceBtn" class="danger" type="button">Delete Selected Workspace Rows</button>
            </div>
            <textarea id="deleteWorkspaceOutput" readonly style="margin-top:12px;" placeholder="Workspace delete result appears here"></textarea>
            <div class="warning" style="margin-top:18px;">Full reset clears workspace, group, record, storage metadata, billing, app, and Flight Deck PG rows from Postgres.</div>
            <label for="resetConfirmation" style="margin-top:12px;">Type WIPE V4 DATA</label>
            <input id="resetConfirmation" type="text" placeholder="WIPE V4 DATA">
            <div class="row" style="margin-top:12px;">
              <button id="resetBtn" class="danger" type="button">Reset Database Rows</button>
            </div>
            <textarea id="resetOutput" readonly style="margin-top:12px;" placeholder="Reset result appears here"></textarea>
          </div>
        </section>
      </div>
    </div>

    <script type="module">
      const API_BASE = ${JSON.stringify(apiBaseUrl)};
      const SESSION_KEY = 'tower-admin-session-v1';
      const state = {
        pubkey: null,
        npub: null,
        tables: [],
        tableSource: 'postgres',
        activeTable: '',
        tableLimit: 100,
        tableOffset: 0,
        workspaces: [],
        activeWorkspaceId: '',
        workspaceMode: 'postgres',
        workspaceInspect: null,
        bulkSelectedWorkspaceIds: new Set(),
        bulkPreview: null,
      };
      const el = (id) => document.getElementById(id);
      const els = {
        status: el('status'),
        sessionPill: el('sessionPill'),
        connectBtn: el('connectBtn'),
        logoutBtn: el('logoutBtn'),
        workspaceSelect: el('workspaceSelect'),
        workspaceList: el('workspaceList'),
        workspaceSummary: el('workspaceSummary'),
        workspaceData: el('workspaceData'),
        recordBytesMetric: el('recordBytesMetric'),
        objectBytesMetric: el('objectBytesMetric'),
        billableMetric: el('billableMetric'),
        tableSelect: el('tableSelect'),
        tableSearch: el('tableSearch'),
        tableSummary: el('tableSummary'),
        tableData: el('tableData'),
        tableLimit: el('tableLimit'),
        descriptorOutput: el('descriptorOutput'),
        setupOutput: el('setupOutput'),
        tokenOutput: el('tokenOutput'),
        resetOutput: el('resetOutput'),
      };

      function setStatus(message, isError) {
        els.status.textContent = message;
        els.status.className = isError ? 'status error' : 'status';
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
      }

      function short(value) {
        const text = String(value || '');
        return text.length > 24 ? text.slice(0, 13) + '...' + text.slice(-8) : text;
      }

      function formatDate(value) {
        if (!value) return '-';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
      }

      function formatBytes(value) {
        let amount = Number(value || 0);
        if (!Number.isFinite(amount) || amount <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let unit = 0;
        while (amount >= 1024 && unit < units.length - 1) {
          amount = amount / 1024;
          unit += 1;
        }
        return amount.toFixed(amount >= 10 || unit === 0 ? 0 : 1) + ' ' + units[unit];
      }

      function normalizeCell(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') return JSON.stringify(value, null, 2);
        return String(value);
      }

      function saveSession() {
        if (!state.pubkey || !state.npub) return;
        localStorage.setItem(SESSION_KEY, JSON.stringify({ pubkey: state.pubkey, npub: state.npub }));
        renderSession();
      }

      function restoreSession() {
        try {
          const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
          if (saved && saved.pubkey && saved.npub) {
            state.pubkey = saved.pubkey;
            state.npub = saved.npub;
          }
        } catch {}
        renderSession();
      }

      function clearSession() {
        localStorage.removeItem(SESSION_KEY);
        state.pubkey = null;
        state.npub = null;
        state.workspaces = [];
        state.tables = [];
        state.workspaceInspect = null;
        renderSession();
        renderWorkspaces();
        renderTableSelect();
        setStatus('Logged out.');
      }

      function renderSession() {
        els.sessionPill.textContent = state.npub ? 'Admin ' + short(state.npub) : 'Not connected';
      }

      async function npubFromHex(pubkeyHex) {
        const mod = await import('https://esm.sh/nostr-tools@2.17.0/nip19');
        return mod.npubEncode(pubkeyHex);
      }

      async function sha256Hex(input) {
        const bytes = new TextEncoder().encode(input);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      }

      function base64Json(value) {
        const raw = JSON.stringify(value);
        const bytes = new TextEncoder().encode(raw);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      }

      async function connect() {
        if (!window.nostr) throw new Error('Nostr extension not available');
        const pubkey = await window.nostr.getPublicKey();
        state.pubkey = pubkey;
        state.npub = await npubFromHex(pubkey);
        saveSession();
        await loadAdmin();
      }

      async function signAuth(url, method, body) {
        if (!window.nostr) throw new Error('Nostr extension not available');
        if (!state.pubkey) {
          state.pubkey = await window.nostr.getPublicKey();
          state.npub = await npubFromHex(state.pubkey);
          saveSession();
        }
        const tags = [['u', url], ['method', method.toUpperCase()]];
        if (body && method.toUpperCase() !== 'GET') tags.push(['payload', await sha256Hex(body)]);
        const event = await window.nostr.signEvent({
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: '',
        });
        return 'Nostr ' + base64Json(event);
      }

      async function api(path, method, body) {
        const verb = method || 'GET';
        const url = API_BASE + path;
        const payload = body === undefined ? '' : JSON.stringify(body);
        const auth = await signAuth(url, verb, payload);
        const res = await fetch(url, {
          method: verb,
          headers: { Authorization: auth, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
          ...(payload ? { body: payload } : {}),
        });
        const text = await res.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
        if (!res.ok) throw new Error(data.error || text || 'Request failed');
        return data;
      }

      async function loadAdmin() {
        setStatus('Loading admin data...');
        const tables = await api('/api/v4/admin/tables');
        const workspaces = await api('/api/v4/admin/workspaces');
        const tower = await api('/api/v4/admin/tower');
        state.tables = tables.tables || [];
        state.workspaces = workspaces.workspaces || [];
        el('towerName').value = tower.tower_name || '';
        el('towerDescription').value = tower.tower_description || '';
        renderWorkspaces();
        renderTableSelect();
        setStatus('Connected as ' + (state.npub || tables.viewer));
      }

      function switchView(name) {
        document.querySelectorAll('.section').forEach((section) => section.classList.toggle('active', section.id === 'view-' + name));
        document.querySelectorAll('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
      }

      function renderWorkspaces() {
        els.workspaceSelect.innerHTML = '<option value="">Select a workspace</option>';
        el('tokenWorkspace').innerHTML = '<option value="">Select a workspace</option>';
        el('deleteWorkspaceSelect').innerHTML = '<option value="">Select workspace</option>';
        els.workspaceList.innerHTML = '';
        if (!state.workspaces.length) {
          els.workspaceList.innerHTML = '<div class="empty">No workspaces loaded.</div>';
        }
        for (const workspace of state.workspaces) {
          const pgLabel = workspace.backend === 'flightdeck_pg' ? ' [PG]' : '';
          const option = document.createElement('option');
          option.value = workspace.workspace_id;
          option.textContent = workspace.name + pgLabel + ' | ' + short(workspace.workspace_owner_npub);
          els.workspaceSelect.appendChild(option);
          el('tokenWorkspace').appendChild(option.cloneNode(true));
          el('deleteWorkspaceSelect').appendChild(option.cloneNode(true));

          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'workspace-btn' + (state.activeWorkspaceId === workspace.workspace_id ? ' active' : '');
          button.innerHTML = '<strong>' + escapeHtml(workspace.name || '(unnamed)') + '</strong>' + (pgLabel ? ' <span class="pill">PG</span>' : '') + '<br><span class="muted">' + escapeHtml(short(workspace.workspace_owner_npub)) + '</span><br><span class="muted">' + escapeHtml(formatDate(workspace.updated_at)) + '</span>';
          button.addEventListener('click', () => selectWorkspace(workspace.workspace_id).catch((error) => setStatus(error.message, true)));
          els.workspaceList.appendChild(button);
        }
        els.workspaceSelect.value = state.activeWorkspaceId || '';
        renderBulkWorkspaceResults();
      }

      function bulkFilteredWorkspaces() {
        const filterEl = el('bulkWorkspaceFilter');
        const modeEl = el('bulkFilterMode');
        const query = String(filterEl?.value || '').trim().toLowerCase();
        const mode = String(modeEl?.value || 'contains');
        if (!query) return [];
        return state.workspaces.filter((workspace) => {
          const name = String(workspace.name || '').toLowerCase();
          return mode === 'starts' ? name.startsWith(query) : name.includes(query);
        });
      }

      function selectedBulkWorkspaceIds() {
        return Array.from(state.bulkSelectedWorkspaceIds).filter((workspaceId) => state.workspaces.some((workspace) => workspace.workspace_id === workspaceId));
      }

      function bulkConfirmationPhrase() {
        return 'DELETE ' + selectedBulkWorkspaceIds().length + ' WORKSPACES';
      }

      function renderBulkWorkspaceResults() {
        const container = el('bulkWorkspaceResults');
        if (!container) return;
        const currentIds = new Set(state.workspaces.map((workspace) => workspace.workspace_id));
        for (const workspaceId of Array.from(state.bulkSelectedWorkspaceIds)) {
          if (!currentIds.has(workspaceId)) state.bulkSelectedWorkspaceIds.delete(workspaceId);
        }
        const selectedIds = selectedBulkWorkspaceIds();
        const confirmationInput = el('bulkDeleteConfirmation');
        if (confirmationInput) confirmationInput.placeholder = bulkConfirmationPhrase();
        const query = String(el('bulkWorkspaceFilter')?.value || '').trim();
        if (!query) {
          container.innerHTML = '<div class="empty" style="padding:12px;">Enter a name filter to list workspaces. Selected: ' + selectedIds.length + '.</div>';
          return;
        }
        const rows = bulkFilteredWorkspaces();
        if (!rows.length) {
          container.innerHTML = '<div class="empty" style="padding:12px;">No matching workspaces. Selected: ' + selectedIds.length + '.</div>';
          return;
        }
        const body = rows.map((workspace) => {
          const checked = state.bulkSelectedWorkspaceIds.has(workspace.workspace_id) ? ' checked' : '';
          return '<tr>' +
            '<td><input class="bulk-workspace-checkbox" data-workspace-id="' + escapeHtml(workspace.workspace_id) + '" type="checkbox" style="width:auto;min-height:auto;"' + checked + '></td>' +
            '<td><code>' + escapeHtml(workspace.name || '(unnamed)') + '</code></td>' +
            '<td><code>' + escapeHtml(short(workspace.workspace_owner_npub)) + '</code></td>' +
            '<td><code>' + escapeHtml(formatDate(workspace.updated_at)) + '</code></td>' +
            '<td><code>' + escapeHtml(workspace.workspace_id) + '</code></td>' +
            '</tr>';
        }).join('');
        container.innerHTML = '<div class="muted" style="margin-bottom:8px;">Visible: ' + rows.length + ' | Selected: ' + selectedIds.length + ' | Confirmation: <code>' + escapeHtml(bulkConfirmationPhrase()) + '</code></div>' +
          '<div class="table-wrap"><table><thead><tr><th>Select</th><th>Name</th><th>Owner</th><th>Updated</th><th>Workspace ID</th></tr></thead><tbody>' + body + '</tbody></table></div>';
        container.querySelectorAll('.bulk-workspace-checkbox').forEach((checkbox) => {
          checkbox.addEventListener('change', () => {
            const workspaceId = checkbox.dataset.workspaceId || '';
            if (checkbox.checked) state.bulkSelectedWorkspaceIds.add(workspaceId);
            else state.bulkSelectedWorkspaceIds.delete(workspaceId);
            state.bulkPreview = null;
            renderBulkWorkspaceResults();
          });
        });
      }

      async function selectWorkspace(workspaceId) {
        state.activeWorkspaceId = workspaceId;
        els.workspaceSelect.value = workspaceId;
        renderWorkspaces();
        if (!workspaceId) {
          state.workspaceInspect = null;
          renderWorkspaceInspect();
          return;
        }
        setStatus('Loading workspace...');
        state.workspaceInspect = await api('/api/v4/admin/workspaces/' + encodeURIComponent(workspaceId) + '/inspect?limit=100');
        renderWorkspaceInspect();
        setStatus('Workspace loaded.');
      }

      function renderWorkspaceInspect() {
        const payload = state.workspaceInspect;
        if (!payload) {
          els.recordBytesMetric.textContent = '-';
          els.objectBytesMetric.textContent = '-';
          els.billableMetric.textContent = '-';
          els.workspaceSummary.textContent = 'No workspace loaded.';
          els.workspaceData.innerHTML = '<div class="empty">Select a workspace.</div>';
          return;
        }
        const workspace = payload.workspace;
        const usage = payload.usage || {};
        els.recordBytesMetric.textContent = formatBytes(usage.record_bytes);
        els.objectBytesMetric.textContent = formatBytes(usage.object_bytes);
        els.billableMetric.textContent = formatBytes(usage.billable_bytes);
        els.workspaceSummary.innerHTML = '<strong>' + escapeHtml(workspace.name) + '</strong> <span class="pill">' + escapeHtml(short(workspace.workspace_owner_npub)) + '</span>' + (workspace.backend === 'flightdeck_pg' ? ' <span class="pill">Flight Deck PG</span>' : '') + '<br>Updated ' + escapeHtml(formatDate(workspace.updated_at));
        if (payload.pg) {
          renderFlightDeckPgWorkspace(payload);
          return;
        }
        if (state.workspaceMode === 'postgres') renderPostgresWorkspace(payload);
        if (state.workspaceMode === 'encrypted') renderEncryptedWorkspace(payload);
        if (state.workspaceMode === 'storage') renderStorageWorkspace(payload);
      }

      function renderFlightDeckPgWorkspace(payload) {
        const members = (payload.pg && payload.pg.members) || [];
        const counts = (payload.pg && payload.pg.counts) || {};
        const countRows = Object.keys(counts).map((key) => ({ table: key, count: counts[key] }));
        els.workspaceData.innerHTML =
          '<h3>Members</h3>' +
          table([
            { label: 'Npub', value: (row) => row.npub },
            { label: 'Name', value: (row) => row.display_name || '-' },
            { label: 'Kind', value: (row) => row.kind },
            { label: 'Role', value: (row) => row.role },
          ], members) +
          '<div class="spacer"></div><h3>Row Counts</h3>' +
          table([
            { label: 'Table', value: (row) => row.table.replace('flightdeck_pg_', '') },
            { label: 'Rows', value: (row) => String(row.count) },
          ], countRows);
      }

      function table(headers, rows) {
        if (!rows || rows.length === 0) return '<div class="empty" style="padding:12px;">No rows.</div>';
        const head = headers.map((header) => '<th>' + escapeHtml(header.label) + '</th>').join('');
        const body = rows.map((row) => '<tr>' + headers.map((header) => '<td><code>' + escapeHtml(header.value(row)) + '</code></td>').join('') + '</tr>').join('');
        return '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
      }

      function renderPostgresWorkspace(payload) {
        const apps = payload.apps || [];
        const schemas = payload.app_schemas || [];
        const schemaCounts = new Map();
        for (const schema of schemas) schemaCounts.set(schema.app_npub, (schema.record_families || []).length);
        els.workspaceData.innerHTML = table([
          { label: 'App npub', value: (row) => row.app_npub },
          { label: 'Name', value: (row) => row.app_name },
          { label: 'Enabled', value: (row) => row.enabled ? 'yes' : 'no' },
          { label: 'Capabilities', value: (row) => (row.capabilities || []).join(', ') },
          { label: 'Schema families', value: (row) => schemaCounts.get(row.app_npub) || 0 },
          { label: 'Updated', value: (row) => formatDate(row.updated_at) },
        ], apps);
      }

      function renderEncryptedWorkspace(payload) {
        const families = payload.record_families || [];
        const records = (payload.records && payload.records.records) || [];
        els.workspaceData.innerHTML =
          '<h3>Record Families</h3>' +
          table([
            { label: 'Family', value: (row) => row.record_family_hash },
            { label: 'App Space', value: (row) => row.app_namespace || '-' },
            { label: 'Collection', value: (row) => row.collection_space || '-' },
            { label: 'Records', value: (row) => row.latest_record_count },
            { label: 'Versions', value: (row) => row.total_versions },
            { label: 'Bytes', value: (row) => row.total_bytes + ' (' + formatBytes(row.total_bytes) + ')' },
            { label: 'Updated', value: (row) => formatDate(row.latest_updated_at) },
          ], families) +
          '<div class="spacer"></div><h3>Encrypted Records</h3>' +
          table([
            { label: 'Record ID', value: (row) => row.record_id },
            { label: 'Family', value: (row) => row.record_family_hash },
            { label: 'Latest Version', value: (row) => row.latest_version },
            { label: 'Versions', value: (row) => row.total_versions },
            { label: 'Ciphertext bytes', value: (row) => row.owner_ciphertext_bytes + ' owner / ' + row.group_payload_bytes + ' group' },
            { label: 'Signer', value: (row) => row.signature_npub },
            { label: 'Updated', value: (row) => formatDate(row.latest_updated_at) },
          ], records);
      }

      function renderStorageWorkspace(payload) {
        const rows = (payload.storage && payload.storage.objects) || [];
        els.workspaceData.innerHTML = table([
          { label: 'Object', value: (row) => row.object_id },
          { label: 'File', value: (row) => row.file_name || '-' },
          { label: 'Content Type', value: (row) => row.content_type },
          { label: 'Bytes', value: (row) => row.size_bytes + ' (' + formatBytes(row.size_bytes) + ')' },
          { label: 'Public', value: (row) => row.is_public ? 'yes' : 'no' },
          { label: 'Completed', value: (row) => row.completed_at ? formatDate(row.completed_at) : 'pending' },
          { label: 'Creator', value: (row) => row.created_by_npub },
        ], rows);
      }

      function tableSource(tableName) {
        if (tableName.startsWith('flightdeck_pg_')) return 'postgres';
        if (['workspace_apps', 'workspace_app_schema_manifests', 'workspace_app_schema_group_payloads', 'workspace_app_rows', 'workspace_app_db_namespaces'].includes(tableName)) return 'postgres';
        if (['v4_records', 'v4_record_group_payloads', 'v4_record_checkouts', 'v4_groups', 'v4_group_epochs', 'v4_group_members', 'v4_group_member_keys', 'v4_workspaces', 'user_workspace_keys'].includes(tableName)) return 'encrypted';
        if (tableName === 'v4_storage_objects') return 'storage';
        return 'ops';
      }

      function filteredTables() {
        const search = String(els.tableSearch.value || '').trim().toLowerCase();
        return state.tables.filter((table) => {
          const sourceMatch = state.tableSource === 'all' || tableSource(table.table) === state.tableSource;
          const searchMatch = !search || table.table.toLowerCase().includes(search);
          return sourceMatch && searchMatch;
        });
      }

      function renderTableSelect() {
        const tables = filteredTables();
        els.tableSelect.innerHTML = '';
        if (!tables.length) {
          els.tableSelect.innerHTML = '<option value="">No matching tables</option>';
          return;
        }
        if (!tables.some((table) => table.table === state.activeTable)) state.activeTable = tables[0].table;
        for (const table of tables) {
          const option = document.createElement('option');
          option.value = table.table;
          option.textContent = table.table + ' (' + table.row_count + ')';
          els.tableSelect.appendChild(option);
        }
        els.tableSelect.value = state.activeTable;
      }

      async function loadTable() {
        if (!state.activeTable) return;
        setStatus('Loading table ' + state.activeTable + '...');
        const payload = await api('/api/v4/admin/tables/' + encodeURIComponent(state.activeTable) + '?limit=' + state.tableLimit + '&offset=' + state.tableOffset);
        const columns = payload.columns || [];
        const rows = payload.rows || [];
        els.tableSummary.textContent = payload.table + ': ' + payload.row_count + ' rows total, offset ' + payload.offset;
        if (!rows.length) {
          els.tableData.innerHTML = '<div class="empty" style="padding:12px;">No rows on this page.</div>';
        } else {
          const head = columns.map((column) => '<th>' + escapeHtml(column.column_name) + '<br><code>' + escapeHtml(column.data_type) + '</code></th>').join('');
          const body = rows.map((row) => '<tr>' + columns.map((column) => '<td><code>' + escapeHtml(normalizeCell(row[column.column_name])) + '</code></td>').join('') + '</tr>').join('');
          els.tableData.innerHTML = '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
        }
        setStatus('Table loaded.');
      }

      async function createFdWorkspace() {
        const workspaceName = String(el('fdName').value || '').trim();
        if (!workspaceName) throw new Error('Workspace name required');
        const payload = await api('/api/v4/admin/flightdeck-pg/workspaces', 'POST', {
          workspace_name: workspaceName,
          workspace_description: String(el('fdDescription').value || '').trim() || null,
          app_npub: String(el('fdAppNpub').value || '').trim(),
          workspace_owner_npub: String(el('fdOwner').value || '').trim() || null,
          workspace_service_npub: String(el('fdService').value || '').trim() || null,
          smoke_scope_name: String(el('fdScope').value || '').trim() || null,
          smoke_channel_name: String(el('fdChannel').value || '').trim() || null,
        });
        els.descriptorOutput.value = JSON.stringify(payload.descriptor || {}, null, 2);
        els.setupOutput.value = JSON.stringify({
          workspace_id: payload.workspace_id,
          descriptor_route: payload.descriptor_route,
          groups: payload.groups,
          smoke: payload.smoke,
          actors: payload.actors,
        }, null, 2);
        await loadAdmin();
        setStatus('Postgres workspace created.');
      }

      async function saveTowerProfile() {
        await api('/api/v4/admin/tower', 'PATCH', {
          tower_name: String(el('towerName').value || '').trim() || null,
          tower_description: String(el('towerDescription').value || '').trim() || null,
        });
        setStatus('Tower profile saved.');
      }

      async function generateToken() {
        const workspaceId = el('tokenWorkspace').value;
        const appNpub = String(el('tokenAppNpub').value || '').trim();
        if (!workspaceId) throw new Error('Select a workspace first');
        if (!appNpub) throw new Error('App npub required');
        const payload = await api('/api/v4/admin/workspaces/' + encodeURIComponent(workspaceId) + '/connection-token?app_npub=' + encodeURIComponent(appNpub));
        els.tokenOutput.value = payload.connection_token || '';
        setStatus('Connection token generated.');
      }

      function bulkDeleteOptions() {
        const deleteFlightDeckPg = el('bulkDeleteFdPgRows').checked;
        const deleteStorageMetadata = el('bulkDeleteStorageMetadata').checked;
        if (deleteStorageMetadata && !deleteFlightDeckPg) {
          throw new Error('Storage metadata delete requires deleting Postgres workspace rows first');
        }
        return {
          delete_flightdeck_pg: deleteFlightDeckPg,
          delete_storage_metadata: deleteStorageMetadata,
        };
      }

      async function previewBulkWorkspaceDelete() {
        const workspaceIds = selectedBulkWorkspaceIds();
        if (!workspaceIds.length) throw new Error('Check at least one workspace first');
        const payload = await api('/api/v4/admin/workspaces/delete-preview', 'POST', {
          workspace_ids: workspaceIds,
          ...bulkDeleteOptions(),
        });
        state.bulkPreview = payload;
        el('bulkDeleteOutput').value = JSON.stringify(payload, null, 2);
        el('bulkDeleteConfirmation').placeholder = payload.confirmation_required || bulkConfirmationPhrase();
        setStatus('Bulk delete preview loaded.');
      }

      async function bulkDeleteWorkspaceRows() {
        const workspaceIds = selectedBulkWorkspaceIds();
        if (!workspaceIds.length) throw new Error('Check at least one workspace first');
        const confirmationRequired = bulkConfirmationPhrase();
        const confirmation = String(el('bulkDeleteConfirmation').value || '').trim();
        if (confirmation !== confirmationRequired) throw new Error('Type ' + confirmationRequired + ' exactly');
        const names = state.workspaces
          .filter((workspace) => workspaceIds.includes(workspace.workspace_id))
          .map((workspace) => workspace.name || workspace.workspace_id)
          .join(', ');
        if (!window.confirm('Delete database rows for ' + workspaceIds.length + ' workspaces: ' + names + '?')) return;
        const payload = await api('/api/v4/admin/workspaces/bulk-delete', 'POST', {
          workspace_ids: workspaceIds,
          confirmation,
          ...bulkDeleteOptions(),
        });
        el('bulkDeleteOutput').value = JSON.stringify(payload, null, 2);
        if (workspaceIds.includes(state.activeWorkspaceId)) {
          state.activeWorkspaceId = '';
          state.workspaceInspect = null;
          renderWorkspaceInspect();
        }
        state.bulkSelectedWorkspaceIds.clear();
        state.bulkPreview = null;
        el('bulkDeleteConfirmation').value = '';
        await loadAdmin();
        setStatus('Bulk workspace database rows deleted.');
      }

      async function deleteWorkspaceRows() {
        const workspaceId = el('deleteWorkspaceSelect').value;
        if (!workspaceId) throw new Error('Select a workspace first');
        const workspace = state.workspaces.find((entry) => entry.workspace_id === workspaceId);
        if (!workspace) throw new Error('Selected workspace is not loaded');
        const confirmation = String(el('deleteWorkspaceConfirmation').value || '').trim();
        if (confirmation !== workspace.workspace_owner_npub) throw new Error('Confirmation must match the workspace owner npub');
        const deleteFlightDeckPg = el('deleteFdPgRows').checked;
        const deleteStorageMetadata = el('deleteStorageMetadata').checked;
        if (deleteStorageMetadata && !deleteFlightDeckPg) {
          throw new Error('Storage metadata delete requires deleting Postgres workspace rows first');
        }
        if (!window.confirm('Delete database rows for ' + workspace.name + '?')) return;
        const payload = await api('/api/v4/admin/workspaces/' + encodeURIComponent(workspaceId), 'DELETE', {
          confirmation,
          delete_flightdeck_pg: deleteFlightDeckPg,
          delete_storage_metadata: deleteStorageMetadata,
        });
        el('deleteWorkspaceOutput').value = JSON.stringify(payload, null, 2);
        if (state.activeWorkspaceId === workspaceId) {
          state.activeWorkspaceId = '';
          state.workspaceInspect = null;
          renderWorkspaceInspect();
        }
        await loadAdmin();
        setStatus('Workspace database rows deleted.');
      }

      async function resetDatabase() {
        const confirmation = String(el('resetConfirmation').value || '').trim();
        if (confirmation !== 'WIPE V4 DATA') throw new Error('Type WIPE V4 DATA exactly');
        if (!window.confirm('This deletes Tower SQL rows. Continue?')) return;
        const payload = await api('/api/v4/admin/reset-database', 'POST', { confirmation });
        els.resetOutput.value = JSON.stringify(payload, null, 2);
        state.activeWorkspaceId = '';
        await loadAdmin();
        setStatus('Database rows reset.');
      }

      document.querySelectorAll('.nav-btn').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
      document.querySelectorAll('[data-jump]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.jump)));
      document.querySelectorAll('.workspace-mode').forEach((button) => button.addEventListener('click', () => {
        state.workspaceMode = button.dataset.mode;
        document.querySelectorAll('.workspace-mode').forEach((item) => item.classList.toggle('active', item === button));
        renderWorkspaceInspect();
      }));
      document.querySelectorAll('.table-filter').forEach((button) => button.addEventListener('click', () => {
        state.tableSource = button.dataset.source;
        state.tableOffset = 0;
        document.querySelectorAll('.table-filter').forEach((item) => item.classList.toggle('active', item === button));
        renderTableSelect();
        loadTable().catch((error) => setStatus(error.message, true));
      }));
      els.connectBtn.addEventListener('click', () => connect().catch((error) => setStatus(error.message, true)));
      els.logoutBtn.addEventListener('click', clearSession);
      el('refreshWorkspaceBtn').addEventListener('click', () => selectWorkspace(state.activeWorkspaceId).catch((error) => setStatus(error.message, true)));
      els.workspaceSelect.addEventListener('change', () => selectWorkspace(els.workspaceSelect.value).catch((error) => setStatus(error.message, true)));
      els.tableSelect.addEventListener('change', () => {
        state.activeTable = els.tableSelect.value;
        state.tableOffset = 0;
        loadTable().catch((error) => setStatus(error.message, true));
      });
      els.tableSearch.addEventListener('input', () => {
        renderTableSelect();
      });
      els.tableLimit.addEventListener('change', () => {
        state.tableLimit = Number.parseInt(els.tableLimit.value, 10) || 100;
        state.tableOffset = 0;
        loadTable().catch((error) => setStatus(error.message, true));
      });
      el('prevTableBtn').addEventListener('click', () => {
        state.tableOffset = Math.max(0, state.tableOffset - state.tableLimit);
        loadTable().catch((error) => setStatus(error.message, true));
      });
      el('nextTableBtn').addEventListener('click', () => {
        state.tableOffset += state.tableLimit;
        loadTable().catch((error) => setStatus(error.message, true));
      });
      el('createFdBtn').addEventListener('click', () => createFdWorkspace().catch((error) => setStatus(error.message, true)));
      el('copyDescriptorBtn').addEventListener('click', async () => {
        if (els.descriptorOutput.value) await navigator.clipboard.writeText(els.descriptorOutput.value);
        setStatus('Descriptor copied.');
      });
      el('saveTowerBtn').addEventListener('click', () => saveTowerProfile().catch((error) => setStatus(error.message, true)));
      el('generateTokenBtn').addEventListener('click', () => generateToken().catch((error) => setStatus(error.message, true)));
      el('copyTokenBtn').addEventListener('click', async () => {
        if (els.tokenOutput.value) await navigator.clipboard.writeText(els.tokenOutput.value);
        setStatus('Token copied.');
      });
      el('bulkWorkspaceFilter').addEventListener('input', () => renderBulkWorkspaceResults());
      el('bulkFilterMode').addEventListener('change', () => renderBulkWorkspaceResults());
      el('bulkSelectVisibleBtn').addEventListener('click', () => {
        const rows = bulkFilteredWorkspaces();
        if (!rows.length) {
          setStatus('No visible workspaces to select.', true);
          return;
        }
        for (const workspace of rows) state.bulkSelectedWorkspaceIds.add(workspace.workspace_id);
        state.bulkPreview = null;
        renderBulkWorkspaceResults();
        setStatus('Visible workspaces selected.');
      });
      el('bulkClearSelectionBtn').addEventListener('click', () => {
        state.bulkSelectedWorkspaceIds.clear();
        state.bulkPreview = null;
        el('bulkDeleteConfirmation').value = '';
        renderBulkWorkspaceResults();
        setStatus('Bulk selection cleared.');
      });
      el('bulkPreviewBtn').addEventListener('click', () => previewBulkWorkspaceDelete().catch((error) => setStatus(error.message, true)));
      el('bulkDeleteBtn').addEventListener('click', () => bulkDeleteWorkspaceRows().catch((error) => setStatus(error.message, true)));
      el('deleteWorkspaceBtn').addEventListener('click', () => deleteWorkspaceRows().catch((error) => setStatus(error.message, true)));
      el('resetBtn').addEventListener('click', () => resetDatabase().catch((error) => setStatus(error.message, true)));

      restoreSession();
      if (state.pubkey) {
        loadAdmin().catch((error) => setStatus('Saved login restored, but refresh failed: ' + error.message, true));
      }
    </script>
  </body>
</html>`;
}

function tableViewerHtml(apiBaseUrl: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SuperBased V4 Table Viewer</title>
    <style>
      :root {
        --bg: #f6f1e5;
        --panel: #fffdf8;
        --panel-alt: #f3ecdf;
        --line: #d8cfbf;
        --text: #221c16;
        --muted: #6a6258;
        --accent: #0f766e;
        --danger: #b91c1c;
        --mono: "SFMono-Regular", "Menlo", monospace;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, sans-serif;
        background: linear-gradient(180deg, #f8f3e8 0%, #efe6d4 100%);
        color: var(--text);
      }
      .viewer { display: grid; grid-template-columns: 320px minmax(0, 1fr); min-height: 100vh; }
      .sidebar { border-right: 1px solid var(--line); padding: 1rem; background: rgba(255,255,255,0.6); }
      .content { padding: 1rem 1.25rem 2rem; }
      .stack { display: flex; flex-direction: column; gap: 1rem; }
      h1 { margin: 0 0 0.35rem; font-size: 1.2rem; }
      .lede, .meta, .empty, .status { color: var(--muted); font-size: 0.9rem; }
      .status { margin: 0.75rem 0 1rem; min-height: 1.25rem; }
      .status.error { color: var(--danger); }
      .connect, .pager-btn, .limit-select {
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--text);
        border-radius: 10px;
        padding: 0.5rem 0.75rem;
      }
      .connect { border-radius: 999px; cursor: pointer; }
      .danger-btn {
        border-color: #f0b7b7;
        background: #fff1f1;
        color: var(--danger);
      }
      .warning {
        margin-top: 0.6rem;
        padding: 0.75rem;
        border-radius: 12px;
        border: 1px solid #f0b7b7;
        background: #fff4f4;
        color: #7f1d1d;
        font-size: 0.84rem;
      }
      .next-step {
        margin-top: 0.6rem;
        padding: 0.65rem 0.75rem;
        border: 1px solid #99d5c9;
        border-radius: 10px;
        background: #ecfdf5;
        color: #064e3b;
        font-size: 0.84rem;
      }
      .table-list { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem; }
      .panel {
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 14px;
        padding: 0.85rem;
      }
      .panel h2 { margin: 0 0 0.5rem; font-size: 0.98rem; }
      .field { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.6rem; }
      .field input, .field select, .field textarea {
        width: 100%;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--text);
        border-radius: 10px;
        padding: 0.55rem 0.65rem;
        font: inherit;
      }
      .field textarea { min-height: 6rem; font-family: var(--mono); font-size: 0.75rem; }
      .actions { display: flex; gap: 0.5rem; margin-top: 0.7rem; flex-wrap: wrap; }
      .table-row {
        width: 100%;
        text-align: left;
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 14px;
        padding: 0.7rem 0.8rem;
        cursor: pointer;
      }
      .table-row.active { border-color: var(--accent); background: #ecfdf5; }
      .table-row-name { display: block; font-weight: 600; }
      .table-row-meta { display: block; color: var(--muted); font-size: 0.82rem; margin-top: 0.2rem; }
      .toolbar { display: flex; gap: 0.75rem; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
      .toolbar-actions { display: flex; gap: 0.5rem; align-items: center; }
      .table-wrap { border: 1px solid var(--line); border-radius: 18px; overflow: auto; background: rgba(255,255,255,0.75); }
      table { width: 100%; min-width: 900px; border-collapse: collapse; }
      th, td { border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; padding: 0.65rem 0.75rem; font-size: 0.85rem; }
      th { position: sticky; top: 0; background: var(--panel-alt); z-index: 1; }
      td code, th code { font-family: var(--mono); font-size: 0.79rem; white-space: pre-wrap; word-break: break-word; }
      @media (max-width: 960px) {
        .viewer { grid-template-columns: 1fr; }
        .sidebar { border-right: none; border-bottom: 1px solid var(--line); }
      }
    </style>
  </head>
  <body>
    <div class="viewer">
      <aside class="sidebar">
        <h1>Table Viewer</h1>
        <p class="lede">Admin inspection tools for live SuperBased v4 backend tables.</p>
        <button id="connect" class="connect" type="button">Connect with Nostr</button>
        <div id="status" class="status">Not connected</div>
        <div class="stack">
          <div class="panel">
            <h2>Tower Profile</h2>
            <div class="meta">Set the public name and description clients will see when they connect to this Tower. Leave fields blank to fall back to env defaults.</div>
            <div class="field">
              <label for="towerNameInput" class="meta">Tower name</label>
              <input id="towerNameInput" type="text" placeholder="My SuperBased Tower" />
            </div>
            <div class="field">
              <label for="towerDescriptionInput" class="meta">Tower description</label>
              <textarea id="towerDescriptionInput" placeholder="Private family tower for shared records, groups, and storage."></textarea>
            </div>
            <div class="actions">
              <button id="saveTowerProfileBtn" class="connect" type="button">Save Tower Profile</button>
            </div>
          </div>
          <div class="panel">
            <h2>Danger Zone</h2>
            <div class="meta">Reset the Tower V4 database tables on this service. This clears SQL rows only. It does not delete object storage blobs or restart the service.</div>
            <div class="field">
              <label for="resetConfirmationInput" class="meta">Type <code>WIPE V4 DATA</code> to enable reset</label>
              <input id="resetConfirmationInput" type="text" placeholder="WIPE V4 DATA" />
            </div>
            <div class="actions">
              <button id="resetDatabaseBtn" class="connect danger-btn" type="button">Wipe V4 Data</button>
            </div>
            <div class="warning">Use this only when you intentionally want a clean Tower database and plan to re-bootstrap workspaces from scratch.</div>
          </div>
          <div class="panel">
            <h2>Connection Tokens</h2>
            <div class="meta">Existing encrypted/Yoke setup path. Tokens carry connection material for SuperBased record sync apps. Flight Deck PG uses the credential-free descriptor panel below instead.</div>
            <div class="field">
              <label for="workspaceSelect" class="meta">Workspace</label>
              <select id="workspaceSelect">
                <option value="">Load after connect</option>
              </select>
            </div>
            <div class="field">
              <label for="appNpubInput" class="meta">App npub</label>
              <input id="appNpubInput" type="text" placeholder="npub1..." />
            </div>
            <div class="actions">
              <button id="generateTokenBtn" class="connect" type="button">Generate Token</button>
              <button id="copyTokenBtn" class="pager-btn" type="button">Copy Token</button>
            </div>
            <div class="field">
              <label for="tokenOutput" class="meta">Connection token</label>
              <textarea id="tokenOutput" readonly placeholder="Generated token will appear here"></textarea>
            </div>
          </div>
          <div class="panel">
            <h2>Flight Deck PG Workspaces</h2>
            <div class="meta">Create a Postgres-backed Flight Deck workspace and copy a descriptor. The descriptor does not include tokens, raw database credentials, private keys, or encrypted payloads.</div>
            <div class="field">
              <label for="fdPgWorkspaceNameInput" class="meta">Workspace name</label>
              <input id="fdPgWorkspaceNameInput" type="text" placeholder="Acme Flight Deck" />
            </div>
            <div class="field">
              <label for="fdPgWorkspaceDescriptionInput" class="meta">Workspace description</label>
              <input id="fdPgWorkspaceDescriptionInput" type="text" placeholder="Postgres-backed Flight Deck workspace" />
            </div>
            <div class="field">
              <label for="fdPgAppNpubInput" class="meta">App npub</label>
              <input id="fdPgAppNpubInput" type="text" value="${config.flightDeck.appNpub}" />
            </div>
            <div class="field">
              <label for="fdPgWorkspaceServiceNpubInput" class="meta">Workspace service npub</label>
              <input id="fdPgWorkspaceServiceNpubInput" type="text" placeholder="Generated when blank" />
            </div>
            <div class="field">
              <label for="fdPgOwnerNpubInput" class="meta">Workspace owner npub</label>
              <input id="fdPgOwnerNpubInput" type="text" placeholder="Signed admin when blank" />
            </div>
            <div class="field">
              <label for="fdPgCreatorNpubInput" class="meta">Creator npub</label>
              <input id="fdPgCreatorNpubInput" type="text" placeholder="Signed admin when blank" />
            </div>
            <div class="field">
              <label for="fdPgScopeNameInput" class="meta">Optional smoke scope</label>
              <input id="fdPgScopeNameInput" type="text" placeholder="Leave blank for no starter scope" />
            </div>
            <div class="field">
              <label for="fdPgChannelNameInput" class="meta">Optional smoke channel</label>
              <input id="fdPgChannelNameInput" type="text" placeholder="Leave blank for no starter channel" />
            </div>
            <div class="field">
              <label for="fdPgSecondActorNpubInput" class="meta">Second actor npub</label>
              <input id="fdPgSecondActorNpubInput" type="text" placeholder="Optional viewer actor" />
            </div>
            <div class="field">
              <label for="fdPgSecondActorNameInput" class="meta">Second actor display name</label>
              <input id="fdPgSecondActorNameInput" type="text" placeholder="Required with second actor npub" />
            </div>
            <div class="actions">
              <button id="createFdPgWorkspaceBtn" class="connect" type="button">Create Flight Deck PG Workspace</button>
              <button id="copyFdPgDescriptorBtn" class="pager-btn" type="button">Copy Descriptor</button>
            </div>
            <div class="field">
              <label for="fdPgCreateResultOutput" class="meta">Create result</label>
              <textarea id="fdPgCreateResultOutput" readonly placeholder="Workspace setup result will appear here"></textarea>
            </div>
            <div class="field">
              <label for="fdPgDescriptorOutput" class="meta">Descriptor JSON</label>
              <textarea id="fdPgDescriptorOutput" readonly placeholder="Credential-free Flight Deck PG descriptor will appear here"></textarea>
            </div>
            <div id="fdPgServiceStatus" class="meta">Service metadata not checked.</div>
            <div class="next-step">Next step: open Flight Deck PG and connect with the copied descriptor.</div>
          </div>
          <div id="tableList" class="table-list"></div>
        </div>
      </aside>
      <main class="content">
        <div class="toolbar">
          <div>
            <div id="activeTable" style="font-size:1.05rem;font-weight:700;">No table selected</div>
            <div id="summary" class="meta">Connect, then select a table.</div>
          </div>
          <div class="toolbar-actions">
            <label class="meta" for="limitSelect">Rows</label>
            <select id="limitSelect" class="limit-select">
              <option value="50">50</option>
              <option value="100" selected>100</option>
              <option value="250">250</option>
            </select>
            <button id="prevBtn" class="pager-btn" type="button">Prev</button>
            <button id="nextBtn" class="pager-btn" type="button">Next</button>
          </div>
        </div>
        <div id="empty" class="empty">No table loaded.</div>
        <div id="tableWrap" class="table-wrap" hidden></div>
      </main>
    </div>
    <script type="module">
      const API_BASE = ${JSON.stringify(apiBaseUrl)};
      const state = { pubkey: null, npub: null, tables: [], activeTable: null, limit: 100, offset: 0 };
      const connectBtn = document.getElementById('connect');
      const statusEl = document.getElementById('status');
      const tableListEl = document.getElementById('tableList');
      const activeTableEl = document.getElementById('activeTable');
      const summaryEl = document.getElementById('summary');
      const tableWrapEl = document.getElementById('tableWrap');
      const emptyEl = document.getElementById('empty');
      const prevBtn = document.getElementById('prevBtn');
      const nextBtn = document.getElementById('nextBtn');
      const limitSelect = document.getElementById('limitSelect');
      const workspaceSelect = document.getElementById('workspaceSelect');
      const appNpubInput = document.getElementById('appNpubInput');
      const generateTokenBtn = document.getElementById('generateTokenBtn');
      const copyTokenBtn = document.getElementById('copyTokenBtn');
      const tokenOutput = document.getElementById('tokenOutput');
      const towerNameInput = document.getElementById('towerNameInput');
      const towerDescriptionInput = document.getElementById('towerDescriptionInput');
      const saveTowerProfileBtn = document.getElementById('saveTowerProfileBtn');
      const resetConfirmationInput = document.getElementById('resetConfirmationInput');
      const resetDatabaseBtn = document.getElementById('resetDatabaseBtn');
      const fdPgWorkspaceNameInput = document.getElementById('fdPgWorkspaceNameInput');
      const fdPgWorkspaceDescriptionInput = document.getElementById('fdPgWorkspaceDescriptionInput');
      const fdPgAppNpubInput = document.getElementById('fdPgAppNpubInput');
      const fdPgWorkspaceServiceNpubInput = document.getElementById('fdPgWorkspaceServiceNpubInput');
      const fdPgOwnerNpubInput = document.getElementById('fdPgOwnerNpubInput');
      const fdPgCreatorNpubInput = document.getElementById('fdPgCreatorNpubInput');
      const fdPgScopeNameInput = document.getElementById('fdPgScopeNameInput');
      const fdPgChannelNameInput = document.getElementById('fdPgChannelNameInput');
      const fdPgSecondActorNpubInput = document.getElementById('fdPgSecondActorNpubInput');
      const fdPgSecondActorNameInput = document.getElementById('fdPgSecondActorNameInput');
      const createFdPgWorkspaceBtn = document.getElementById('createFdPgWorkspaceBtn');
      const copyFdPgDescriptorBtn = document.getElementById('copyFdPgDescriptorBtn');
      const fdPgCreateResultOutput = document.getElementById('fdPgCreateResultOutput');
      const fdPgDescriptorOutput = document.getElementById('fdPgDescriptorOutput');
      const fdPgServiceStatus = document.getElementById('fdPgServiceStatus');

      function setStatus(message, isError = false) {
        statusEl.textContent = message;
        statusEl.className = isError ? 'status error' : 'status';
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
      }

      function normalizeValue(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') return JSON.stringify(value, null, 2);
        return String(value);
      }

      async function sha256Hex(input) {
        const bytes = new TextEncoder().encode(input);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      }

      function base64Json(value) {
        const raw = JSON.stringify(value);
        const bytes = new TextEncoder().encode(raw);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      }

      async function npubFromHex(pubkeyHex) {
        const mod = await import('https://esm.sh/nostr-tools@2.17.0/nip19');
        return mod.npubEncode(pubkeyHex);
      }

      async function signAuth(url, method, body = '') {
        if (!window.nostr) throw new Error('Nostr extension not available');
        const pubkey = state.pubkey || await window.nostr.getPublicKey();
        state.pubkey = pubkey;
        state.npub = await npubFromHex(pubkey);
        const tags = [['u', url], ['method', method.toUpperCase()]];
        if (body && method.toUpperCase() !== 'GET') {
          tags.push(['payload', await sha256Hex(body)]);
        }
        const event = await window.nostr.signEvent({
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: '',
        });
        return 'Nostr ' + base64Json(event);
      }

      async function apiGet(path) {
        const url = API_BASE + path;
        const auth = await signAuth(url, 'GET');
        const res = await fetch(url, { headers: { Authorization: auth } });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      }

      async function apiPost(path, body) {
        const url = API_BASE + path;
        const payload = JSON.stringify(body || {});
        const auth = await signAuth(url, 'POST', payload);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: auth,
            'Content-Type': 'application/json',
          },
          body: payload,
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      }

      async function apiPatch(path, body) {
        const url = API_BASE + path;
        const payload = JSON.stringify(body || {});
        const auth = await signAuth(url, 'PATCH', payload);
        const res = await fetch(url, {
          method: 'PATCH',
          headers: {
            Authorization: auth,
            'Content-Type': 'application/json',
          },
          body: payload,
        });
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      }

      function renderTowerProfile(payload) {
        towerNameInput.value = payload.tower_name || '';
        towerDescriptionInput.value = payload.tower_description || '';
      }

      function renderWorkspaceList(workspaces) {
        workspaceSelect.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = workspaces.length ? 'Select a workspace' : 'No workspaces found';
        workspaceSelect.appendChild(placeholder);
        for (const workspace of workspaces) {
          const option = document.createElement('option');
          option.value = workspace.workspace_id;
          option.textContent = workspace.name + ' | ' + workspace.workspace_owner_npub;
          workspaceSelect.appendChild(option);
        }
      }

      function renderTableList() {
        tableListEl.innerHTML = '';
        for (const table of state.tables) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'table-row' + (state.activeTable === table.table ? ' active' : '');
          button.innerHTML = '<span class="table-row-name">' + escapeHtml(table.table) + '</span>'
            + '<span class="table-row-meta">' + table.row_count + ' rows · ' + table.columns.length + ' cols</span>';
          button.addEventListener('click', () => {
            state.activeTable = table.table;
            state.offset = 0;
            renderTableList();
            loadTable().catch((error) => setStatus(error.message || 'Failed to load table', true));
          });
          tableListEl.appendChild(button);
        }
      }

      function renderRows(payload) {
        const columns = payload.columns || [];
        const rows = payload.rows || [];
        activeTableEl.textContent = payload.table;
        summaryEl.textContent = payload.row_count + ' rows total · offset ' + payload.offset;
        if (rows.length === 0) {
          emptyEl.hidden = false;
          emptyEl.textContent = 'No rows returned for this page.';
          tableWrapEl.hidden = true;
          tableWrapEl.innerHTML = '';
          return;
        }
        emptyEl.hidden = true;
        tableWrapEl.hidden = false;
        const head = columns.map((col) => '<th><div>' + escapeHtml(col.column_name) + '</div><code>' + escapeHtml(col.data_type) + '</code></th>').join('');
        const body = rows.map((row) => {
          const cells = columns.map((col) => '<td><code>' + escapeHtml(normalizeValue(row[col.column_name])) + '</code></td>').join('');
          return '<tr>' + cells + '</tr>';
        }).join('');
        tableWrapEl.innerHTML = '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
      }

      async function loadTables() {
        setStatus('Loading table list…');
        const payload = await apiGet('/api/v4/admin/tables');
        state.tables = payload.tables || [];
        const workspacePayload = await apiGet('/api/v4/admin/workspaces');
        state.workspaces = workspacePayload.workspaces || [];
        const towerPayload = await apiGet('/api/v4/admin/tower');
        renderTowerProfile(towerPayload);
        renderWorkspaceList(state.workspaces);
        if (!state.activeTable && state.tables.length > 0) state.activeTable = state.tables[0].table;
        renderTableList();
        setStatus('Connected as ' + (state.npub || payload.viewer));
        if (state.activeTable) await loadTable();
      }

      async function generateToken() {
        const workspaceId = workspaceSelect.value;
        const appNpub = String(appNpubInput.value || '').trim();
        if (!workspaceId) throw new Error('Select a workspace first');
        if (!appNpub) throw new Error('Enter an app npub first');
        setStatus('Generating connection token…');
        const payload = await apiGet('/api/v4/admin/workspaces/' + encodeURIComponent(workspaceId) + '/connection-token?app_npub=' + encodeURIComponent(appNpub));
        tokenOutput.value = payload.connection_token || '';
        setStatus('Connected as ' + (state.npub || payload.viewer));
      }

      async function createFlightDeckPgWorkspace() {
        const workspaceName = String(fdPgWorkspaceNameInput.value || '').trim();
        if (!workspaceName) throw new Error('Enter a Flight Deck PG workspace name first');
        const request = {
          workspace_name: workspaceName,
          workspace_description: String(fdPgWorkspaceDescriptionInput.value || '').trim() || null,
          app_npub: String(fdPgAppNpubInput.value || '').trim(),
          workspace_service_npub: String(fdPgWorkspaceServiceNpubInput.value || '').trim() || null,
          workspace_owner_npub: String(fdPgOwnerNpubInput.value || '').trim() || null,
          creator_npub: String(fdPgCreatorNpubInput.value || '').trim() || null,
          smoke_scope_name: String(fdPgScopeNameInput.value || '').trim() || null,
          smoke_channel_name: String(fdPgChannelNameInput.value || '').trim() || null,
          second_actor_npub: String(fdPgSecondActorNpubInput.value || '').trim() || null,
          second_actor_display_name: String(fdPgSecondActorNameInput.value || '').trim() || null,
        };
        setStatus('Creating Flight Deck PG workspace…');
        const payload = await apiPost('/api/v4/admin/flightdeck-pg/workspaces', request);
        const result = {
          workspace_id: payload.workspace_id,
          descriptor_route: payload.descriptor_route,
          groups: payload.groups,
          smoke: payload.smoke,
          actors: payload.actors,
        };
        fdPgCreateResultOutput.value = JSON.stringify(result, null, 2);
        fdPgDescriptorOutput.value = JSON.stringify(payload.descriptor || {}, null, 2);
        try {
          const service = await apiGet('/api/v4/flightdeck-pg/service');
          fdPgServiceStatus.textContent = 'Service metadata ok: ' + ((service.service && service.service.route_prefix) || '/api/v4/flightdeck-pg');
        } catch (error) {
          fdPgServiceStatus.textContent = 'Service metadata check failed: ' + ((error && error.message) || 'unknown error');
        }
        await loadTables();
        setStatus('Flight Deck PG workspace created: ' + payload.workspace_id);
      }

      async function saveTowerProfile() {
        setStatus('Saving Tower profile…');
        const payload = await apiPatch('/api/v4/admin/tower', {
          tower_name: String(towerNameInput.value || '').trim() || null,
          tower_description: String(towerDescriptionInput.value || '').trim() || null,
        });
        renderTowerProfile(payload);
        setStatus('Tower profile saved');
      }

      async function resetDatabase() {
        const confirmation = String(resetConfirmationInput.value || '').trim();
        if (confirmation !== 'WIPE V4 DATA') {
          throw new Error('Type WIPE V4 DATA exactly before resetting');
        }
        const confirmed = window.confirm('This will delete all Tower V4 rows on this service. Continue?');
        if (!confirmed) return;
        setStatus('Resetting V4 database tables…');
        const payload = await apiPost('/api/v4/admin/reset-database', {
          confirmation,
        });
        tokenOutput.value = '';
        state.offset = 0;
        await loadTables();
        setStatus(
          'Reset completed on ' + (state.npub || payload.viewer) + '. '
          + 'Tower rows are empty; restart/re-bootstrap services separately.',
        );
      }

      async function loadTable() {
        if (!state.activeTable) return;
        setStatus('Loading ' + state.activeTable + '…');
        const payload = await apiGet('/api/v4/admin/tables/' + encodeURIComponent(state.activeTable) + '?limit=' + state.limit + '&offset=' + state.offset);
        renderRows(payload);
        setStatus('Connected as ' + (state.npub || payload.viewer));
      }

      connectBtn.addEventListener('click', () => loadTables().catch((error) => setStatus(error.message || 'Failed to connect', true)));
      saveTowerProfileBtn.addEventListener('click', () => saveTowerProfile().catch((error) => setStatus(error.message || 'Failed to save Tower profile', true)));
      generateTokenBtn.addEventListener('click', () => generateToken().catch((error) => setStatus(error.message || 'Failed to generate token', true)));
      copyTokenBtn.addEventListener('click', async () => {
        if (!tokenOutput.value) return;
        try {
          await navigator.clipboard.writeText(tokenOutput.value);
          setStatus('Connection token copied');
        } catch (error) {
          setStatus((error && error.message) || 'Failed to copy token', true);
        }
      });
      createFdPgWorkspaceBtn.addEventListener('click', () => createFlightDeckPgWorkspace().catch((error) => setStatus(error.message || 'Failed to create Flight Deck PG workspace', true)));
      copyFdPgDescriptorBtn.addEventListener('click', async () => {
        if (!fdPgDescriptorOutput.value) return;
        try {
          await navigator.clipboard.writeText(fdPgDescriptorOutput.value);
          setStatus('Flight Deck PG descriptor copied');
        } catch (error) {
          setStatus((error && error.message) || 'Failed to copy descriptor', true);
        }
      });
      resetDatabaseBtn.addEventListener('click', () => resetDatabase().catch((error) => setStatus(error.message || 'Failed to reset database', true)));
      limitSelect.addEventListener('change', () => {
        state.limit = Number.parseInt(limitSelect.value, 10) || 100;
        state.offset = 0;
        loadTable().catch((error) => setStatus(error.message || 'Failed to load table', true));
      });
      prevBtn.addEventListener('click', () => {
        state.offset = Math.max(0, state.offset - state.limit);
        loadTable().catch((error) => setStatus(error.message || 'Failed to load table', true));
      });
      nextBtn.addEventListener('click', () => {
        state.offset += state.limit;
        loadTable().catch((error) => setStatus(error.message || 'Failed to load table', true));
      });
    </script>
  </body>
</html>`;
}

function superbasedDashboardHtml(apiBaseUrl: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Superbased Tower</title>
    <style>
      :root {
        --bg: #f7f8f8;
        --panel: #ffffff;
        --panel-alt: #eef5f3;
        --line: #ccd7d4;
        --text: #17211f;
        --muted: #5e6b68;
        --accent: #0f766e;
        --accent-2: #334155;
        --danger: #b91c1c;
        --warn: #a16207;
        --mono: "SFMono-Regular", "Menlo", monospace;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--text); }
      .app { display: grid; grid-template-columns: 340px minmax(0, 1fr); min-height: 100vh; }
      .sidebar { border-right: 1px solid var(--line); padding: 1rem; background: #fbfcfc; }
      .main { padding: 1rem 1.25rem 2rem; }
      h1 { margin: 0 0 0.35rem; font-size: 1.3rem; }
      h2 { margin: 0 0 0.6rem; font-size: 1rem; }
      h3 { margin: 0 0 0.35rem; font-size: 0.9rem; }
      .muted, .status, .empty { color: var(--muted); font-size: 0.88rem; }
      .status { min-height: 1.3rem; margin: 0.75rem 0; }
      .status.error { color: var(--danger); }
      .stack { display: flex; flex-direction: column; gap: 0.9rem; }
      .row { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; }
      .panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 0.85rem; }
      .workspace-btn {
        width: 100%;
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 8px;
        padding: 0.75rem;
        text-align: left;
        cursor: pointer;
      }
      .workspace-btn.active { border-color: var(--accent); background: var(--panel-alt); }
      .workspace-title { display: flex; justify-content: space-between; gap: 0.5rem; font-weight: 700; }
      .badge { border: 1px solid var(--line); border-radius: 999px; padding: 0.15rem 0.45rem; font-size: 0.72rem; white-space: nowrap; }
      .badge.active { color: #065f46; border-color: #99d5c9; background: #ecfdf5; }
      .badge.low_balance { color: var(--warn); border-color: #f2d48b; background: #fffbeb; }
      .badge.read_only_grace, .badge.delete_eligible, .badge.suspended { color: var(--danger); border-color: #f0b7b7; background: #fff1f1; }
      button, input, select, textarea {
        font: inherit;
      }
      button, .button-link {
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--text);
        border-radius: 8px;
        padding: 0.5rem 0.75rem;
        cursor: pointer;
        text-decoration: none;
      }
      button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
      button.secondary { background: #eef2f7; border-color: #cbd5e1; }
      input, select, textarea {
        width: 100%;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--text);
        border-radius: 8px;
        padding: 0.55rem 0.65rem;
      }
      textarea { min-height: 7rem; font-family: var(--mono); font-size: 0.76rem; }
      label { display: block; margin: 0.55rem 0 0.25rem; color: var(--muted); font-size: 0.82rem; }
      .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
      .metric { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 0.8rem; min-width: 0; }
      .metric .value { font-size: 1.25rem; font-weight: 750; overflow-wrap: anywhere; }
      .tabs { display: flex; gap: 0.45rem; margin: 0.5rem 0 0.85rem; flex-wrap: wrap; }
      .tab.active { background: var(--accent-2); border-color: var(--accent-2); color: #fff; }
      .grid-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.9rem; }
      .table-wrap { border: 1px solid var(--line); border-radius: 8px; overflow: auto; background: #fff; }
      table { width: 100%; min-width: 860px; border-collapse: collapse; }
      th, td { border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; padding: 0.58rem 0.65rem; font-size: 0.82rem; }
      th { background: #eef2f7; position: sticky; top: 0; z-index: 1; }
      td code { font-family: var(--mono); font-size: 0.76rem; overflow-wrap: anywhere; white-space: pre-wrap; }
      .usage-summary { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; margin: 0 0 0.75rem; padding: 0.65rem 0.75rem; border: 1px solid var(--line); border-radius: 8px; background: #fbfcfc; }
      .usage-summary strong { font-size: 1.05rem; }
      .hidden { display: none !important; }
      @media (max-width: 980px) {
        .app { grid-template-columns: 1fr; }
        .sidebar { border-right: none; border-bottom: 1px solid var(--line); }
        .metrics, .grid-2 { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <aside class="sidebar">
        <h1>Superbased Tower</h1>
        <div class="muted">Workspace operations for this Tower.</div>
        <button id="connectBtn" class="primary" type="button" style="margin-top:0.8rem;">Connect with Nostr</button>
        <div id="status" class="status">Not connected</div>
        <div class="panel">
          <h2>Workspaces</h2>
          <div id="workspaceList" class="stack"><div class="empty">Connect to load manageable workspaces.</div></div>
        </div>
        <div class="panel" style="margin-top:0.9rem;">
          <h2>Create Workspace</h2>
          <div class="muted">Browser creation needs workspace service keys, group keys, and wrapped secrets. Use the existing bootstrap client or POST <code>/api/v4/workspaces</code> with a prepared cryptographic payload.</div>
          <div class="row" style="margin-top:0.75rem;">
            <a class="button-link" href="/docs">Open API Docs</a>
          </div>
        </div>
      </aside>
      <main class="main">
        <section class="metrics" id="metrics">
          <div class="metric"><div class="muted">Balance</div><div id="balanceMetric" class="value">-</div></div>
          <div class="metric"><div class="muted">State</div><div id="stateMetric" class="value">-</div></div>
          <div class="metric"><div class="muted">Usage</div><div id="usageMetric" class="value">-</div></div>
          <div class="metric"><div class="muted">Runout</div><div id="runoutMetric" class="value">-</div></div>
        </section>
        <div class="tabs">
          <button class="tab active" data-tab="overview" type="button">Overview</button>
          <button class="tab" data-tab="apps" type="button">Apps</button>
          <button class="tab" data-tab="records" type="button">Records</button>
          <button class="tab" data-tab="storage" type="button">Storage</button>
          <button class="tab" data-tab="billing" type="button">Billing</button>
        </div>
        <section id="tab-overview" class="tab-panel">
          <div class="panel">
            <h2 id="workspaceHeading">No workspace selected</h2>
            <div id="workspaceSummary" class="muted">Connect and choose a workspace.</div>
          </div>
        </section>
        <section id="tab-apps" class="tab-panel hidden">
          <div class="grid-2">
            <div class="panel">
              <h2>App Namespaces</h2>
              <label for="appNameInput">App name</label>
              <input id="appNameInput" type="text" placeholder="Flight Deck" />
              <label for="appNpubInput">App npub</label>
              <input id="appNpubInput" type="text" placeholder="npub1..." />
              <div class="row" style="margin-top:0.7rem;">
                <button id="createAppBtn" class="primary" type="button">Save App</button>
              </div>
              <div id="appsList" class="stack" style="margin-top:0.85rem;"></div>
            </div>
            <div class="panel">
              <h2>Connection Details</h2>
              <textarea id="connectionOutput" readonly placeholder="Regenerated connection details appear here"></textarea>
            </div>
          </div>
          <div class="panel" style="margin-top:0.9rem;">
            <h2>Observed App Spaces</h2>
            <div id="appSpacesTable" class="table-wrap"><div class="empty" style="padding:0.8rem;">No record families loaded.</div></div>
          </div>
        </section>
        <section id="tab-records" class="tab-panel hidden">
          <div class="panel">
            <div class="row" style="justify-content:space-between;">
              <h2>Record Metadata</h2>
              <button id="refreshRecordsBtn" type="button">Refresh</button>
            </div>
            <div id="recordsUsageSummary" class="usage-summary"><span class="muted">Total record storage</span><strong>-</strong></div>
            <div id="recordFamiliesTable" class="table-wrap" style="margin-bottom:0.85rem;"><div class="empty" style="padding:0.8rem;">No record families loaded.</div></div>
            <div id="recordsTable" class="table-wrap"><div class="empty" style="padding:0.8rem;">No records loaded.</div></div>
          </div>
        </section>
        <section id="tab-storage" class="tab-panel hidden">
          <div class="panel">
            <div class="row" style="justify-content:space-between;">
              <h2>Storage Metadata</h2>
              <button id="refreshStorageBtn" type="button">Refresh</button>
            </div>
            <div id="storageUsageSummary" class="usage-summary"><span class="muted">Total S3/object storage</span><strong>-</strong></div>
            <div id="storageTable" class="table-wrap"><div class="empty" style="padding:0.8rem;">No storage objects loaded.</div></div>
          </div>
        </section>
        <section id="tab-billing" class="tab-panel hidden">
          <div class="grid-2">
            <div class="panel">
              <h2>Buy Credits</h2>
              <label for="quantityCreditsInput">Quantity credits</label>
              <input id="quantityCreditsInput" type="number" min="1" step="1" value="1000" />
              <div class="row" style="margin-top:0.7rem;">
                <button id="purchaseBtn" class="primary" type="button">Create Invoice</button>
              </div>
            </div>
            <div class="panel">
              <h2>Invoice</h2>
              <textarea id="invoiceOutput" readonly placeholder="Invoice details appear here"></textarea>
            </div>
          </div>
        </section>
      </main>
    </div>
    <script type="module">
      const API_BASE = ${JSON.stringify(apiBaseUrl)};
      const state = { pubkey: null, npub: null, workspaces: [], activeWorkspace: null, apps: [], appSchemas: [], recordFamilies: [] };
      const els = {
        connectBtn: document.getElementById('connectBtn'),
        status: document.getElementById('status'),
        workspaceList: document.getElementById('workspaceList'),
        balanceMetric: document.getElementById('balanceMetric'),
        stateMetric: document.getElementById('stateMetric'),
        usageMetric: document.getElementById('usageMetric'),
        runoutMetric: document.getElementById('runoutMetric'),
        workspaceHeading: document.getElementById('workspaceHeading'),
        workspaceSummary: document.getElementById('workspaceSummary'),
        appNameInput: document.getElementById('appNameInput'),
        appNpubInput: document.getElementById('appNpubInput'),
        createAppBtn: document.getElementById('createAppBtn'),
        appsList: document.getElementById('appsList'),
        appSpacesTable: document.getElementById('appSpacesTable'),
        connectionOutput: document.getElementById('connectionOutput'),
        refreshRecordsBtn: document.getElementById('refreshRecordsBtn'),
        refreshStorageBtn: document.getElementById('refreshStorageBtn'),
        recordFamiliesTable: document.getElementById('recordFamiliesTable'),
        recordsTable: document.getElementById('recordsTable'),
        storageTable: document.getElementById('storageTable'),
        recordsUsageSummary: document.getElementById('recordsUsageSummary'),
        storageUsageSummary: document.getElementById('storageUsageSummary'),
        quantityCreditsInput: document.getElementById('quantityCreditsInput'),
        purchaseBtn: document.getElementById('purchaseBtn'),
        invoiceOutput: document.getElementById('invoiceOutput'),
      };

      function setStatus(message, isError = false) {
        els.status.textContent = message;
        els.status.className = isError ? 'status error' : 'status';
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
      }

      function short(value) {
        const text = String(value || '');
        return text.length > 22 ? text.slice(0, 12) + '...' + text.slice(-8) : text;
      }

      function formatDate(value) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
      }

      function formatBytes(value) {
        const bytes = Number(value || 0);
        if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let amount = bytes;
        let unit = 0;
        while (amount >= 1024 && unit < units.length - 1) {
          amount /= 1024;
          unit += 1;
        }
        const digits = amount >= 10 || unit === 0 ? 0 : 1;
        return amount.toFixed(digits) + ' ' + units[unit];
      }

      const KNOWN_COLLECTION_SPECS = {
        approval: 'Flight Deck approval record',
        audio_note: 'Flight Deck audio note record',
        channel: 'Flight Deck chat channel record',
        chat_message: 'Flight Deck chat message record',
        comment: 'Flight Deck comment record',
        directory: 'Flight Deck document directory record',
        document: 'Flight Deck document record',
        flow: 'Flight Deck flow record',
        opportunity: 'Flight Deck opportunity record',
        organisation: 'Flight Deck organisation record',
        person: 'Flight Deck person record',
        reaction: 'Flight Deck reaction record',
        report: 'Flight Deck report record',
        schedule: 'Flight Deck schedule record',
        scope: 'Flight Deck scope record',
        settings: 'Flight Deck workspace settings record',
        task: 'Flight Deck task record',
      };

      function collectionLabel(value) {
        return String(value || 'unknown')
          .replaceAll('_', ' ')
          .replace(/\b\w/g, (char) => char.toUpperCase());
      }

      function collectionSpec(value) {
        const key = String(value || '').trim();
        return KNOWN_COLLECTION_SPECS[key] || 'Opaque encrypted client-owned record';
      }

      async function sha256Hex(input) {
        const bytes = new TextEncoder().encode(input);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      }

      function base64Json(value) {
        const raw = JSON.stringify(value);
        const bytes = new TextEncoder().encode(raw);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      }

      async function npubFromHex(pubkeyHex) {
        const mod = await import('https://esm.sh/nostr-tools@2.17.0/nip19');
        return mod.npubEncode(pubkeyHex);
      }

      async function signAuth(url, method, body = '') {
        if (!window.nostr) throw new Error('Nostr extension not available');
        const pubkey = state.pubkey || await window.nostr.getPublicKey();
        state.pubkey = pubkey;
        state.npub = await npubFromHex(pubkey);
        const tags = [['u', url], ['method', method.toUpperCase()]];
        if (body && method.toUpperCase() !== 'GET') tags.push(['payload', await sha256Hex(body)]);
        const event = await window.nostr.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' });
        return 'Nostr ' + base64Json(event);
      }

      async function api(path, method = 'GET', body) {
        const url = API_BASE + path;
        const payload = body === undefined ? '' : JSON.stringify(body);
        const auth = await signAuth(url, method, payload);
        const res = await fetch(url, {
          method,
          headers: { Authorization: auth, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
          ...(payload ? { body: payload } : {}),
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) throw new Error(data.error || text || 'Request failed');
        return data;
      }

      function renderWorkspaces() {
        els.workspaceList.innerHTML = '';
        if (!state.workspaces.length) {
          els.workspaceList.innerHTML = '<div class="empty">No manageable workspaces found.</div>';
          return;
        }
        for (const workspace of state.workspaces) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'workspace-btn' + (state.activeWorkspace?.workspace_owner_npub === workspace.workspace_owner_npub ? ' active' : '');
          button.innerHTML = '<div class="workspace-title"><span>' + escapeHtml(workspace.workspace_name) + '</span><span class="badge ' + escapeHtml(workspace.billing_state) + '">' + escapeHtml(workspace.billing_state) + '</span></div>'
            + '<div class="muted">' + escapeHtml(short(workspace.workspace_owner_npub)) + '</div>'
            + '<div class="muted">' + escapeHtml(workspace.balance_credits) + ' credits · ' + escapeHtml(workspace.usage.estimated_credits_per_hour) + '/h</div>';
          button.addEventListener('click', () => selectWorkspace(workspace.workspace_owner_npub).catch((error) => setStatus(error.message, true)));
          els.workspaceList.appendChild(button);
        }
      }

      function renderMetrics(status) {
        els.balanceMetric.textContent = status ? status.balance_credits : '-';
        els.stateMetric.textContent = status ? status.billing_state : '-';
        els.usageMetric.textContent = status ? status.usage.billable_mb + ' MB-h' : '-';
        els.runoutMetric.textContent = status?.estimated_runout_at ? formatDate(status.estimated_runout_at) : '-';
        els.workspaceHeading.textContent = status ? status.workspace_name : 'No workspace selected';
        els.workspaceSummary.innerHTML = status
          ? '<code>' + escapeHtml(status.workspace_owner_npub) + '</code><br>Record bytes: ' + status.usage.record_bytes + ' · Object bytes: ' + status.usage.object_bytes + ' · Billing mode: ' + escapeHtml(status.billing_mode)
          : 'Connect and choose a workspace.';
        renderUsageSummaries(status);
      }

      function renderUsageSummaries(status) {
        const recordBytes = Number(status?.usage?.record_bytes || 0);
        const objectBytes = Number(status?.usage?.object_bytes || 0);
        els.recordsUsageSummary.innerHTML = '<span class="muted">Total record storage</span><strong>' + escapeHtml(formatBytes(recordBytes)) + '</strong><span class="muted">' + escapeHtml(recordBytes.toLocaleString()) + ' bytes</span>';
        els.storageUsageSummary.innerHTML = '<span class="muted">Total S3/object storage</span><strong>' + escapeHtml(formatBytes(objectBytes)) + '</strong><span class="muted">' + escapeHtml(objectBytes.toLocaleString()) + ' bytes</span>';
      }

      function table(headers, rows) {
        if (!rows.length) return '<div class="empty" style="padding:0.8rem;">No rows.</div>';
        const head = headers.map((h) => '<th>' + escapeHtml(h.label) + '</th>').join('');
        const body = rows.map((row) => '<tr>' + headers.map((h) => '<td><code>' + escapeHtml(h.value(row)) + '</code></td>').join('') + '</tr>').join('');
        return '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
      }

      function renderApps() {
        els.appsList.innerHTML = '';
        if (!state.apps.length) {
          els.appsList.innerHTML = '<div class="empty">No app namespaces saved.</div>';
        } else {
          const activeNamespaces = new Set(state.recordFamilies.map((family) => family.app_namespace).filter(Boolean));
          const schemaByApp = new Map(state.appSchemas.map((schema) => [schema.app_npub, schema]));
          for (const app of state.apps) {
            const item = document.createElement('div');
            item.className = 'panel';
            const active = activeNamespaces.has(app.app_npub);
            const schema = schemaByApp.get(app.app_npub);
            const schemaText = schema
              ? 'Schema manifest: ' + escapeHtml(String((schema.record_families || []).length)) + ' families · <code>' + escapeHtml(String(schema.schema_hash || '').slice(0, 16)) + '</code>'
              : 'No schema manifest published.';
            item.innerHTML = '<div class="workspace-title"><h3>' + escapeHtml(app.app_name) + '</h3><span class="badge ' + (active ? 'active' : '') + '">' + (active ? 'active' : 'no records') + '</span></div><div class="muted"><code>' + escapeHtml(app.app_npub) + '</code></div><div class="muted">' + schemaText + '</div>';
            const action = document.createElement('button');
            action.type = 'button';
            action.className = 'secondary';
            action.textContent = 'Regenerate Details';
            action.addEventListener('click', () => regenerateConnection(app.app_npub).catch((error) => setStatus(error.message, true)));
            item.appendChild(action);
            els.appsList.appendChild(item);
          }
        }
        renderAppSpaces();
      }

      function renderAppSpaces() {
        const byNamespace = new Map();
        for (const family of state.recordFamilies) {
          const namespace = family.app_namespace || '(unscoped)';
          const current = byNamespace.get(namespace) || { app_namespace: namespace, family_count: 0, latest_record_count: 0, total_versions: 0, total_bytes: 0 };
          current.family_count += 1;
          current.latest_record_count += Number(family.latest_record_count || 0);
          current.total_versions += Number(family.total_versions || 0);
          current.total_bytes += Number(family.total_bytes || 0);
          byNamespace.set(namespace, current);
        }
        for (const app of state.apps) {
          if (!byNamespace.has(app.app_npub)) {
            byNamespace.set(app.app_npub, { app_namespace: app.app_npub, family_count: 0, latest_record_count: 0, total_versions: 0, total_bytes: 0 });
          }
        }
        const appNames = new Map(state.apps.map((app) => [app.app_npub, app.app_name]));
        const rows = [...byNamespace.values()].sort((a, b) => b.latest_record_count - a.latest_record_count || a.app_namespace.localeCompare(b.app_namespace));
        els.appSpacesTable.innerHTML = table([
          { label: 'App Space', value: (row) => row.app_namespace },
          { label: 'Name', value: (row) => appNames.get(row.app_namespace) || '-' },
          { label: 'Saved', value: (row) => appNames.has(row.app_namespace) ? 'yes' : 'observed only' },
          { label: 'Active', value: (row) => row.family_count > 0 ? 'yes' : 'no' },
          { label: 'Families', value: (row) => row.family_count },
          { label: 'Records', value: (row) => row.latest_record_count },
          { label: 'Versions', value: (row) => row.total_versions },
          { label: 'Bytes', value: (row) => row.total_bytes + ' (' + formatBytes(row.total_bytes) + ')' },
        ], rows);
      }

      function renderRecordFamilies() {
        els.recordFamiliesTable.innerHTML = table([
          { label: 'Data Type', value: (row) => collectionLabel(row.collection_space) },
          { label: 'App Space', value: (row) => row.app_namespace || '-' },
          { label: 'Family Hash', value: (row) => row.record_family_hash },
          { label: 'Records', value: (row) => row.latest_record_count },
          { label: 'Versions', value: (row) => row.total_versions },
          { label: 'Bytes', value: (row) => row.total_bytes + ' (' + formatBytes(row.total_bytes) + ')' },
          { label: 'Spec', value: (row) => collectionSpec(row.collection_space) },
          { label: 'Updated', value: (row) => formatDate(row.latest_updated_at) },
        ], state.recordFamilies);
      }

      async function loadRecords() {
        if (!state.activeWorkspace) return;
        const owner = encodeURIComponent(state.activeWorkspace.workspace_owner_npub);
        const payload = await api('/api/v4/workspaces/' + owner + '/records/metadata?limit=100');
        els.recordsTable.innerHTML = table([
          { label: 'Record ID', value: (row) => row.record_id },
          { label: 'Family', value: (row) => row.record_family_hash },
          { label: 'Latest', value: (row) => 'v' + row.latest_version + ' / ' + row.total_versions + ' versions' },
          { label: 'Ciphertext', value: (row) => row.owner_ciphertext_bytes + ' owner, ' + row.group_payload_bytes + ' group bytes' },
          { label: 'Groups', value: (row) => row.group_payload_count },
          { label: 'Signer', value: (row) => row.signature_npub },
          { label: 'Updated', value: (row) => formatDate(row.latest_updated_at) },
        ], payload.records || []);
      }

      async function loadRecordFamilies() {
        if (!state.activeWorkspace) return;
        const owner = encodeURIComponent(state.activeWorkspace.workspace_owner_npub);
        const payload = await api('/api/v4/workspaces/' + owner + '/records/families');
        state.recordFamilies = payload.families || [];
        renderRecordFamilies();
        renderApps();
      }

      async function loadStorage() {
        if (!state.activeWorkspace) return;
        const owner = encodeURIComponent(state.activeWorkspace.workspace_owner_npub);
        const payload = await api('/api/v4/workspaces/' + owner + '/storage/metadata?limit=100');
        els.storageTable.innerHTML = table([
          { label: 'Object', value: (row) => row.object_id },
          { label: 'File', value: (row) => row.file_name || '-' },
          { label: 'Type', value: (row) => row.content_type },
          { label: 'Bytes', value: (row) => row.size_bytes },
          { label: 'Public', value: (row) => row.is_public ? 'yes' : 'no' },
          { label: 'Completed', value: (row) => row.completed_at ? formatDate(row.completed_at) : 'pending' },
          { label: 'Creator', value: (row) => row.created_by_npub },
        ], payload.objects || []);
      }

      async function loadApps() {
        if (!state.activeWorkspace) return;
        const owner = encodeURIComponent(state.activeWorkspace.workspace_owner_npub);
        const payload = await api('/api/v4/workspaces/' + owner + '/apps');
        state.apps = payload.apps || [];
        const schemas = await api('/api/v4/workspaces/' + owner + '/app-schemas').catch(() => ({ schemas: [] }));
        state.appSchemas = schemas.schemas || [];
        renderApps();
      }

      async function loadDashboard() {
        setStatus('Loading workspaces...');
        const payload = await api('/api/v4/billing/workspaces');
        state.workspaces = payload.workspaces || [];
        renderWorkspaces();
        if (state.workspaces[0]) await selectWorkspace(state.workspaces[0].workspace_owner_npub);
        setStatus('Connected as ' + state.npub);
      }

      async function loadWorkspaceStatus(workspaceOwnerNpub) {
        const owner = encodeURIComponent(workspaceOwnerNpub);
        const status = await api('/api/v4/workspaces/' + owner + '/billing/status');
        state.activeWorkspace = status;
        const existing = state.workspaces.find((workspace) => workspace.workspace_owner_npub === workspaceOwnerNpub);
        if (existing) Object.assign(existing, status);
        renderWorkspaces();
        renderMetrics(status);
        return status;
      }

      async function refreshActiveWorkspaceStatus() {
        if (!state.activeWorkspace) return null;
        return loadWorkspaceStatus(state.activeWorkspace.workspace_owner_npub);
      }

      async function selectWorkspace(workspaceOwnerNpub) {
        await loadWorkspaceStatus(workspaceOwnerNpub);
        await Promise.all([loadApps(), loadRecordFamilies(), loadRecords(), loadStorage()]);
      }

      async function refreshRecordsTab() {
        await refreshActiveWorkspaceStatus();
        await loadRecordFamilies();
        await loadRecords();
      }

      async function refreshStorageTab() {
        await refreshActiveWorkspaceStatus();
        await loadStorage();
      }

      async function createApp() {
        if (!state.activeWorkspace) throw new Error('Select a workspace first');
        const appNpub = String(els.appNpubInput.value || '').trim();
        if (!appNpub) throw new Error('app_npub required');
        const owner = encodeURIComponent(state.activeWorkspace.workspace_owner_npub);
        await api('/api/v4/workspaces/' + owner + '/apps', 'POST', {
          app_npub: appNpub,
          app_name: String(els.appNameInput.value || '').trim() || appNpub,
        });
        await loadApps();
        setStatus('App namespace saved');
      }

      async function regenerateConnection(appNpub) {
        if (!state.activeWorkspace) throw new Error('Select a workspace first');
        const owner = encodeURIComponent(state.activeWorkspace.workspace_owner_npub);
        const payload = await api('/api/v4/workspaces/' + owner + '/apps/' + encodeURIComponent(appNpub) + '/connection-token');
        els.connectionOutput.value = JSON.stringify(payload, null, 2);
        setStatus('Connection details regenerated');
      }

      async function createPurchase() {
        if (!state.activeWorkspace) throw new Error('Select a workspace first');
        const quantity = Number(els.quantityCreditsInput.value);
        const owner = encodeURIComponent(state.activeWorkspace.workspace_owner_npub);
        const payload = await api('/api/v4/workspaces/' + owner + '/billing/purchase', 'POST', { quantity_credits: quantity });
        els.invoiceOutput.value = JSON.stringify(payload, null, 2);
        setStatus('Invoice created');
      }

      function setTab(name) {
        document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
        document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.add('hidden'));
        document.getElementById('tab-' + name).classList.remove('hidden');
      }

      document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => setTab(tab.dataset.tab)));
      els.connectBtn.addEventListener('click', () => loadDashboard().catch((error) => setStatus(error.message, true)));
      els.createAppBtn.addEventListener('click', () => createApp().catch((error) => setStatus(error.message, true)));
      els.refreshRecordsBtn.addEventListener('click', () => refreshRecordsTab().catch((error) => setStatus(error.message, true)));
      els.refreshStorageBtn.addEventListener('click', () => refreshStorageTab().catch((error) => setStatus(error.message, true)));
      els.purchaseBtn.addEventListener('click', () => createPurchase().catch((error) => setStatus(error.message, true)));
      renderMetrics(null);
    </script>
  </body>
</html>`;
}

function preferredOrigin(origin: string) {
  return config.directHttpsUrl || origin;
}

export function buildDocsHtml(origin: string) {
  return docsHtml(`${preferredOrigin(origin)}/openapi.json`);
}

export function buildAdminInterfaceHtml(origin: string) {
  return adminInterfaceHtml(preferredOrigin(origin));
}

export function buildTableViewerHtml(origin: string) {
  return tableViewerHtml(preferredOrigin(origin));
}

export function buildSuperbasedDashboardHtml(origin: string) {
  return superbasedDashboardHtml(preferredOrigin(origin));
}

export function buildOpenApiDocument(origin: string) {
  const publicOrigin = preferredOrigin(origin);
  return {
    openapi: '3.1.0',
    info: {
      title: 'SuperBased V4 API',
      version: '0.1.0',
      description:
        'Workspace-scoped groups and append-only record sync for Coworker SuperBased v4.',
    },
    servers: [
      {
        url: publicOrigin,
        description: 'Direct HTTPS endpoint',
      },
      ...(origin !== publicOrigin
        ? [
            {
              url: origin,
              description: 'Internal request origin',
            },
          ]
        : []),
    ],
    tags: [
      { name: 'Health', description: 'Service discovery and basic health' },
      { name: 'Groups', description: 'Workspace group management' },
      { name: 'Graph', description: 'Optional npub-scoped graph memory API backed by Postgres RLS' },
      { name: 'Records', description: 'Append-only record sync and fetch' },
      { name: 'Storage', description: 'Opaque encrypted object upload and download' },
      { name: 'Billing', description: 'Workspace-scoped Superbased usage credits and app connection namespaces' },
      { name: 'Admin', description: 'Backend inspection and service administration' },
      { name: 'User', description: 'User profile and workspace session key management' },
      { name: 'Flight Deck PG', description: 'Contract-first typed Flight Deck PG APIs backed by Tower Postgres rows and PH1 service-layer authorization.' },
      { name: 'WApp Activity', description: 'Signed WApp publishing grants and ACL-filtered Flight Deck activity projections.' },
      { name: 'Git Authority', description: 'Tower control-plane contract for private repositories, explicit Git grants, protected-ref policy, short-lived capabilities, and redacted audit.' },
    ],
    'x-flightdeck-pg-contract-fixtures': flightDeckPgContractFixturePaths,
    components: {
      securitySchemes: {
        nip98: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description:
            'NIP-98 auth header in the format `Nostr <base64-encoded event-json>`. The event must contain exactly one non-empty `u` tag signing the complete canonical request URL, including the exact query parameters and their order, and exactly one non-empty `method` tag. Trailing slashes are significant.',
        },
        gitInternalService: {
          type: 'apiKey',
          in: 'header',
          name: 'x-wingman-git-service-token',
          description: 'Operator-configured private service credential for wingman-git capability introspection/revocation. It is distinct from Git bearer capabilities and repository administration.',
        },
      },
      schemas: {
        WappPublishingDestination: {
          type: 'object', additionalProperties: false, required: ['scope_id', 'channel_id'],
          properties: {
            scope_id: { type: 'string', format: 'uuid' }, scope_name: { type: 'string' },
            channel_id: { type: 'string', format: 'uuid' }, channel_name: { type: 'string' }, available: { type: 'boolean' },
          },
        },
        WappPublishingGrantPutRequest: {
          type: 'object', additionalProperties: false,
          required: ['app_id', 'publisher_npub', 'owner_npub', 'display_name', 'capabilities', 'destinations', 'registered_open_origins'],
          properties: {
            app_id: { type: 'string', maxLength: 128 }, publisher_npub: { type: 'string' }, owner_npub: { type: 'string' },
            display_name: { type: 'string', maxLength: 160 },
            capabilities: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string', enum: ['activity.publish'] } },
            destinations: { type: 'array', minItems: 1, maxItems: 200, items: { $ref: '#/components/schemas/WappPublishingDestination' } },
            registered_open_origins: { type: 'array', items: { type: 'string', format: 'uri', pattern: '^https://' } },
          },
        },
        WappPublishingGrant: {
          type: 'object', required: ['grant_id', 'app_id', 'wapp_installation_id', 'publisher_npub', 'flightdeck_app_npub', 'owner_npub', 'grant_version', 'status', 'capabilities', 'destinations'],
          properties: {
            grant_id: { type: 'string', format: 'uuid' }, app_id: { type: 'string' }, wapp_installation_id: { type: 'string' },
            publisher_npub: { type: 'string' }, flightdeck_app_npub: { type: 'string' }, owner_npub: { type: 'string' }, display_name: { type: 'string' },
            publisher_key_version: { type: 'integer', minimum: 1 }, workspace_id: { type: 'string', format: 'uuid' }, grant_version: { type: 'integer', minimum: 1 },
            status: { type: 'string', enum: ['active', 'disabled', 'revoked'] }, capabilities: { type: 'array', items: { type: 'string' } },
            destinations: { type: 'array', items: { $ref: '#/components/schemas/WappPublishingDestination' } },
            registered_open_origins: { type: 'array', items: { type: 'string', format: 'uri' } }, disable_open_links: { type: 'boolean' },
            approved_by_npub: { type: 'string' }, last_published_at: { type: ['string', 'null'], format: 'date-time' },
            last_rejected_at: { type: ['string', 'null'], format: 'date-time' }, last_rejection_code: { type: ['string', 'null'] },
          },
        },
        WappActivityPublishRequest: {
          type: 'object', additionalProperties: false,
          required: ['external_id', 'version', 'scope_id', 'channel_id', 'category', 'title', 'occurred_at'],
          properties: {
            external_id: { type: 'string', minLength: 1, maxLength: 128 }, version: { type: 'integer', minimum: 1 },
            scope_id: { type: 'string', format: 'uuid' }, channel_id: { type: 'string', format: 'uuid' },
            category: { type: 'string', minLength: 1, maxLength: 128 }, title: { type: 'string', minLength: 1, maxLength: 160 },
            summary: { type: 'string', maxLength: 1200 }, occurred_at: { type: 'string', format: 'date-time' },
            priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
            state: { type: 'string', enum: ['active', 'resolved', 'withdrawn'], default: 'active' },
            open_url: { type: ['string', 'null'], format: 'uri', pattern: '^https://' },
          },
        },
        WappActivityItem: {
          allOf: [
            { $ref: '#/components/schemas/WappActivityPublishRequest' },
            { type: 'object', required: ['id', 'wapp_installation_id', 'publisher_npub', 'workspace_id', 'source_status', 'open_url_allowed', 'unread', 'muted'], properties: {
              id: { type: 'string', format: 'uuid' }, app_id: { type: 'string' }, wapp_installation_id: { type: 'string' }, publisher_npub: { type: 'string' },
              display_name: { type: 'string' }, workspace_id: { type: 'string', format: 'uuid' }, read_at: { type: ['string', 'null'], format: 'date-time' },
              source_status: { type: 'string', enum: ['active', 'disabled', 'revoked'], description: 'Current publishing grant status, re-evaluated when the feed is read.' },
              open_url_allowed: { type: 'boolean', description: 'Current server-derived permission to open open_url; the registered origin allowlist is not exposed on feed items.' },
              dismissed_at: { type: ['string', 'null'], format: 'date-time' }, unread: { type: 'boolean' }, muted: { type: 'boolean' },
            } },
          ],
        },
        WappActivityUserStatePatch: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: { read: { type: 'boolean' }, dismissed: { type: 'boolean' } },
        },
        FlightDeckPgAgentChatConfig: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled', 'context_prompt', 'activation'],
          properties: {
            enabled: { type: 'boolean', default: true, description: 'Always normalized to true; legacy false values no longer disable Agent Direct Chat.' },
            context_prompt: { type: 'string', maxLength: 8000 },
            activation: { type: 'string', enum: ['mention_then_continue'] },
          },
        },
        FlightDeckPgAgentMentionInput: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'npub'],
          properties: {
            type: { type: 'string', enum: ['agent', 'person'], description: 'Input hint retained for client compatibility; Tower resolves and canonicalizes the actor by npub.' },
            npub: { type: 'string', description: 'Full npub of a workspace actor with channel access.' },
            label: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
        FlightDeckPgAgentMention: {
          allOf: [
            { $ref: '#/components/schemas/FlightDeckPgAgentMentionInput' },
            { type: 'object', required: ['actor_id'], properties: { actor_id: { type: 'string', format: 'uuid' } } },
          ],
        },
        FlightDeckPgDocVersionIdentity: {
          type: 'object',
          required: ['version_id', 'row_version', 'storage_object_id', 'body_sha256_hex', 'size_bytes'],
          properties: {
            version_id: { type: 'string', description: 'Stable canonical identity formed from document ID and row version.' },
            row_version: { type: 'integer', minimum: 1 },
            storage_object_id: { type: 'string', format: 'uuid' },
            body_sha256_hex: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' },
            size_bytes: { type: ['integer', 'null'], minimum: 0 },
          },
        },
        FlightDeckPgDocRecoveryVersion: {
          type: 'object',
          required: ['id', 'workspace_id', 'doc_id', 'reason_code', 'resolution_state', 'base', 'head_at_creation', 'submitted_body', 'provenance', 'resolution', 'actions'],
          properties: {
            id: { type: 'string', format: 'uuid' }, workspace_id: { type: 'string', format: 'uuid' }, doc_id: { type: 'string', format: 'uuid' },
            reason_code: { type: 'string', enum: ['base_unavailable', 'stale_base', 'base_version_mismatch', 'base_body_mismatch', 'head_body_unverifiable'] },
            resolution_state: { type: 'string', enum: ['open', 'promoted', 'discarded'] },
            base: { type: ['object', 'null'], properties: { row_version: { type: 'integer', minimum: 1 }, version_id: { type: ['string', 'null'] }, body_sha256_hex: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' } } },
            head_at_creation: { type: 'object', required: ['row_version', 'version_id', 'storage_object_id', 'body_sha256_hex'], properties: { row_version: { type: 'integer', minimum: 1 }, version_id: { type: 'string' }, storage_object_id: { type: 'string', format: 'uuid' }, body_sha256_hex: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' } } },
            submitted_body: { type: 'object', required: ['version_id', 'storage_object_id', 'body_sha256_hex', 'route'], properties: { version_id: { type: 'string', format: 'uuid' }, storage_object_id: { type: 'string', format: 'uuid' }, body_sha256_hex: { type: 'string', pattern: '^[0-9a-f]{64}$' }, route: { type: 'string' } } },
            submitted_patch: { type: 'object', additionalProperties: true }, provenance: { type: 'object' }, resolution: { type: 'object' }, actions: { type: 'object' },
          },
        },
        FlightDeckPgMessageAttachment: {
          type: 'object',
          additionalProperties: true,
          required: ['storage_object_id'],
          properties: {
            storage_object_id: { type: 'string', format: 'uuid', description: 'Private Tower storage object validated and linked server-side to the created message.' },
            kind: { type: 'string' },
            filename: { type: 'string' },
            content_type: { type: 'string' },
            size_bytes: { type: 'integer', minimum: 0 },
          },
        },
        FlightDeckPgMessageCreateRequest: {
          type: 'object',
          required: ['body', 'message_signature'],
          properties: {
            body: { type: 'string', description: 'May be empty only when metadata.attachments contains at least one attachment.' },
            thread_id: { type: ['string', 'null'], format: 'uuid' },
            create_thread: { type: 'boolean', default: false },
            thread_title: { type: 'string' },
            client_request_id: { type: 'string', minLength: 1, maxLength: 240, description: 'Optional caller-scoped idempotency key, unique by workspace and authenticated actor.' },
            mentions: { type: 'array', items: { $ref: '#/components/schemas/FlightDeckPgAgentMentionInput' }, description: 'Typed alias for metadata.mentions; visible @text is never parsed as identity.' },
            metadata: { type: 'object', additionalProperties: true, properties: {
              mentions: { type: 'array', items: { $ref: '#/components/schemas/FlightDeckPgAgentMentionInput' } },
              attachments: { type: 'array', items: { $ref: '#/components/schemas/FlightDeckPgMessageAttachment' }, description: 'Every attachment is validated against the authenticated actor and PG workspace, then linked atomically to this channel/message. Browser-supplied storage ACL group IDs are not trusted.' },
            } },
            message_signature: { type: 'object', description: 'Instruction signature validated independently of descriptive metadata.' },
          },
        },
        FlightDeckPgMessageRevisionRequest: {
          type: 'object',
          additionalProperties: false,
          required: ['body', 'row_version', 'message_signature'],
          properties: {
            body: { type: 'string', description: 'Replacement body; may be empty only when the merged metadata retains at least one attachment.' },
            row_version: { type: 'integer', minimum: 1, description: 'Current message row_version. The signed revision is this value plus one.' },
            mentions: { type: 'array', items: { $ref: '#/components/schemas/FlightDeckPgAgentMentionInput' }, description: 'Complete replacement structured mention set. Omit to preserve the current set.' },
            metadata: { type: 'object', additionalProperties: true, description: 'Fields merge over existing metadata; canonical mentions and the validated signature are authority-written.', properties: {
              attachments: { type: 'array', items: { $ref: '#/components/schemas/FlightDeckPgMessageAttachment' }, description: 'Complete effective attachment set. Tower validates and reconciles message storage links atomically.' },
            } },
            message_signature: { type: 'object', description: 'Body-bound instruction signature additionally tagged with message_id and revision.' },
          },
        },
        GitRefConstraints: {
          type: 'object', additionalProperties: false, required: ['prefixes'],
          properties: {
            prefixes: { type: 'array', maxItems: 20, items: { type: 'string', pattern: '^refs/heads/(work|feature)/' } },
          },
        },
        GitRepository: {
          type: 'object', additionalProperties: false,
          required: ['repository_id', 'workspace_id', 'git_namespace', 'git_path', 'scope_id', 'slug', 'display_name', 'description', 'visibility', 'default_branch', 'state', 'policy_revision', 'created_by_actor_id', 'created_at', 'updated_at'],
          properties: {
            repository_id: { type: 'string', format: 'uuid' }, workspace_id: { type: 'string', format: 'uuid' },
            git_namespace: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,38}$' },
            git_path: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9._-]{0,62}$' },
            scope_id: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
            slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,62}$' }, display_name: { type: 'string', maxLength: 160 },
            description: { type: 'string', maxLength: 2000 }, visibility: { type: 'string', enum: ['private'] },
            default_branch: { type: 'string', enum: ['main'] }, state: { type: 'string', enum: ['registered', 'provisioning', 'active', 'archived'] },
            policy_revision: { type: 'integer', minimum: 1 }, created_by_actor_id: { type: 'string', format: 'uuid' },
            created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
          },
        },
        GitIssueAuthor: {
          type: 'object', additionalProperties: false, required: ['username', 'display_name'],
          properties: {
            username: { type: 'string' },
            display_name: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
        GitIssueLabel: {
          type: 'object', additionalProperties: false, required: ['name', 'color'],
          properties: {
            name: { type: 'string' }, color: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
        GitIssue: {
          type: 'object', additionalProperties: false,
          required: ['issue_number', 'title', 'body', 'state', 'url', 'author', 'labels', 'comment_count', 'created_at', 'updated_at', 'closed_at'],
          properties: {
            issue_number: { type: 'integer', minimum: 1 }, title: { type: 'string' }, body: { type: 'string' },
            state: { type: 'string', enum: ['open', 'closed'] }, url: { type: 'string', format: 'uri' },
            author: { $ref: '#/components/schemas/GitIssueAuthor' },
            labels: { type: 'array', items: { $ref: '#/components/schemas/GitIssueLabel' } },
            comment_count: { type: 'integer', minimum: 0 }, created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
            closed_at: { oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
          },
        },
        GitIssueComment: {
          type: 'object', additionalProperties: false,
          required: ['comment_id', 'issue_number', 'body', 'url', 'author', 'created_at', 'updated_at'],
          properties: {
            comment_id: { type: 'integer', minimum: 1 }, issue_number: { type: 'integer', minimum: 1 },
            body: { type: 'string' }, url: { type: 'string', format: 'uri' },
            author: { $ref: '#/components/schemas/GitIssueAuthor' },
            created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
          },
        },
        CreateGitIssueRequest: {
          type: 'object', additionalProperties: false, required: ['title'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 255 },
            body: { type: 'string', maxLength: 100000 }, correlation_id: { type: 'string', maxLength: 128 },
          },
        },
        CreateGitIssueCommentRequest: {
          type: 'object', additionalProperties: false, required: ['body'],
          properties: {
            body: { type: 'string', minLength: 1, maxLength: 100000 }, correlation_id: { type: 'string', maxLength: 128 },
          },
        },
        CreateGitRepositoryRequest: {
          type: 'object', additionalProperties: false, required: ['slug', 'display_name'],
          properties: {
            slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,62}$' }, display_name: { type: 'string', maxLength: 160 },
            description: { type: 'string', maxLength: 2000 }, scope_id: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
          },
        },
        ClaimGitWorkspaceNamespaceRequest: {
          type: 'object', additionalProperties: false, required: ['namespace'],
          properties: { namespace: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,38}$' } },
        },
        GitWorkspaceNamespace: {
          type: 'object', additionalProperties: false,
          required: ['workspace_id', 'namespace', 'locked', 'created_at', 'updated_at'],
          properties: {
            workspace_id: { type: 'string', format: 'uuid' },
            namespace: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,38}$' },
            locked: { type: 'boolean' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        UpdateGitActorUsernameRequest: {
          type: 'object', additionalProperties: false, required: ['username'],
          properties: { username: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,38}$' } },
        },
        GitActorBootstrap: {
          type: 'object', required: ['actor_id', 'workspace_id', 'state', 'account_state', 'organization_state', 'actor_username', 'last_error_code'],
          properties: {
            actor_id: { type: 'string', format: 'uuid' }, workspace_id: { type: 'string', format: 'uuid' },
            state: { type: 'string', enum: ['not_requested', 'pending', 'ready', 'error'] },
            account_state: { type: 'string', enum: ['not_requested', 'pending', 'ready', 'error'] },
            organization_state: { type: 'string', enum: ['pending', 'ready', 'error'] },
            last_error_code: { type: 'string', nullable: true }, actor_username: { $ref: '#/components/schemas/GitActorUsername' },
          },
        },
        GitActorUsername: {
          type: 'object', additionalProperties: false,
          required: ['actor_id', 'username', 'applied_username', 'state', 'last_error_code', 'created_at', 'updated_at'],
          properties: {
            actor_id: { type: 'string', format: 'uuid' },
            username: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,38}$' },
            applied_username: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,38}$' },
            state: { type: 'string', enum: ['pending', 'ready', 'error'] },
            last_error_code: { type: ['string', 'null'] },
            created_at: { type: ['string', 'null'], format: 'date-time' },
            updated_at: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        GitRepositoryGrant: {
          type: 'object', additionalProperties: false,
          required: ['grant_id', 'repository_id', 'principal_type', 'principal_actor_id', 'principal_group_id', 'permission', 'ref_constraints', 'created_by_actor_id', 'created_at', 'revoked_by_actor_id', 'revoked_at'],
          properties: {
            grant_id: { type: 'string', format: 'uuid' }, repository_id: { type: 'string', format: 'uuid' },
            principal_type: { type: 'string', enum: ['actor', 'group'] },
            principal_actor_id: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
            principal_group_id: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
            permission: { type: 'string', enum: ['git.repo.read', 'git.repo.write', 'git.branch.create', 'git.repo.admin'] },
            ref_constraints: { $ref: '#/components/schemas/GitRefConstraints' }, created_by_actor_id: { type: 'string', format: 'uuid' },
            created_at: { type: 'string', format: 'date-time' }, revoked_by_actor_id: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
            revoked_at: { oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
          },
        },
        CreateGitRepositoryGrantRequest: {
          type: 'object', additionalProperties: false, required: ['principal_type', 'principal_id', 'permission'],
          properties: {
            principal_type: { type: 'string', enum: ['actor', 'group'] }, principal_id: { type: 'string', format: 'uuid' },
            permission: { type: 'string', enum: ['git.repo.read', 'git.repo.write', 'git.branch.create', 'git.repo.admin'] },
            ref_constraints: { $ref: '#/components/schemas/GitRefConstraints' },
          },
        },
        GitBranchPolicy: {
          type: 'object', additionalProperties: false,
          required: ['ref_name', 'branch_class', 'protected', 'service_managed', 'allow_direct_push', 'allow_force_push', 'allow_delete', 'required_approvals', 'required_checks', 'merge_methods'],
          properties: {
            policy_id: { type: 'string', format: 'uuid' }, ref_name: { type: 'string', pattern: '^refs/heads/' },
            branch_class: { type: 'string', enum: ['main', 'staging', 'deployed', 'work'] }, protected: { type: 'boolean' }, service_managed: { type: 'boolean' },
            allow_direct_push: { type: 'boolean' }, allow_force_push: { type: 'boolean' }, allow_delete: { type: 'boolean' },
            required_approvals: { type: 'integer', minimum: 0, maximum: 20 }, required_checks: { type: 'array', items: { type: 'string' } },
            merge_methods: { type: 'array', minItems: 1, items: { type: 'string', enum: ['squash', 'merge', 'rebase'] } },
          },
        },
        GitRepositoryPolicy: {
          type: 'object', additionalProperties: false, required: ['repository_id', 'policy_revision', 'branch_rules'],
          properties: {
            repository_id: { type: 'string', format: 'uuid' }, policy_revision: { type: 'integer', minimum: 1 },
            branch_rules: { type: 'array', minItems: 3, items: { $ref: '#/components/schemas/GitBranchPolicy' } },
          },
        },
        UpdateGitRepositoryPolicyRequest: {
          type: 'object', additionalProperties: false, required: ['expected_policy_revision', 'branch_rules'],
          properties: {
            expected_policy_revision: { type: 'integer', minimum: 1 },
            branch_rules: { type: 'array', minItems: 3, maxItems: 20, items: { $ref: '#/components/schemas/GitBranchPolicy' } },
          },
        },
        GitCredentialExchangeRequest: {
          type: 'object', additionalProperties: false,
          required: ['repository_id', 'audience'],
          description: 'Current clients send repository_id and audience; Tower resolves the authenticated actor and derives all transport scopes. actor_id, service, and requested_scopes form an all-or-nothing restricted legacy request.',
          properties: {
            repository_id: { type: 'string', format: 'uuid' }, actor_id: { type: 'string', format: 'uuid' }, audience: { type: 'string' },
            service: { type: 'string', enum: ['upload-pack', 'receive-pack'] },
            requested_scopes: { type: 'array', minItems: 1, items: { type: 'string', enum: ['git.fetch', 'git.push.unprotected', 'git.push.branch_create'] } },
            autopilot_instance_npub: { type: 'string' }, session_id: { type: 'string', maxLength: 128 },
            task_id: { type: 'string', format: 'uuid' }, workroom_id: { type: 'string', format: 'uuid' }, correlation_id: { type: 'string', maxLength: 128 },
          },
        },
        GitCredentialExchangeResponse: {
          type: 'object', additionalProperties: false,
          description: 'The only response containing the opaque capability plaintext. Tower persists only its keyed hash.',
          required: ['capability_id', 'username', 'capability', 'repository_id', 'actor_id', 'signer_npub', 'audience', 'service', 'scopes', 'policy_revision', 'expires_at'],
          properties: {
            capability_id: { type: 'string', format: 'uuid' }, username: { type: 'string', enum: ['nostr'] }, capability: { type: 'string', writeOnly: true },
            repository_id: { type: 'string', format: 'uuid' }, actor_id: { type: 'string', format: 'uuid' }, signer_npub: { type: 'string' }, audience: { type: 'string' },
            service: { type: ['string', 'null'], enum: ['upload-pack', 'receive-pack', null] }, scopes: { type: 'array', items: { type: 'string' } },
            policy_revision: { type: 'integer', minimum: 1 }, expires_at: { type: 'string', format: 'date-time' },
          },
        },
        GitCapabilityIntrospectionRequest: {
          type: 'object', additionalProperties: false, required: ['capability', 'repository_id', 'audience', 'service', 'required_scope'],
          properties: {
            capability: { type: 'string', writeOnly: true }, repository_id: { type: 'string', format: 'uuid' }, audience: { type: 'string' },
            service: { type: 'string', enum: ['upload-pack', 'receive-pack'] },
            required_scope: { type: 'string', enum: ['git.fetch', 'git.push.unprotected', 'git.push.branch_create'] }, correlation_id: { type: 'string' },
          },
        },
        GitCapabilityIntrospectionResponse: {
          type: 'object', additionalProperties: false, required: ['active', 'reason_code'],
          properties: {
            active: { type: 'boolean' }, reason_code: { type: 'string' }, capability_id: { type: 'string', format: 'uuid' },
            repository_id: { type: 'string', format: 'uuid' }, actor_id: { type: 'string', format: 'uuid' }, actor_username: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,38}$' }, actor_display_name: { type: 'string', maxLength: 120 }, signer_npub: { type: 'string' }, audience: { type: 'string' },
            service: { type: 'string', enum: ['upload-pack', 'receive-pack'] }, scopes: { type: 'array', items: { type: 'string' } },
            ref_constraints: { $ref: '#/components/schemas/GitRefConstraints' }, policy_revision: { type: 'integer' }, expires_at: { type: 'string', format: 'date-time' },
          },
        },
        GitForgejoRepositoryBinding: {
          type: 'object',
          required: ['repository_id', 'workspace_id', 'forgejo_owner', 'forgejo_repository', 'desired_policy_revision', 'applied_policy_revision', 'state', 'reconciled_at'],
          properties: {
            repository_id: { type: 'string', format: 'uuid' }, workspace_id: { type: 'string', format: 'uuid' },
            forgejo_owner: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,38}$' },
            forgejo_repository: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,62}$' },
            desired_policy_revision: { type: 'integer', minimum: 1 },
            applied_policy_revision: { type: ['integer', 'null'], minimum: 1 },
            state: { type: 'string', enum: ['pending', 'ready', 'error'] },
            reconciled_at: { type: ['string', 'null'], format: 'date-time' },
            ready: { type: 'boolean' },
          },
        },
        RevokeGitCapabilityRequest: {
          type: 'object', additionalProperties: false, required: ['capability_id', 'repository_id', 'audience', 'reason'],
          properties: {
            capability_id: { type: 'string', format: 'uuid' }, repository_id: { type: 'string', format: 'uuid' }, audience: { type: 'string' },
            reason: { type: 'string', maxLength: 240 }, correlation_id: { type: 'string', maxLength: 128 },
          },
        },
        GitAuditEvent: {
          type: 'object', additionalProperties: false,
          description: 'Normalized immutable security evidence. Capability plaintext and service credentials are never represented.',
          required: ['event_id', 'source', 'workspace_id', 'repository_id', 'actor_id', 'actor_npub', 'signer_npub', 'operation', 'requested_scope', 'service', 'decision', 'reason_code', 'policy_revision', 'capability_hash_prefix', 'autopilot_instance_npub', 'session_id', 'task_id', 'workroom_id', 'correlation_id', 'occurred_at'],
          properties: {
            event_id: { type: 'string', format: 'uuid' }, source: { type: 'string', enum: ['tower', 'wingman-git', 'forgejo'] },
            workspace_id: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] }, repository_id: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
            actor_id: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] }, actor_npub: { type: ['string', 'null'] }, signer_npub: { type: ['string', 'null'] },
            operation: { type: 'string' }, requested_scope: { type: ['string', 'null'] }, service: { type: ['string', 'null'] },
            decision: { type: 'string', enum: ['allow', 'deny'] }, reason_code: { type: 'string' }, policy_revision: { type: ['integer', 'null'] },
            capability_hash_prefix: { type: ['string', 'null'], pattern: '^[a-f0-9]{12}$' }, autopilot_instance_npub: { type: ['string', 'null'] },
            session_id: { type: ['string', 'null'] }, task_id: { type: ['string', 'null'] }, workroom_id: { type: ['string', 'null'] },
            correlation_id: { type: ['string', 'null'] }, occurred_at: { type: 'string', format: 'date-time' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            code: {
              type: 'string',
              nullable: true,
              description: 'Stable machine-readable error code. Identity/groupId clients should handle identity_alias_mismatch, workspace_key_missing, workspace_key_invalid, workspace_key_revoked, legacy_write_group_npub_forbidden, legacy_write_group_npub, and insufficient_credits.',
            },
            status: { type: 'integer', nullable: true },
            reason_code: { type: 'string', nullable: true },
            workspace_owner_npub: { type: 'string', nullable: true },
            workspace_service_npub: { type: 'string', nullable: true },
            user_npub: { type: 'string', nullable: true },
            signer_npub: { type: 'string', nullable: true },
            actor_npub: { type: 'string', nullable: true },
            ws_key_npub: { type: 'string', nullable: true },
            workspace_user_key_npub: { type: 'string', nullable: true },
            record_id: { type: 'string', nullable: true },
            record_family_hash: { type: 'string', nullable: true },
            tower_latest_version: { type: 'integer', nullable: true },
            required_previous_version: { type: 'integer', nullable: true },
            received_previous_version: { type: 'integer', nullable: true },
            checkout: {
              oneOf: [
                { $ref: '#/components/schemas/RecordCheckoutState' },
                { type: 'null' },
              ],
            },
            details: {
              type: 'object',
              additionalProperties: true,
              nullable: true,
            },
          },
          required: ['error'],
        },
        TowerBuildInfo: {
          type: 'object',
          properties: {
            name: { type: 'string', example: 'wingman-tower' },
            version: { type: ['string', 'null'], example: '0.1.0' },
            git_commit: { type: ['string', 'null'], example: '3f4a2b1c9d8e7f6a5b4c3d2e1f0a987654321abc' },
            git_branch: { type: ['string', 'null'], example: 'main' },
            build_time: { type: ['string', 'null'], format: 'date-time' },
            runtime: { type: 'string', example: 'bun 1.2.0' },
          },
          required: ['name', 'version', 'git_commit', 'git_branch', 'build_time', 'runtime'],
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            service_npub: { type: ['string', 'null'], example: 'npub1...' },
            build: { $ref: '#/components/schemas/TowerBuildInfo' },
            sse_connections: { type: 'integer', minimum: 0 },
            graph: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                allowed_npubs_configured: { type: 'boolean' },
              },
              required: ['enabled', 'allowed_npubs_configured'],
            },
          },
          required: ['status', 'service_npub', 'build', 'sse_connections', 'graph'],
        },
        GraphMemory: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            workspace_owner_npub: { type: ['string', 'null'] },
            owner_npub: { type: ['string', 'null'] },
            actor_npub: { type: ['string', 'null'] },
            source_app_npub: { type: ['string', 'null'] },
            group_id: { type: ['string', 'null'], format: 'uuid' },
            visibility: { type: 'string', enum: ['personal', 'agent', 'group', 'workspace'] },
            memory_type: { type: 'string' },
            title: { type: ['string', 'null'] },
            summary: { type: ['string', 'null'] },
            body_ciphertext: { type: 'string' },
            metadata: { type: 'object', additionalProperties: true },
            created_by_npub: { type: 'string' },
            updated_by_npub: { type: ['string', 'null'] },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'workspace_owner_npub', 'owner_npub', 'actor_npub', 'source_app_npub', 'group_id', 'visibility', 'memory_type', 'body_ciphertext', 'metadata', 'created_by_npub', 'updated_by_npub', 'created_at', 'updated_at'],
        },
        GraphMemoryEntityInput: {
          type: 'object',
          properties: {
            entity_type: { type: 'string' },
            entity_key: { type: 'string' },
            display_name: { type: 'string' },
            relation: { type: 'string', default: 'mentions' },
            weight: { type: 'number', default: 1 },
            metadata: { type: 'object', additionalProperties: true },
          },
          required: ['entity_type', 'entity_key'],
        },
        GraphMemoryAclInput: {
          type: 'object',
          properties: {
            principal_npub: { type: 'string' },
            actor_npub: { type: 'string' },
            group_id: { type: 'string', format: 'uuid' },
            access: { type: 'string', enum: ['read', 'write', 'owner'] },
          },
          required: ['access'],
        },
        CreateGraphMemoryRequest: {
          type: 'object',
          properties: {
            workspace_owner_npub: { type: 'string' },
            visibility: { type: 'string', enum: ['personal', 'agent', 'group', 'workspace'] },
            owner_npub: { type: 'string', description: 'Ignored for v1; personal ownership is resolved from NIP-98 user_npub.' },
            actor_npub: { type: 'string', description: 'Must match signer_npub or resolved user_npub until delegation support exists.' },
            source_app_npub: { type: 'string' },
            group_id: { type: 'string', format: 'uuid' },
            memory_type: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            body_ciphertext: { type: 'string' },
            metadata: { type: 'object', additionalProperties: true },
            entities: { type: 'array', items: { $ref: '#/components/schemas/GraphMemoryEntityInput' } },
            acl: { type: 'array', items: { $ref: '#/components/schemas/GraphMemoryAclInput' } },
          },
          required: ['visibility', 'memory_type', 'body_ciphertext'],
        },
        GraphMemoryResponse: {
          type: 'object',
          properties: {
            memory: { $ref: '#/components/schemas/GraphMemory' },
          },
          required: ['memory'],
        },
        GraphMemoryListResponse: {
          type: 'object',
          properties: {
            memories: { type: 'array', items: { $ref: '#/components/schemas/GraphMemory' } },
            total: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
            offset: { type: 'integer', minimum: 0 },
            has_more: { type: 'boolean' },
          },
          required: ['memories', 'total', 'limit', 'offset', 'has_more'],
        },
        NativeGraphNodeInput: {
          type: 'object',
          properties: {
            external_id: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            node_type: { type: 'string' },
            properties: { type: 'object', additionalProperties: true },
            property_mode: { type: 'string', enum: ['merge', 'replace'], description: 'Controls whether supplied properties merge with or replace the stored object.' },
          },
          required: ['external_id'],
        },
        NativeGraphEdgeInput: {
          type: 'object',
          properties: {
            external_id: { type: 'string', description: 'Optional. If omitted, Tower derives one from from_external_id, relationship_type, and to_external_id.' },
            from_external_id: { type: 'string' },
            to_external_id: { type: 'string' },
            relationship_type: { type: 'string' },
            properties: { type: 'object', additionalProperties: true },
            property_mode: { type: 'string', enum: ['merge', 'replace'], description: 'Controls whether supplied properties merge with or replace the stored object.' },
          },
          required: ['from_external_id', 'to_external_id', 'relationship_type'],
        },
        NativeGraphNode: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            external_id: { type: 'string' },
            source: { type: 'string' },
            run_id: { type: ['string', 'null'] },
            node_type: { type: ['string', 'null'] },
            labels: { type: 'array', items: { type: 'string' } },
            properties: { type: 'object', additionalProperties: true },
            visibility: { type: 'string', enum: ['personal', 'agent', 'group'] },
            workspace_owner_npub: { type: ['string', 'null'] },
            owner_npub: { type: ['string', 'null'] },
            actor_npub: { type: ['string', 'null'] },
            source_app_npub: { type: ['string', 'null'] },
            group_id: { type: ['string', 'null'], format: 'uuid' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'external_id', 'source', 'run_id', 'labels', 'properties', 'visibility', 'workspace_owner_npub', 'owner_npub', 'actor_npub', 'source_app_npub', 'group_id', 'created_at', 'updated_at'],
        },
        NativeGraphEdge: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            external_id: { type: 'string' },
            source: { type: 'string' },
            run_id: { type: ['string', 'null'] },
            source_node_id: { type: 'string', format: 'uuid' },
            target_node_id: { type: 'string', format: 'uuid' },
            from_external_id: { type: 'string' },
            to_external_id: { type: 'string' },
            relationship_type: { type: 'string' },
            properties: { type: 'object', additionalProperties: true },
            visibility: { type: 'string', enum: ['personal', 'agent', 'group'] },
            workspace_owner_npub: { type: ['string', 'null'] },
            owner_npub: { type: ['string', 'null'] },
            actor_npub: { type: ['string', 'null'] },
            source_app_npub: { type: ['string', 'null'] },
            group_id: { type: ['string', 'null'], format: 'uuid' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'external_id', 'source', 'run_id', 'source_node_id', 'target_node_id', 'relationship_type', 'properties', 'visibility', 'workspace_owner_npub', 'owner_npub', 'actor_npub', 'source_app_npub', 'group_id', 'created_at', 'updated_at'],
        },
        NativeGraphImportRequest: {
          type: 'object',
          properties: {
            run_id: { type: 'string' },
            source: { type: 'string' },
            visibility: { type: 'string', enum: ['personal', 'agent', 'group'] },
            workspace_owner_npub: { type: 'string' },
            owner_npub: { type: 'string' },
            actor_npub: { type: 'string' },
            source_app_npub: { type: 'string' },
            group_id: { type: 'string', format: 'uuid' },
            metadata: { type: 'object', additionalProperties: true },
            schema: { type: 'object', additionalProperties: true },
            nodes: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphNodeInput' } },
            edges: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphEdgeInput' } },
          },
          required: ['run_id', 'source', 'visibility'],
        },
        NativeGraphImportResponse: {
          type: 'object',
          properties: {
            import_run: { type: 'object', additionalProperties: true },
            nodes: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphNode' } },
            edges: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphEdge' } },
          },
          required: ['import_run', 'nodes', 'edges'],
        },
        GraphRepositoryDeltaRequest: {
          type: 'object',
          description: 'Transactional, checkpointed mutations for one generated repository subgraph. Node, edge, and deletion external IDs must use the submitting <corpus_id>:<repository_id>: prefix. Edge endpoints may reference existing nodes from another repository in the same corpus when they share the resolved source and security scope.',
          properties: {
            source: { type: 'string' },
            corpus_id: { type: 'string', pattern: '^[A-Za-z0-9._/-]+$' },
            repository_id: { type: 'string', pattern: '^[A-Za-z0-9._/-]+$' },
            base_sha: { type: ['string', 'null'], description: 'Required for incremental mode and must equal the current checkpoint.' },
            head_sha: { type: 'string' },
            schema_version: { type: 'string' },
            mode: { type: 'string', enum: ['incremental', 'full_rebuild'] },
            visibility: { type: 'string', enum: ['personal', 'agent', 'group'] },
            workspace_owner_npub: { type: 'string' }, owner_npub: { type: 'string' }, actor_npub: { type: 'string' },
            source_app_npub: { type: 'string' }, group_id: { type: 'string', format: 'uuid' },
            parser_metadata: { type: 'object', additionalProperties: true },
            index_metadata: { type: 'object', additionalProperties: true },
            metadata: { type: 'object', additionalProperties: true },
            schema: { type: 'object', additionalProperties: true },
            nodes: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphNodeInput' } },
            edges: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphEdgeInput' } },
            delete_node_external_ids: { type: 'array', items: { type: 'string' } },
            delete_edge_external_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['source', 'corpus_id', 'repository_id', 'head_sha', 'schema_version', 'mode', 'visibility'],
        },
        GraphRepositoryCheckpoint: {
          type: 'object',
          properties: {
            source: { type: 'string' }, corpus_id: { type: 'string' }, repository_id: { type: 'string' },
            head_sha: { type: 'string' }, schema_version: { type: 'string' },
            parser_metadata: { type: 'object', additionalProperties: true }, index_metadata: { type: 'object', additionalProperties: true },
            updated_at: { type: 'string', format: 'date-time' },
          },
          required: ['source', 'corpus_id', 'repository_id', 'head_sha', 'schema_version', 'parser_metadata', 'index_metadata', 'updated_at'],
        },
        GraphRepositoryDeltaResponse: {
          type: 'object',
          properties: {
            replayed: { type: 'boolean' },
            checkpoint: { $ref: '#/components/schemas/GraphRepositoryCheckpoint' },
            counts: {
              type: 'object',
              properties: {
                nodes_upserted: { type: 'integer' }, edges_upserted: { type: 'integer' },
                nodes_deleted: { type: 'integer' }, edges_deleted: { type: 'integer' }, schema_upserted: { type: 'integer' },
              },
              required: ['nodes_upserted', 'edges_upserted', 'nodes_deleted', 'edges_deleted', 'schema_upserted'],
            },
          },
          required: ['checkpoint', 'replayed', 'counts'],
        },
        NativeGraphBulkNodesRequest: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            run_id: { type: 'string' },
            visibility: { type: 'string', enum: ['personal', 'agent', 'group'] },
            workspace_owner_npub: { type: 'string' },
            owner_npub: { type: 'string' },
            actor_npub: { type: 'string' },
            source_app_npub: { type: 'string' },
            group_id: { type: 'string', format: 'uuid' },
            nodes: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphNodeInput' } },
          },
          required: ['source', 'visibility', 'nodes'],
        },
        NativeGraphBulkNodesResponse: {
          type: 'object',
          properties: {
            nodes: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphNode' } },
            count: { type: 'integer', minimum: 0 },
          },
          required: ['nodes', 'count'],
        },
        NativeGraphBulkEdgesRequest: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            run_id: { type: 'string' },
            visibility: { type: 'string', enum: ['personal', 'agent', 'group'] },
            workspace_owner_npub: { type: 'string' },
            owner_npub: { type: 'string' },
            actor_npub: { type: 'string' },
            source_app_npub: { type: 'string' },
            group_id: { type: 'string', format: 'uuid' },
            edges: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphEdgeInput' } },
          },
          required: ['source', 'visibility', 'edges'],
        },
        NativeGraphBulkEdgesResponse: {
          type: 'object',
          properties: {
            edges: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphEdge' } },
            count: { type: 'integer', minimum: 0 },
          },
          required: ['edges', 'count'],
        },
        NativeGraphNodesResponse: {
          type: 'object',
          properties: {
            nodes: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphNode' } },
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
            has_more: { type: 'boolean' },
          },
          required: ['nodes', 'total', 'limit', 'offset', 'has_more'],
        },
        NativeGraphEdgesResponse: {
          type: 'object',
          properties: {
            edges: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphEdge' } },
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
            has_more: { type: 'boolean' },
          },
          required: ['edges', 'total', 'limit', 'offset', 'has_more'],
        },
        NativeGraphNeighborhoodResponse: {
          type: 'object',
          properties: {
            center: { $ref: '#/components/schemas/NativeGraphNode' },
            nodes: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphNode' } },
            edges: { type: 'array', items: { $ref: '#/components/schemas/NativeGraphEdge' } },
          },
          required: ['center', 'nodes', 'edges'],
        },
        GraphSearchResult: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['node', 'edge', 'memory'] },
            score: { type: 'number', minimum: 0, maximum: 1 },
            id: { type: 'string', format: 'uuid' },
            external_id: { type: 'string' },
            source: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            title: { type: ['string', 'null'] },
            memory_type: { type: 'string' },
            relationship_type: { type: 'string' },
            from_external_id: { type: 'string' },
            to_external_id: { type: 'string' },
            summary: { type: ['string', 'null'] },
            properties: {
              type: 'object',
              additionalProperties: true,
              description: 'Compact selected text-like properties only; large arbitrary graph JSON is not returned by search.',
            },
          },
          required: ['kind', 'score', 'id', 'properties'],
        },
        GraphSearchResponse: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            results: { type: 'array', items: { $ref: '#/components/schemas/GraphSearchResult' } },
            total: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
          required: ['query', 'results', 'total', 'limit'],
        },
        WorkspaceUsage: {
          type: 'object',
          properties: {
            workspace_owner_npub: { type: 'string' },
            record_bytes: { type: 'integer' },
            object_bytes: { type: 'integer' },
            billable_bytes: { type: 'integer' },
            billable_mb: { type: 'string', example: '3.000000' },
            estimated_credits_per_hour: { type: 'string', example: '3.000000' },
          },
          required: ['workspace_owner_npub', 'record_bytes', 'object_bytes', 'billable_bytes', 'billable_mb', 'estimated_credits_per_hour'],
        },
        BillingStatus: {
          type: 'object',
          properties: {
            billing_mode: { type: 'string', enum: ['disabled', 'metered'] },
            workspace_owner_npub: { type: 'string' },
            workspace_name: { type: 'string' },
            billing_state: { type: 'string', enum: ['disabled', 'active', 'low_balance', 'read_only_grace', 'delete_eligible', 'suspended'] },
            balance_credits: { type: 'string', example: '120.000000' },
            usage: { $ref: '#/components/schemas/WorkspaceUsage' },
            estimated_runout_at: { type: ['string', 'null'], format: 'date-time' },
            depleted_at: { type: ['string', 'null'], format: 'date-time' },
            delete_eligible_at: { type: ['string', 'null'], format: 'date-time' },
            billing_url: { type: 'string', format: 'uri' },
          },
          required: ['billing_mode', 'workspace_owner_npub', 'workspace_name', 'billing_state', 'balance_credits', 'usage', 'estimated_runout_at', 'depleted_at', 'delete_eligible_at', 'billing_url'],
        },
        BillingWorkspacesResponse: {
          type: 'object',
          properties: {
            billing_mode: { type: 'string', enum: ['disabled', 'metered'] },
            workspaces: { type: 'array', items: { $ref: '#/components/schemas/BillingStatus' } },
          },
          required: ['billing_mode', 'workspaces'],
        },
        BillingPurchaseRequest: {
          type: 'object',
          properties: {
            quantity_credits: { type: 'number', exclusiveMinimum: 0 },
          },
          required: ['quantity_credits'],
        },
        BillingOrderResponse: {
          type: 'object',
          properties: {
            order_id: { type: 'string', format: 'uuid' },
            mginx_order_id: { type: 'string' },
            product_id: { type: 'string' },
            quantity_credits: { type: 'string' },
            amount_sats: { type: 'integer' },
            invoice: { type: 'string' },
            bolt11: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'paid', 'expired', 'cancelled'] },
            expires_at: { type: ['string', 'null'], format: 'date-time' },
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['order_id', 'mginx_order_id', 'product_id', 'quantity_credits', 'amount_sats', 'invoice', 'bolt11', 'status'],
        },
        WorkspaceCreditTransaction: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            workspace_owner_npub: { type: 'string' },
            type: { type: 'string', enum: ['purchase', 'hourly_usage', 'manual_adjustment', 'refund', 'migration_grant'] },
            amount_credits: { type: 'string' },
            balance_before_credits: { type: 'string' },
            balance_after_credits: { type: 'string' },
            reference_type: { type: ['string', 'null'] },
            reference_id: { type: ['string', 'null'] },
            notes: { type: ['string', 'null'] },
            metadata: { type: 'object', additionalProperties: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        WorkspaceApp: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            workspace_owner_npub: { type: 'string' },
            app_npub: { type: 'string' },
            app_name: { type: 'string' },
            enabled: { type: 'boolean' },
            capabilities: { type: 'array', items: { type: 'string' } },
            created_by_npub: { type: 'string' },
            updated_at: { type: 'string', format: 'date-time' },
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'workspace_owner_npub', 'app_npub', 'app_name', 'enabled', 'capabilities', 'created_by_npub', 'updated_at', 'created_at'],
        },
        CreateWorkspaceAppRequest: {
          type: 'object',
          properties: {
            app_npub: { type: 'string' },
            app_name: { type: 'string' },
            enabled: { type: 'boolean', default: true },
            capabilities: { type: 'array', items: { type: 'string' } },
          },
          required: ['app_npub'],
        },
        WorkspaceAppNamespaceDescriptor: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['wingman_workspace_locator'] },
            version: { type: 'integer', enum: [1] },
            installed: { type: 'boolean' },
            enabled: { type: 'boolean' },
            app_npub: { type: 'string' },
            app_name: { type: ['string', 'null'] },
            tower_base_url: { type: 'string', format: 'uri' },
            tower_service_npub: { type: ['string', 'null'] },
            service_npub: { type: ['string', 'null'] },
            workspace_service_npub: { type: 'string' },
            workspace_owner_npub: { type: 'string' },
            workspace_id: { type: ['string', 'null'], format: 'uuid' },
            schema_version: { type: ['integer', 'null'] },
            schema_hash: { type: ['string', 'null'] },
            capabilities: { type: 'array', items: { type: 'string' } },
            created_at: { type: ['integer', 'null'] },
          },
          required: ['type', 'version', 'installed', 'enabled', 'app_npub', 'app_name', 'tower_base_url', 'tower_service_npub', 'service_npub', 'workspace_service_npub', 'workspace_owner_npub', 'workspace_id', 'schema_version', 'schema_hash', 'capabilities', 'created_at'],
        },
        WorkspaceAppNamespaceDescriptorResponse: {
          type: 'object',
          properties: {
            viewer: { type: 'string' },
            descriptor: { $ref: '#/components/schemas/WorkspaceAppNamespaceDescriptor' },
          },
          required: ['viewer', 'descriptor'],
        },
        WorkspaceAppSchemaFamily: {
          type: 'object',
          properties: {
            record_family_hash: { type: 'string' },
            collection_space: { type: 'string' },
            schema_version: { type: 'integer' },
            schema_hash: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['record_family_hash', 'schema_version'],
        },
        WorkspaceAppSchemaManifest: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            workspace_owner_npub: { type: 'string' },
            app_npub: { type: 'string' },
            app_name: { type: 'string' },
            schema_hash: { type: 'string' },
            schema_version: { type: 'integer' },
            record_families: { type: 'array', items: { $ref: '#/components/schemas/WorkspaceAppSchemaFamily' } },
            owner_payload: {
              type: 'object',
              properties: { ciphertext: { type: 'string' } },
              required: ['ciphertext'],
            },
            group_payloads: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  group_id: { type: 'string', format: 'uuid' },
                  group_epoch: { type: 'integer' },
                  group_npub: { type: 'string' },
                  ciphertext: { type: 'string' },
                  write: { type: 'boolean' },
                },
                required: ['group_npub', 'ciphertext', 'write'],
              },
            },
            created_by_npub: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'workspace_owner_npub', 'app_npub', 'app_name', 'schema_hash', 'schema_version', 'record_families', 'owner_payload', 'group_payloads', 'created_by_npub', 'created_at', 'updated_at'],
        },
        PublishWorkspaceAppSchemaRequest: {
          type: 'object',
          properties: {
            app_name: { type: 'string' },
            schema_hash: { type: 'string' },
            schema_version: { type: 'integer', default: 1 },
            capabilities: { type: 'array', items: { type: 'string' } },
            record_families: { type: 'array', items: { $ref: '#/components/schemas/WorkspaceAppSchemaFamily' } },
            owner_payload: {
              type: 'object',
              properties: { ciphertext: { type: 'string' } },
              required: ['ciphertext'],
            },
            group_payloads: {
              type: 'array',
              description: 'Opaque encrypted schema bundle payloads, ideally one for each workspace group that should be able to decrypt the app schema.',
              items: {
                type: 'object',
                properties: {
                  group_id: { type: 'string', format: 'uuid' },
                  group_epoch: { type: 'integer' },
                  group_npub: { type: 'string' },
                  ciphertext: { type: 'string' },
                  write: { type: 'boolean' },
                },
                required: ['group_npub', 'ciphertext', 'write'],
              },
            },
          },
          required: ['schema_hash', 'record_families', 'owner_payload'],
        },
        WorkspaceAppConnectionResponse: {
          type: 'object',
          properties: {
            viewer: { type: 'string' },
            app: { $ref: '#/components/schemas/WorkspaceApp' },
            workspace_owner_npub: { type: 'string' },
            workspace_service_npub: { type: 'string' },
            app_npub: { type: 'string' },
            direct_https_url: { type: 'string', format: 'uri' },
            service_npub: { type: ['string', 'null'] },
            tower_name: { type: ['string', 'null'] },
            tower_description: { type: ['string', 'null'] },
            connection_token: { type: 'string' },
            agent_connect_package: { type: 'object', additionalProperties: true },
          },
          required: ['viewer', 'app', 'workspace_owner_npub', 'workspace_service_npub', 'app_npub', 'direct_https_url', 'service_npub', 'connection_token', 'agent_connect_package'],
        },
        WorkspaceAppDbRow: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            workspace_owner_npub: { type: 'string' },
            app_npub: { type: 'string' },
            collection: { type: 'string' },
            row_id: { type: 'string' },
            owner_npub: { type: 'string' },
            visibility: { type: 'string', enum: ['private', 'group', 'workspace'] },
            group_id: { type: ['string', 'null'], format: 'uuid' },
            data: {},
            metadata: { type: 'object', additionalProperties: true },
            created_by_npub: { type: 'string' },
            updated_by_npub: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'workspace_owner_npub', 'app_npub', 'collection', 'row_id', 'owner_npub', 'visibility', 'group_id', 'data', 'metadata', 'created_by_npub', 'updated_by_npub', 'created_at', 'updated_at'],
        },
        WappDbDescriptor: {
          type: 'object',
          properties: {
            workspace_owner_npub: { type: 'string' },
            app_npub: { type: 'string' },
            schema_name: { type: 'string' },
            capabilities: {
              type: 'object',
              properties: {
                migrations: { type: 'boolean' },
                crud: { type: 'boolean' },
                query: { type: 'boolean' },
                public_app_data: { type: 'boolean' },
              },
              required: ['migrations', 'crud', 'query', 'public_app_data'],
            },
            limits: {
              type: 'object',
              properties: {
                max_tables: { type: 'integer' },
                max_columns_per_table: { type: 'integer' },
                max_query_limit: { type: 'integer' },
                statement_timeout_ms: { type: 'integer' },
              },
              required: ['max_tables', 'max_columns_per_table', 'max_query_limit', 'statement_timeout_ms'],
            },
          },
          required: ['workspace_owner_npub', 'app_npub', 'schema_name', 'capabilities', 'limits'],
        },
        WappDbMigration: {
          type: 'object',
          properties: {
            version: { type: 'string' },
            checksum: { type: 'string' },
            sql: { type: 'string' },
          },
          required: ['version', 'checksum', 'sql'],
        },
        WappDbQueryRequest: {
          type: 'object',
          properties: {
            select: { type: 'array', items: { type: 'string' } },
            where: { type: 'object', additionalProperties: true },
            order: {
              type: 'array',
              items: {
                type: 'object',
                properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } },
                required: ['field'],
              },
            },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
        CreateWorkspaceAppDbRowRequest: {
          type: 'object',
          properties: {
            row_id: { type: 'string' },
            owner_npub: { type: 'string', description: 'Must match the authenticated resolved user when supplied.' },
            visibility: { type: 'string', enum: ['private', 'group', 'workspace'], default: 'private' },
            group_id: { type: ['string', 'null'], format: 'uuid', description: 'Required when visibility is group.' },
            data: {},
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        UpdateWorkspaceAppDbRowRequest: {
          type: 'object',
          properties: {
            visibility: { type: 'string', enum: ['private', 'group', 'workspace'] },
            group_id: { type: ['string', 'null'], format: 'uuid', description: 'Required when visibility is group.' },
            data: {},
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        MemberKeyInput: {
          type: 'object',
          properties: {
            member_npub: { type: 'string' },
            wrapped_group_nsec: { type: 'string', description: 'NIP-44 encrypted group nsec for this member' },
            wrapped_by_npub: { type: 'string' },
          },
          required: ['member_npub', 'wrapped_group_nsec', 'wrapped_by_npub'],
        },
        CreateGroupRequest: {
          type: 'object',
          properties: {
            owner_npub: { type: 'string', description: 'Compatibility alias for workspace_service_npub' },
            workspace_service_npub: { type: 'string', description: 'Canonical workspace service identity' },
            name: { type: 'string' },
            group_npub: { type: 'string', description: 'Nostr public key for the group identity' },
            member_keys: {
              type: 'array',
              items: { $ref: '#/components/schemas/MemberKeyInput' },
              description: 'Wrapped group keys for each member. Must include the resolved authenticated creator; member-created workspace groups may only include existing workspace members.',
            },
          },
          required: ['name', 'group_npub', 'member_keys'],
          anyOf: [
            { required: ['owner_npub'] },
            { required: ['workspace_service_npub'] },
          ],
        },
        RotateGroupRequest: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Optional updated group name to persist during rotation' },
            group_npub: { type: 'string', description: 'Fresh epoch npub generated by the rotating client' },
            member_keys: {
              type: 'array',
              items: { $ref: '#/components/schemas/MemberKeyInput' },
              description: 'Wrapped fresh group nsec for each remaining member',
            },
          },
          required: ['group_npub', 'member_keys'],
        },
        UpdateGroupRequest: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
        },
        GroupMember: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            member_npub: { type: 'string' },
          },
          required: ['id', 'member_npub'],
        },
        GroupResponse: {
          type: 'object',
          properties: {
            group_id: { type: 'string', format: 'uuid' },
            group_npub: { type: 'string' },
            current_epoch: { type: 'integer', minimum: 1 },
            owner_npub: { type: 'string' },
            workspace_service_npub: { type: 'string', description: 'Canonical alias for owner_npub' },
            name: { type: 'string' },
            group_kind: { type: 'string' },
            private_member_npub: { type: ['string', 'null'] },
            members: {
              type: 'array',
              items: { $ref: '#/components/schemas/GroupMember' },
            },
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['group_id', 'group_npub', 'current_epoch', 'owner_npub', 'name', 'group_kind', 'private_member_npub', 'members', 'created_at'],
        },
        ListGroup: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            owner_npub: { type: 'string' },
            name: { type: 'string' },
            group_npub: { type: 'string' },
            current_epoch: { type: 'integer', minimum: 1 },
            group_kind: { type: 'string' },
            private_member_npub: { type: ['string', 'null'] },
            created_at: { type: 'string', format: 'date-time' },
            members: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['id', 'owner_npub', 'name', 'group_npub', 'current_epoch', 'group_kind', 'private_member_npub', 'created_at', 'members'],
        },
        ListGroupsResponse: {
          type: 'object',
          properties: {
            groups: {
              type: 'array',
              items: { $ref: '#/components/schemas/ListGroup' },
            },
          },
          required: ['groups'],
        },
        AddGroupMemberRequest: {
          type: 'object',
          properties: {
            member_npub: { type: 'string' },
            wrapped_group_nsec: { type: 'string', description: 'NIP-44 encrypted group nsec for this member' },
            wrapped_by_npub: { type: 'string' },
          },
          required: ['member_npub', 'wrapped_group_nsec', 'wrapped_by_npub'],
        },
        AddGroupMemberResponse: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            group_id: { type: 'string', format: 'uuid' },
            member_npub: { type: 'string' },
            wrapped_group_nsec: { type: 'string' },
            wrapped_by_npub: { type: 'string' },
            approved_by_npub: { type: 'string' },
            key_version: { type: 'integer' },
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'group_id', 'member_npub', 'wrapped_group_nsec', 'wrapped_by_npub', 'approved_by_npub', 'key_version', 'created_at'],
        },
        WrappedKeyEntry: {
          type: 'object',
          properties: {
            group_id: { type: 'string', format: 'uuid' },
            group_npub: { type: 'string' },
            epoch: { type: 'integer', minimum: 1 },
            name: { type: 'string' },
            member_npub: { type: 'string' },
            wrapped_group_nsec: { type: 'string' },
            wrapped_by_npub: { type: 'string' },
            approved_by_npub: { type: 'string' },
            key_version: { type: 'integer' },
          },
          required: ['group_id', 'group_npub', 'epoch', 'name', 'member_npub', 'wrapped_group_nsec', 'wrapped_by_npub', 'approved_by_npub', 'key_version'],
        },
        WrappedKeysResponse: {
          type: 'object',
          properties: {
            keys: {
              type: 'array',
              items: { $ref: '#/components/schemas/WrappedKeyEntry' },
            },
          },
          required: ['keys'],
        },
        DeleteGroupResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: true },
            group_id: { type: 'string', format: 'uuid' },
          },
          required: ['ok', 'group_id'],
        },
        DeleteGroupMemberResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: true },
            group_id: { type: 'string', format: 'uuid' },
            member_npub: { type: 'string' },
          },
          required: ['ok', 'group_id', 'member_npub'],
        },
        PrepareStorageRequest: {
          type: 'object',
          properties: {
            owner_npub: { type: 'string' },
            content_type: { type: 'string', example: 'audio/webm;codecs=opus' },
            size_bytes: { type: 'integer', example: 182044 },
            file_name: { type: ['string', 'null'], example: 'voice-note.webm' },
          },
          required: ['owner_npub', 'content_type'],
        },
        PrepareStorageResponse: {
          type: 'object',
          properties: {
            object_id: { type: 'string', format: 'uuid' },
            owner_npub: { type: 'string' },
            access_group_npubs: { type: 'array', items: { type: 'string' } },
            file_name: { type: ['string', 'null'] },
            content_type: { type: 'string' },
            size_bytes: { type: 'integer' },
            upload_url: { type: 'string', format: 'uri' },
            complete_url: { type: 'string', format: 'uri' },
            content_url: { type: 'string', format: 'uri' },
            download_url: { type: 'string', format: 'uri' },
            completed_at: { type: ['string', 'null'], format: 'date-time' },
          },
          required: ['object_id', 'owner_npub', 'access_group_npubs', 'content_type', 'size_bytes', 'upload_url', 'complete_url', 'content_url', 'download_url'],
        },
        CompleteStorageRequest: {
          type: 'object',
          properties: {
            sha256_hex: { type: ['string', 'null'] },
            size_bytes: { type: ['integer', 'null'] },
          },
        },
        CompleteStorageResponse: {
          type: 'object',
          properties: {
            object_id: { type: 'string', format: 'uuid' },
            owner_npub: { type: 'string' },
            access_group_npubs: { type: 'array', items: { type: 'string' } },
            file_name: { type: ['string', 'null'] },
            content_type: { type: 'string' },
            size_bytes: { type: 'integer' },
            content_url: { type: 'string', format: 'uri' },
            completed_at: { type: 'string', format: 'date-time' },
          },
          required: ['object_id', 'owner_npub', 'access_group_npubs', 'content_type', 'size_bytes', 'content_url', 'completed_at'],
        },
        StorageObjectResponse: {
          type: 'object',
          properties: {
            object_id: { type: 'string', format: 'uuid' },
            owner_npub: { type: 'string' },
            created_by_npub: { type: 'string' },
            access_group_npubs: { type: 'array', items: { type: 'string' } },
            file_name: { type: ['string', 'null'] },
            content_type: { type: 'string' },
            size_bytes: { type: 'integer' },
            sha256_hex: { type: ['string', 'null'] },
            content_url: { type: 'string', format: 'uri' },
            download_url: { type: ['string', 'null'], format: 'uri' },
            created_at: { type: 'string', format: 'date-time' },
            completed_at: { type: ['string', 'null'], format: 'date-time' },
          },
          required: ['object_id', 'owner_npub', 'created_by_npub', 'access_group_npubs', 'content_type', 'size_bytes', 'content_url', 'created_at'],
        },
        DownloadUrlResponse: {
          type: 'object',
          properties: {
            object_id: { type: 'string', format: 'uuid' },
            content_url: { type: 'string', format: 'uri' },
            download_url: { type: 'string', format: 'uri' },
          },
          required: ['object_id', 'content_url', 'download_url'],
        },
        OwnerPayload: {
          type: 'object',
          properties: {
            ciphertext: { type: 'string' },
          },
          required: ['ciphertext'],
        },
        CheckoutReference: {
          type: 'object',
          properties: {
            checkout_id: { type: 'string', format: 'uuid' },
            consume_on_success: {
              type: 'boolean',
              description: 'Defaults to true. Lock-managed writes atomically release the checkout when the write is accepted.',
            },
          },
          required: ['checkout_id'],
        },
        RecordCheckoutState: {
          type: 'object',
          properties: {
            checkout_id: { type: 'string', format: 'uuid' },
            state: { type: 'string', enum: ['checked_in', 'checked_out'] },
            checked_out_by_user_npub: { type: 'string' },
            checked_out_by_workspace_user_key_npub: {
              type: ['string', 'null'],
              description: 'Delegated workspace user key used when the checkout was acquired.',
            },
            checked_out_at: { type: 'string', format: 'date-time' },
            lease_expires_at: { type: 'string', format: 'date-time' },
          },
          required: ['checkout_id', 'state'],
        },
        RecordCheckoutResponse: {
          type: 'object',
          properties: {
            record_id: { type: 'string' },
            record_family_hash: { type: 'string' },
            checkout: { $ref: '#/components/schemas/RecordCheckoutState' },
          },
          required: ['record_id', 'record_family_hash', 'checkout'],
        },
        AcquireCheckoutRequest: {
          type: 'object',
          properties: {
            workspace_service_npub: { type: 'string', description: 'Canonical workspace service identity. Checkout endpoints reject alias-only owner_npub requests.' },
            user_npub: { type: 'string', description: 'Canonical real user identity for checkout ownership' },
            signer_npub: { type: 'string', description: 'Canonical NIP-98 signer identity; for normal app requests this equals workspace_user_key_npub.' },
            workspace_user_key_npub: { type: 'string', description: 'Canonical delegated workspace user key used to sign the request. Checkout endpoints require this canonical field.' },
            record_family_hash: { type: 'string' },
            lease_seconds: { type: 'integer', minimum: 60, maximum: 3600 },
            idempotency_key: { type: 'string', format: 'uuid', description: 'Optional idempotency key scoped to the same workspace_service_npub + record_id + user_npub while the checkout remains active.' },
          },
          required: ['workspace_service_npub', 'user_npub', 'workspace_user_key_npub', 'record_family_hash'],
        },
        ReleaseCheckoutRequest: {
          type: 'object',
          properties: {
            workspace_service_npub: { type: 'string', description: 'Canonical workspace service identity. Checkout endpoints reject alias-only owner_npub requests.' },
            user_npub: { type: 'string', description: 'Canonical real user identity for checkout ownership' },
            signer_npub: { type: 'string', description: 'Canonical NIP-98 signer identity; for normal app requests this equals workspace_user_key_npub.' },
            workspace_user_key_npub: { type: 'string', description: 'Canonical delegated workspace user key used to sign the request. Checkout endpoints require this canonical field.' },
            record_family_hash: { type: 'string' },
            checkout_id: { type: 'string', format: 'uuid' },
          },
          required: ['workspace_service_npub', 'user_npub', 'workspace_user_key_npub', 'record_family_hash', 'checkout_id'],
        },
        RenewCheckoutRequest: {
          type: 'object',
          properties: {
            workspace_service_npub: { type: 'string', description: 'Canonical workspace service identity. Checkout endpoints reject alias-only owner_npub requests.' },
            user_npub: { type: 'string', description: 'Canonical real user identity for checkout ownership' },
            signer_npub: { type: 'string', description: 'Canonical NIP-98 signer identity; for normal app requests this equals workspace_user_key_npub.' },
            workspace_user_key_npub: { type: 'string', description: 'Canonical delegated workspace user key used to sign the request. Checkout endpoints require this canonical field.' },
            record_family_hash: { type: 'string' },
            checkout_id: { type: 'string', format: 'uuid' },
            lease_seconds: { type: 'integer', minimum: 60, maximum: 3600 },
          },
          required: ['workspace_service_npub', 'user_npub', 'workspace_user_key_npub', 'record_family_hash', 'checkout_id'],
        },
        GroupPayload: {
          type: 'object',
          properties: {
            group_id: { type: 'string', format: 'uuid', description: 'Stable logical group id' },
            group_epoch: { type: 'integer', minimum: 1, description: 'Epoch/version of the group key used for this payload' },
            group_npub: { type: 'string', description: 'Group epoch key npub used as crypto metadata for this encrypted payload. This is not a durable group reference.' },
            ciphertext: { type: 'string' },
            write: { type: 'boolean' },
          },
          required: ['group_npub', 'ciphertext', 'write'],
        },
        SyncRecordInput: {
          type: 'object',
          properties: {
            record_id: { type: 'string' },
            owner_npub: { type: 'string', description: 'Compatibility alias for workspace_service_npub' },
            workspace_service_npub: { type: 'string', description: 'Canonical workspace service identity' },
            ws_key_npub: { type: 'string', description: 'Compatibility alias for workspace_user_key_npub when supplied by canonical clients' },
            workspace_user_key_npub: { type: 'string', description: 'Canonical delegated per-user workspace key. If present, Tower verifies signer_npub equals this key and the key is active for user_npub and workspace_service_npub.' },
            record_family_hash: { type: 'string' },
            version: { type: 'integer' },
            previous_version: { type: 'integer' },
            signature_npub: { type: 'string' },
            write_group_id: { type: 'string', format: 'uuid', description: 'Canonical stable logical group id used for shared-write authorization' },
            write_group_npub: { type: 'string', deprecated: true, description: 'Legacy compatibility alias for shared-write authorization. New clients should send write_group_id. Rejected when strict_group_id_writes is enabled.' },
            force_write: { type: 'boolean', description: 'Explicit repair overwrite flag. When true, Tower bypasses checkout-required lock validation and may accept a current-member write-group proof to repair missing prior-version group write access, but normal version-chain and group membership checks still apply.' },
            owner_payload: { $ref: '#/components/schemas/OwnerPayload' },
            checkout: {
              $ref: '#/components/schemas/CheckoutReference',
              description: 'Required when the resolved record family policy is `checkout_required`; omitted for `optimistic_write` families.',
            },
            group_payloads: {
              type: 'array',
              items: { $ref: '#/components/schemas/GroupPayload' },
            },
          },
          required: [
            'record_id',
            'record_family_hash',
            'version',
            'previous_version',
            'signature_npub',
            'owner_payload',
          ],
          anyOf: [
            { required: ['owner_npub'] },
            { required: ['workspace_service_npub'] },
          ],
        },
        SyncRequest: {
          type: 'object',
          properties: {
            owner_npub: { type: 'string', description: 'Compatibility alias for workspace_service_npub' },
            workspace_service_npub: { type: 'string', description: 'Canonical workspace service identity' },
            user_npub: { type: 'string', description: 'Canonical real user identity. If supplied with workspace_user_key_npub, it must match the resolved authenticated user.' },
            actor_npub: { type: 'string', description: 'Canonical actor identity; for normal app requests this equals user_npub.' },
            viewer_npub: { type: 'string', description: 'Canonical viewer identity; Tower evaluates reads as viewerNpub = userNpub.' },
            signer_npub: { type: 'string', description: 'Canonical NIP-98 signer identity. For normal app writes this equals workspace_user_key_npub.' },
            ws_key_npub: { type: 'string', description: 'Compatibility alias for workspace_user_key_npub' },
            workspace_user_key_npub: { type: 'string', description: 'Canonical delegated per-user workspace key. If present, Tower verifies signer_npub equals this key and the key is active for user_npub and workspace_service_npub.' },
            strict_group_id_writes: { type: 'boolean', description: 'Opt-in strict mode. When true, write_group_npub is rejected as a durable write reference; use write_group_id and keep group_payloads[].group_npub only as crypto metadata.' },
            group_write_tokens: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Map keyed by stable group_id or legacy current group_npub to a NIP-98 write-proof token signed by the current group epoch key',
            },
            records: {
              type: 'array',
              items: { $ref: '#/components/schemas/SyncRecordInput' },
            },
          },
          required: ['records'],
          anyOf: [
            { required: ['owner_npub'] },
            { required: ['workspace_service_npub'] },
          ],
        },
        SyncRejectedRecord: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            code: {
              type: 'string',
              enum: [
                'checkout_conflict',
                'checkout_missing',
                'checkout_not_owner',
                'edit_policy_forbidden',
                'prior_version_mismatch',
                'write_group_forbidden',
              ],
            },
            status: { type: 'integer' },
            record_id: { type: 'string' },
            record_family_hash: { type: 'string' },
            workspace_service_npub: { type: 'string' },
            user_npub: { type: 'string' },
            workspace_user_key_npub: { type: ['string', 'null'] },
            tower_latest_version: { type: 'integer' },
            required_previous_version: { type: 'integer' },
            received_previous_version: { type: 'integer' },
            checkout: { $ref: '#/components/schemas/RecordCheckoutState' },
            reason: { type: 'string', description: 'Compatibility mirror of error for existing clients that inspect rejected[].reason.' },
          },
          required: [
            'error',
            'code',
            'status',
            'record_id',
            'record_family_hash',
            'workspace_service_npub',
            'user_npub',
            'workspace_user_key_npub',
            'reason',
          ],
        },
        SyncWarning: {
          type: 'object',
          properties: {
            code: { type: 'string', enum: ['legacy_write_group_npub'] },
            message: { type: 'string' },
            record_id: { type: 'string' },
            field: { type: 'string', enum: ['write_group_npub'] },
            write_group_id: { type: ['string', 'null'], format: 'uuid' },
            write_group_npub: { type: 'string' },
          },
          required: ['code', 'message', 'record_id', 'field', 'write_group_npub'],
        },
        SyncResponse: {
          type: 'object',
          properties: {
            synced: { type: 'integer' },
            created: { type: 'integer' },
            updated: { type: 'integer' },
            rejected: {
              type: 'array',
              items: { $ref: '#/components/schemas/SyncRejectedRecord' },
            },
            warnings: {
              type: 'array',
              items: { $ref: '#/components/schemas/SyncWarning' },
              description: 'Compatibility diagnostics, including use of deprecated write_group_npub write references.',
            },
          },
          required: ['synced', 'created', 'updated', 'rejected', 'warnings'],
        },
        RecordResponse: {
          type: 'object',
          properties: {
            record_id: { type: 'string' },
            owner_npub: { type: 'string' },
            record_family_hash: { type: 'string' },
            version: { type: 'integer' },
            previous_version: { type: 'integer' },
            signature_npub: { type: 'string' },
            owner_payload: { $ref: '#/components/schemas/OwnerPayload' },
            group_payloads: {
              type: 'array',
              items: { $ref: '#/components/schemas/GroupPayload' },
            },
            updated_at: { type: 'string', format: 'date-time' },
          },
          required: [
            'record_id',
            'owner_npub',
            'record_family_hash',
            'version',
            'previous_version',
            'signature_npub',
            'owner_payload',
            'group_payloads',
            'updated_at',
          ],
        },
        RecordsAuditInfo: {
          type: 'object',
          properties: {
            workspace_owner_npub: { type: 'string' },
            workspace_service_npub: { type: 'string' },
            signer_npub: { type: 'string' },
            user_npub: { type: 'string' },
            viewer_npub: { type: 'string' },
            actor_npub: { type: 'string', description: 'Resolved actor identity after ws_key_npub mapping' },
            ws_key_npub: { type: 'string', nullable: true, description: 'Workspace session key used to sign this request, if any' },
            workspace_user_key_npub: { type: 'string', nullable: true, description: 'Canonical alias for ws_key_npub' },
          },
          required: ['workspace_owner_npub', 'workspace_service_npub', 'signer_npub', 'user_npub', 'viewer_npub', 'actor_npub', 'ws_key_npub', 'workspace_user_key_npub'],
        },
        FetchRecordsResponse: {
          type: 'object',
          properties: {
            audit: { $ref: '#/components/schemas/RecordsAuditInfo' },
            records: {
              type: 'array',
              items: { $ref: '#/components/schemas/RecordResponse' },
            },
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
            has_more: { type: 'boolean' },
          },
          required: ['audit', 'records', 'total', 'limit', 'offset', 'has_more'],
        },
        RecordHistoryResponse: {
          type: 'object',
          properties: {
            audit: { $ref: '#/components/schemas/RecordsAuditInfo' },
            versions: {
              type: 'array',
              items: { $ref: '#/components/schemas/RecordResponse' },
            },
          },
          required: ['audit', 'versions'],
        },
        RecordsSummaryResponse: {
          type: 'object',
          properties: {
            audit: { $ref: '#/components/schemas/RecordsAuditInfo' },
            families: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  record_family_hash: { type: 'string' },
                  latest_updated_at: { type: 'string', format: 'date-time' },
                  latest_record_count: { type: 'integer' },
                  count_since: { type: 'integer', nullable: true },
                },
                required: ['record_family_hash', 'latest_updated_at', 'latest_record_count', 'count_since'],
              },
            },
          },
          required: ['audit', 'families'],
        },
        HeartbeatResponse: {
          type: 'object',
          properties: {
            audit: { $ref: '#/components/schemas/RecordsAuditInfo' },
            stale_families: {
              type: 'array',
              items: { type: 'string' },
              description: 'Family hashes that have newer data than the client cursor',
            },
            server_cursors: {
              type: 'object',
              additionalProperties: { type: 'string', format: 'date-time' },
              description: 'Current server-side latest_updated_at per family',
            },
          },
          required: ['audit', 'stale_families', 'server_cursors'],
        },
        AdminTableColumn: {
          type: 'object',
          properties: {
            column_name: { type: 'string' },
            data_type: { type: 'string' },
          },
          required: ['column_name', 'data_type'],
        },
        AdminTableSummary: {
          type: 'object',
          properties: {
            table: { type: 'string' },
            row_count: { type: 'integer' },
            columns: {
              type: 'array',
              items: { $ref: '#/components/schemas/AdminTableColumn' },
            },
          },
          required: ['table', 'row_count', 'columns'],
        },
        AdminTablesResponse: {
          type: 'object',
          properties: {
            viewer: { type: 'string' },
            tables: {
              type: 'array',
              items: { $ref: '#/components/schemas/AdminTableSummary' },
            },
          },
          required: ['viewer', 'tables'],
        },
        AdminTableRowsResponse: {
          type: 'object',
          properties: {
            viewer: { type: 'string' },
            table: { type: 'string' },
            row_count: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
            columns: {
              type: 'array',
              items: { $ref: '#/components/schemas/AdminTableColumn' },
            },
            rows: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
          },
          required: ['viewer', 'table', 'row_count', 'limit', 'offset', 'columns', 'rows'],
        },
        UpdateTowerProfileRequest: {
          type: 'object',
          properties: {
            tower_name: { type: ['string', 'null'] },
            tower_description: { type: ['string', 'null'] },
          },
        },
        TowerProfileResponse: {
          type: 'object',
          properties: {
            viewer: { type: 'string' },
            direct_https_url: { type: 'string', format: 'uri' },
            service_npub: { type: ['string', 'null'] },
            tower_name: { type: ['string', 'null'] },
            tower_description: { type: ['string', 'null'] },
            updated_at: { type: ['string', 'null'], format: 'date-time' },
          },
          required: ['viewer', 'direct_https_url', 'service_npub', 'tower_name', 'tower_description', 'updated_at'],
        },
        FlightDeckPgAdminWorkspaceSetupRequest: {
          type: 'object',
          properties: {
            workspace_name: { type: 'string' },
            workspace_description: { type: ['string', 'null'] },
            app_npub: { type: ['string', 'null'], default: config.flightDeck.appNpub },
            workspace_service_npub: { type: ['string', 'null'], description: 'Generated by Tower when omitted.' },
            workspace_owner_npub: { type: ['string', 'null'], description: 'Defaults to the signed admin npub.' },
            creator_npub: { type: 'string', description: 'Explicit identity of the workspace creator.' },
            smoke_scope_name: { type: ['string', 'null'], default: null, description: 'Optional. When omitted, Tower does not create a starter smoke scope.' },
            smoke_channel_name: { type: ['string', 'null'], default: null, description: 'Optional. When omitted, Tower does not create a starter smoke channel.' },
            second_actor_npub: { type: ['string', 'null'] },
            second_actor_display_name: { type: ['string', 'null'], description: 'Required when second_actor_npub is provided.' },
          },
          required: ['workspace_name', 'creator_npub'],
        },
        FlightDeckPgAdminWorkspaceSetupResponse: {
          type: 'object',
          properties: {
            viewer: { type: 'string' },
            workspace_id: { type: 'string', format: 'uuid' },
            descriptor_route: { type: 'string' },
            descriptor: { type: 'object', additionalProperties: true },
            groups: { type: 'object', additionalProperties: { type: 'string', format: 'uuid' } },
            smoke: {
              type: 'object',
              properties: {
                scope_id: { type: 'string', format: 'uuid' },
                channel_id: { type: 'string', format: 'uuid' },
              },
              required: ['scope_id', 'channel_id'],
            },
            actors: { type: 'object', additionalProperties: true },
            app_namespace: { type: 'object', additionalProperties: true },
            smoke_paths: { type: 'array', items: { type: 'string' } },
          },
          required: ['viewer', 'workspace_id', 'descriptor_route', 'descriptor', 'groups', 'smoke'],
        },
        RegisterWorkspaceKeyRequest: {
          type: 'object',
          properties: {
            workspace_owner_npub: { type: 'string', description: 'Compatibility alias for workspace_service_npub' },
            workspace_service_npub: { type: 'string', description: 'Canonical workspace service identity' },
            ws_key_npub: { type: 'string', description: 'Compatibility alias for workspace_user_key_npub' },
            workspace_user_key_npub: { type: 'string', description: 'Canonical delegated per-user workspace key' },
          },
          allOf: [
            {
              anyOf: [
                { required: ['workspace_owner_npub'] },
                { required: ['workspace_service_npub'] },
              ],
            },
            {
              anyOf: [
                { required: ['ws_key_npub'] },
                { required: ['workspace_user_key_npub'] },
              ],
            },
          ],
        },
        RotateWorkspaceKeyRequest: {
          type: 'object',
          properties: {
            workspace_owner_npub: { type: 'string', description: 'Compatibility alias for workspace_service_npub' },
            workspace_service_npub: { type: 'string', description: 'Canonical workspace service identity' },
            new_ws_key_npub: { type: 'string', description: 'Compatibility alias for new_workspace_user_key_npub' },
            new_workspace_user_key_npub: { type: 'string', description: 'Canonical public key of the new delegated workspace user keypair' },
            old_ws_key_npub: { type: 'string', description: 'Compatibility alias for old_workspace_user_key_npub' },
            old_workspace_user_key_npub: { type: 'string', description: 'Canonical public key of the delegated workspace user key being rotated out' },
          },
          allOf: [
            {
              anyOf: [
                { required: ['workspace_owner_npub'] },
                { required: ['workspace_service_npub'] },
              ],
            },
            {
              anyOf: [
                { required: ['new_ws_key_npub'] },
                { required: ['new_workspace_user_key_npub'] },
              ],
            },
            {
              anyOf: [
                { required: ['old_ws_key_npub'] },
                { required: ['old_workspace_user_key_npub'] },
              ],
            },
          ],
        },
        WorkspaceKeyEntry: {
          type: 'object',
          properties: {
            user_npub: { type: 'string', description: 'Canonical real user identity that owns this delegated workspace key' },
            workspace_owner_npub: { type: 'string' },
            workspace_service_npub: { type: 'string', description: 'Canonical alias for workspace_owner_npub' },
            ws_key_npub: { type: 'string' },
            workspace_user_key_npub: { type: 'string', description: 'Canonical alias for ws_key_npub' },
            device_npub: { type: 'string', description: 'Device-oriented alias for ws_key_npub' },
            label: { type: ['string', 'null'] },
            platform: { type: ['string', 'null'] },
            policy: { type: 'object', additionalProperties: true },
            ws_key_epoch: { type: 'integer', minimum: 1 },
            active: { type: 'boolean' },
            last_seen_at: { type: ['string', 'null'], format: 'date-time' },
            revoked_at: { type: ['string', 'null'], format: 'date-time' },
            registered_at: { type: ['string', 'null'], format: 'date-time' },
          },
          required: ['user_npub', 'workspace_owner_npub', 'workspace_service_npub', 'ws_key_npub', 'workspace_user_key_npub', 'ws_key_epoch', 'active'],
        },
        DeviceEntry: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            device_npub: { type: 'string' },
            user_npub: { type: 'string' },
            workspace_owner_npub: { type: 'string' },
            workspace_service_npub: { type: 'string' },
            label: { type: ['string', 'null'] },
            platform: { type: ['string', 'null'] },
            policy: { type: 'object', additionalProperties: true },
            status: { type: 'string', enum: ['active', 'revoked'] },
            active: { type: 'boolean' },
            last_seen_at: { type: ['string', 'null'], format: 'date-time' },
            revoked_at: { type: ['string', 'null'], format: 'date-time' },
            registered_at: { type: ['string', 'null'], format: 'date-time' },
          },
          required: ['id', 'device_npub', 'user_npub', 'workspace_owner_npub', 'workspace_service_npub', 'status', 'active'],
        },
        DeviceRegisterRequest: {
          type: 'object',
          properties: {
            workspace_owner_npub: { type: 'string', description: 'Compatibility alias for workspace_service_npub' },
            workspace_service_npub: { type: 'string', description: 'Canonical workspace service identity' },
            device_npub: { type: 'string' },
            ws_key_npub: { type: 'string', description: 'Compatibility alias for device_npub' },
            workspace_user_key_npub: { type: 'string', description: 'Compatibility alias for device_npub' },
            label: { type: 'string' },
            platform: { type: 'string' },
            policy: { type: 'object', additionalProperties: true },
          },
        },
        DeviceResponse: {
          type: 'object',
          properties: {
            device: { $ref: '#/components/schemas/DeviceEntry' },
          },
          required: ['device'],
        },
        DevicesResponse: {
          type: 'object',
          properties: {
            devices: {
              type: 'array',
              items: { $ref: '#/components/schemas/DeviceEntry' },
            },
          },
          required: ['devices'],
        },
        WorkspaceKeysResponse: {
          type: 'object',
          properties: {
            keys: {
              type: 'array',
              items: { $ref: '#/components/schemas/WorkspaceKeyEntry' },
            },
          },
          required: ['keys'],
        },
        WorkspaceKeyMappingEntry: {
          type: 'object',
          properties: {
            user_npub: { type: 'string', description: 'Canonical real user identity that owns this active delegated workspace key' },
            workspace_owner_npub: { type: 'string', description: 'Compatibility alias for workspace_service_npub' },
            workspace_service_npub: { type: 'string', description: 'Canonical workspace service identity' },
            ws_key_npub: { type: 'string', description: 'Compatibility alias for workspace_user_key_npub' },
            workspace_user_key_npub: { type: 'string', description: 'Canonical active delegated workspace user key' },
          },
          required: ['user_npub', 'workspace_owner_npub', 'workspace_service_npub', 'ws_key_npub', 'workspace_user_key_npub'],
        },
        WorkspaceKeyMappingsResponse: {
          type: 'object',
          properties: {
            mappings: {
              type: 'array',
              items: { $ref: '#/components/schemas/WorkspaceKeyMappingEntry' },
              description: 'Active workspace user key mappings for display and actor resolution.',
            },
          },
          required: ['mappings'],
        },
      },
    },
    security: [{ nip98: [] }],
    paths: {
      '/health': {
        get: {
          tags: ['Health'],
          security: [],
          summary: 'Get non-personal service health and identity metadata',
          responses: {
            '200': {
              description: 'Service is healthy',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HealthResponse' },
                },
              },
            },
          },
        },
      },
      '/version': {
        get: {
          tags: ['Health'],
          security: [],
          summary: 'Get Tower build and runtime version metadata',
          responses: {
            '200': {
              description: 'Tower build metadata',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/TowerBuildInfo' },
                },
              },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          tags: ['Health'],
          security: [],
          summary: 'Get OpenAPI document',
          responses: {
            '200': {
              description: 'OpenAPI document',
            },
          },
        },
      },
      '/docs': {
        get: {
          tags: ['Health'],
          security: [],
          summary: 'Open API docs UI',
          responses: {
            '200': {
              description: 'Swagger UI HTML',
            },
          },
        },
      },
      '/admin': {
        get: {
          tags: ['Admin'],
          security: [],
          summary: 'Open the Tower admin interface',
          responses: {
            '200': {
              description: 'Tower admin HTML',
            },
          },
        },
      },
      '/table-viewer': {
        get: {
          tags: ['Admin'],
          security: [],
          summary: 'Backend table viewer and Tower settings UI',
          responses: {
            '200': {
              description: 'HTML table viewer',
            },
          },
        },
      },
      '/ui': {
        get: {
          tags: ['Billing'],
          security: [],
          summary: 'Open the Tower-hosted Superbased workspace dashboard',
          responses: {
            '200': {
              description: 'Superbased dashboard HTML',
            },
          },
        },
      },
      '/api/v4/flightdeck-pg/service': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Contract fixture: Flight Deck PG service metadata',
          description: 'Implemented PH1-5 runtime service metadata for typed Flight Deck PG clients.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.service_metadata'],
          responses: {
            '200': { description: 'Service metadata contract fixture. The git object is omitted unless Git authority and explicit gateway discovery are fully configured.', content: { 'application/json': { schema: {
              type: 'object',
              required: ['identity', 'service', 'capabilities', 'links'],
              properties: {
                identity: { type: 'object' }, service: { type: 'object' }, capabilities: { type: 'array', items: { type: 'string' } }, links: { type: 'object' },
                git: {
                  type: 'object', additionalProperties: false, required: ['gateway_origins', 'audience'],
                  properties: {
                    gateway_origins: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', format: 'uri', pattern: '^https://[^/]+$' } },
                    audience: { type: 'string', minLength: 1 },
                  },
                },
              },
            } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'List visible Flight Deck PG workspaces',
          description: 'Implemented PH1-6 runtime discovery list. Returns only typed workspaces where the signer is a member and has workspace.read authorization. Optional app_npub or x-flightdeck-pg-app-npub filters the app namespace.',
          parameters: [
            { name: 'app_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Visible workspace discovery list', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/descriptor': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Get a credential-free Flight Deck PG workspace descriptor',
          description: 'Implemented PH1-6 runtime descriptor. Returns a routing/config locator with app npub, Tower base URL, Tower service npub, workspace service npub, workspace id, label/description, capabilities, and route links. It never returns auth tokens, bearer tokens, database credentials, or Nostr private keys.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.workspace_descriptor'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Workspace descriptor contract fixture', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}': {
        patch: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Update Flight Deck PG workspace profile metadata',
          description: 'Updates the typed PG workspace label and description. The client may send slug/avatar_url for local compatibility, but Tower currently persists name and description.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    description: { type: ['string', 'null'] },
                    kind: { type: 'string' },
                    metadata: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Workspace profile updated', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        delete: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Permanently delete a Flight Deck PG workspace',
          description: 'Requires workspace.manage and a confirmation value matching the workspace id. Deletes the workspace and its typed PG contents; clients should publish a user-signed Nostr workspace self-index tombstone and clear their local materialized copy after success.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { confirmation: { type: 'string', format: 'uuid' } },
                  required: ['confirmation'],
                },
              },
            },
          },
          responses: {
            '200': { description: 'Workspace permanently deleted', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Confirmation mismatch', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/invites': {
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Create a Flight Deck PG workspace invite',
          description: 'Implemented PH1-6 runtime invite creation. Authorizes workspace.invite, records the invited actor membership plus audit metadata in Tower, and does not publish anything to Nostr.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '201': { description: 'Workspace invite/membership recorded', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/me': {
        get: {
          tags: ['Flight Deck PG'],
          summary: 'Contract fixture: current actor workspace view',
          description: 'Implemented PH1-5 runtime current-actor membership and visible scope/channel summary.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.me'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Current actor contract fixture', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        patch: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Update the current workspace actor display name',
          description: 'Updates the canonical flightdeck_pg_actors display name, mirrors an existing user profile, and emits an actor.profile.updated event.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['display_name'], properties: { display_name: { type: 'string', minLength: 1, maxLength: 120 } } } } } },
          responses: {
            '200': { description: 'Actor profile updated', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/me/autopilot-agents': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Read the current actor personal Autopilot agent list',
          description: 'Returns the Tower Postgres-backed ordered agent list and its compare-and-swap row version.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Personal agent settings', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        put: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Replace the current actor personal Autopilot agent list',
          description: 'Explicitly replaces the list only when expected_row_version matches, allowing intentional clearing while rejecting stale clients.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['autopilot_agents', 'expected_row_version'], properties: { autopilot_agents: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['agent_npub', 'url'], properties: { agent_npub: { type: 'string', minLength: 1 }, url: { type: 'string', format: 'uri' } } } }, expected_row_version: { type: 'integer', minimum: 0 } } } } } },
          responses: {
            '200': { description: 'Personal agent settings updated', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Stale row version', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/agents/{actorId}/rotate-identity': {
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Atomically rotate a service-global agent signing identity',
          description: 'Requires body-bound NIP-98 authentication by the actor current old key and a kind 33359 proof by the new key. Preserves the stable actor UUID and every actor-ID relationship across all workspaces.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'actorId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['rotation_id','old_npub','new_npub','proof'], properties: { rotation_id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }, old_npub: { type: 'string' }, new_npub: { type: 'string' }, proof: { type: 'object', description: 'Signed Nostr kind 33359 event using the deterministic flightdeck_pg_agent_identity_rotation v1 content and tags.' } } } } } },
          responses: {
            '200': { description: 'Completed rotation or exact idempotent replay', content: { 'application/json': { schema: { type: 'object', required: ['status','actor_id','old_npub','new_npub','rotation_id','proof_event_id','completed_at','migration_counts','warnings'], properties: { status: { type: 'string', enum: ['completed','idempotent_replay'] }, actor_id: { type: 'string', format: 'uuid' }, old_npub: { type: 'string' }, new_npub: { type: 'string' }, rotation_id: { type: 'string' }, proof_event_id: { type: 'string' }, completed_at: { type: 'string', format: 'date-time' }, migration_counts: { type: 'object', additionalProperties: { type: 'integer' } }, warnings: { type: 'array', items: { type: 'string' } } } } } } },
            '400': { description: 'Missing, invalid, mismatched, expired, or replayed new-key proof' },
            '401': { description: 'Missing or invalid old-key NIP-98 authentication' },
            '409': { description: 'Stale old identity, actor mismatch, new identity collision, concurrent rotation, or conflicting rotation ID' },
            '422': { description: 'Unsupported current binding or atomic migration failure' },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/members': {
        post: {
          tags: ['Flight Deck PG'],
          summary: 'Add a typed Flight Deck PG workspace member',
          description: 'Implemented PH1-5 runtime workspace membership creation. Authorizes workspace.invite against the workspace and creates membership only, without channel grants.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '201': { description: 'Workspace member created', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/members/{actorId}/profile': {
        patch: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Update a workspace actor display name',
          description: 'Self-targets are allowed. Updating another workspace member requires workspace.manage. Emits audit and actor.profile.updated outbox records.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'actorId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['display_name'], properties: { display_name: { type: 'string', minLength: 1, maxLength: 120 } } } } } },
          responses: {
            '200': { description: 'Actor profile updated', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'workspace.manage required for another actor', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace member not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes': {
        get: {
          tags: ['Flight Deck PG'],
          summary: 'Contract fixture: list scopes',
          description: 'Implemented PH1-5 runtime list of scopes visible through scope.read or readable channel grants.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.scopes.list'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Scope list contract fixture', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Flight Deck PG'],
          summary: 'Contract fixture: create scope',
          description: 'Implemented PH1-5 runtime scope creation. Authorizes scope.create against the workspace before inserting the scope row.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.scopes.create'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '201': { description: 'Scope create contract fixture', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes/{scopeId}': {
        patch: {
          tags: ['Flight Deck PG'],
          summary: 'Update scope metadata',
          description: 'Updates an active scope name or description after authorizing scope.manage on that scope.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'scopeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1 }, description: { type: ['string', 'null'] } } } } },
          },
          responses: {
            '200': { description: 'Scope updated', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'scope.manage required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Scope not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes/{scopeId}/channels': {
        get: {
          tags: ['Flight Deck PG'],
          summary: 'Contract fixture: list channels',
          description: 'Implemented PH1-5 runtime list of readable channels in a scope.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.channels.list'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'scopeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Channel list contract fixture', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Flight Deck PG'],
          summary: 'Contract fixture: create channel',
          description: 'Implemented PH1-5 runtime channel creation. Authorizes channel.create against the parent scope. metadata.agent_chat is validated and normalized with Agent Direct Chat universally enabled; legacy basePrompt/contextPrompt is exposed through agent_chat.context_prompt for compatibility.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.channels.create'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'scopeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '201': { description: 'Channel create contract fixture', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}': {
        get: {
          tags: ['Flight Deck PG'],
          summary: 'Read a single visible channel',
          description: 'Resolves one channel by id without requiring clients to scan every scope. Authorizes channel.read on the channel.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Channel', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Channel not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        patch: {
          tags: ['Flight Deck PG'],
          summary: 'Update channel metadata',
          description: 'Updates mutable channel fields including metadata. Authorizes channel.manage on the channel. Metadata is merged with existing keys; metadata.agent_chat must contain enabled, context_prompt, and activation=mention_then_continue, and enabled is normalized to true under the universal Agent Direct Chat policy. A metadata update migrates legacy basePrompt/contextPrompt into the canonical agent_chat location.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    description: { type: ['string', 'null'] },
                    metadata: {
                      type: 'object',
                      additionalProperties: true,
                      properties: { agent_chat: { $ref: '#/components/schemas/FlightDeckPgAgentChatConfig' } },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Updated channel', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Channel not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}/reorder': {
        post: {
          tags: ['Flight Deck PG'],
          summary: 'Move a channel within its scope',
          description: 'Atomically moves one channel to a 1-based position among active siblings, shifts only intervening channels, and normalizes sibling positions to a unique contiguous sequence. Requires channel.manage on the moved channel. Positions beyond the last sibling are clamped to the end.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['position'],
                  properties: { position: { type: 'integer', minimum: 1, description: 'Desired 1-based sibling position.' } },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Channel reordered or already at the requested position', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'channel.manage required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Channel not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}/messages': {
        get: {
          tags: ['Flight Deck PG'],
          summary: 'Read canonical channel messages or one complete pageable thread',
          description: 'Authoritative deterministic message read ordered by created_at and id. Returns authenticated author identity, normalized mentions, attachments, metadata, and an opaque continuation cursor. A thread_id must belong to this channel.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.channel_messages.list'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'thread_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'effective_transcript', in: 'query', required: false, schema: { type: 'boolean', default: false }, description: 'When true with thread_id, returns inherited lineage through each fork point followed by child-owned messages. Rows include owning_thread_id, effective_thread_id, inherited, and read_only.' },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Deterministically ordered messages and next cursor', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid cursor', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Channel read denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Thread is not in this channel', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Flight Deck PG'],
          summary: 'Create an ordinary human- or agent-authored message idempotently',
          description: 'The authenticated NIP-98 actor is always the authoritative author. Canonical agent mentions are resolved and authorized. A first client_request_id returns 201 with created=true; an exact replay returns 200 with replayed=true and no duplicate event; a materially different reuse returns 409. Autopilot provenance in metadata is descriptive only.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.channel_messages.create'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/FlightDeckPgMessageCreateRequest' } } } },
          responses: {
            '201': { description: 'Message created and one visible event emitted', content: { 'application/json': { schema: { type: 'object' } } } },
            '200': { description: 'Existing message replayed without a new event', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Mention, metadata, signature, or request validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Authenticated actor lacks channel.write', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Idempotency key reused for a materially different body or target', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}/threads/{parentThreadId}/branches': {
        post: {
          tags: ['Flight Deck PG'],
          summary: 'Create an independent child thread from any effective message',
          description: 'Creates only the child thread, audit row, and thread outbox event. It never creates a message or emits message-created activity. The branch point must belong to the parent effective transcript in the same workspace, scope, and channel. client_request_id is actor-scoped and idempotent.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.channel_thread_branches.create'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'parentThreadId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', additionalProperties: false, required: ['branch_point_message_id', 'client_request_id'],
            properties: {
              branch_point_message_id: { type: 'string', format: 'uuid' },
              client_request_id: { type: 'string', minLength: 1, maxLength: 200 },
              title: { type: 'string', minLength: 1, maxLength: 120 },
              metadata: { type: 'object', additionalProperties: true },
            },
          } } } },
          responses: {
            '201': { description: 'Child thread created without a message event', content: { 'application/json': { schema: { type: 'object' } } } },
            '200': { description: 'Exact idempotent replay returned without another audit/outbox row', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Request validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Authenticated actor lacks channel.write', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Channel, parent thread, or branch point not found in the authorized lineage', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Idempotency conflict or invalid persisted lineage', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/messages/{messageId}/attachments/repair': {
        post: {
          tags: ['Flight Deck PG'],
          summary: 'Idempotently repair storage links for an existing message',
          description: 'Revalidates the authenticated actor, workspace, message channel, canonical attachment UUIDs, storage ownership, and channel.write permission before creating any missing message storage links. Existing correct links are retained. This route does not make objects public or alter generic owner/group ACLs.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'messageId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Repair result, including created/retained/tombstoned counts and audit event', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Message attachment metadata is invalid or the object is not attachable by this actor', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Authenticated actor lacks channel.write', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Message not found in this workspace', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'An attachment object is already linked to another active PG entity', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/threads/{threadId}': {
        get: {
          tags: ['Flight Deck PG'],
          summary: 'Read one thread and its persisted title',
          description: 'Authorizes channel.read. Non-human actors must also have participated in the thread by authoring a message or being canonically mentioned.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'threadId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Thread', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Channel access or bot participation denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Thread not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        patch: {
          tags: ['Flight Deck PG'],
          summary: 'Rename one thread',
          description: 'Normalizes whitespace and enforces a 120-character title limit. Authorizes channel.write; non-human actors must also participate in the thread.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'threadId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: 120 }, row_version: { type: 'integer', minimum: 1 } } } } } },
          responses: {
            '200': { description: 'Renamed thread', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid title', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Channel access or bot participation denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Thread not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Stale row version', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/messages/{messageId}': {
        patch: {
          tags: ['Flight Deck PG'],
          summary: 'Revise an existing message as its author',
          description: 'Author-only optimistic message revision. Tower canonicalizes the complete structured mention set, calculates newly added mentions against the saved prior revision, validates a body/message/revision-bound signature, and atomically emits flightdeck_pg.message.revised. The stable revision_idempotency_key is message:<messageId>:revision:<new row_version>; retrying the same saved base row_version returns stale_row_version and cannot emit another event.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'messageId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/FlightDeckPgMessageRevisionRequest' } } } },
          responses: {
            '200': { description: 'Message revised and one revision-specific event emitted', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Mention, metadata, signature, or request validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Only the authenticated author with channel.write may edit', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Message not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'stale_row_version; the requested base revision has already changed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        delete: {
          tags: ['Flight Deck PG'],
          summary: 'Delete an existing message',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'messageId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'row_version', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
          ],
          responses: { '200': { description: 'Message deleted' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}/grants': {
        get: {
          tags: ['Flight Deck PG'],
          summary: 'Contract fixture: list channel grants',
          description: 'Implemented PH1-5 runtime list of channel grants. Authorizes channel.grants.read on the channel.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.channel_grants.list'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Channel grant list contract fixture', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Flight Deck PG'],
          summary: 'Contract fixture: create channel grant',
          description: 'Implemented PH1-5 runtime channel grant creation. Authorizes channel.grants.manage on the channel.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.channel_grants.create'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '201': { description: 'Channel grant create contract fixture', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/daily-notes': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'List visible personal Daily Scopes',
          description: 'Lists Daily Scope notes visible to the signer by owner/date. Visibility is owner self-access plus explicit Daily Scope agent access; channel membership does not grant access.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'note_date', in: 'query', required: false, schema: { type: 'string', format: 'date' } },
            { name: 'owner_actor_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Visible Daily Scope list', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Create or update a personal Daily Scope',
          description: 'Upserts one active Daily Scope per workspace, owner_actor_id, and note_date. Top-level channel_id and scope_id are optional provenance only; metadata.scope_id and metadata.channel_id are stored as metadata but never used to bind the note to a shared scope. Agents may target another owner only with explicit Daily Scope access; Yoke is not part of this path.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['note_date'],
                  properties: {
                    note_date: { type: 'string', format: 'date' },
                    owner_actor_id: { type: 'string', format: 'uuid' },
                    owner_npub: { type: 'string' },
                    scope_id: { type: ['string', 'null'], format: 'uuid' },
                    channel_id: { type: ['string', 'null'], format: 'uuid' },
                    title: { type: 'string' },
                    body: { type: ['string', 'null'] },
                    focus: { type: ['string', 'null'] },
                    items: {
                      type: 'array',
                      maxItems: 5,
                      items: {
                        type: 'object',
                        required: ['text'],
                        properties: {
                          id: { type: 'string' },
                          text: { type: 'string', minLength: 1 },
                          completed: { type: 'boolean' },
                          source: { type: 'string' },
                          created_at: { type: 'string', format: 'date-time' },
                          updated_at: { type: 'string', format: 'date-time' },
                        },
                      },
                    },
                    status: { type: 'string', enum: ['active', 'archived'] },
                    metadata: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Daily Scope updated', content: { 'application/json': { schema: { type: 'object' } } } },
            '201': { description: 'Daily Scope created', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Daily Scope access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/daily-notes/{dailyNoteId}': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Read one visible personal Daily Scope',
          description: 'Reads a Daily Scope only when the signer is the owner or has explicit Daily Scope agent access from the owner.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'dailyNoteId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Daily Scope detail', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Daily Scope access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Daily Scope not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/daily-notes/{dailyNoteId}/versions': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'List Daily Scope versions',
          description: 'Lists meaningful Daily Scope content snapshots. Checkbox-only completion updates keep the current row_version but do not create noisy version snapshots.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'dailyNoteId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Daily Scope version list', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Daily Scope access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Daily Scope not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/daily-scope/agent-access': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'List my Daily Scope agent access',
          description: 'Lists the agents explicitly allowed to read and edit the signed-in human owner’s Daily Scope.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Daily Scope access list', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Grant or update my Daily Scope agent access',
          description: 'Grants one workspace member explicit access to the signed-in human owner’s Daily Scope.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { agent_actor_id: { type: 'string', format: 'uuid' }, agent_npub: { type: 'string' }, can_read: { type: 'boolean' }, can_write: { type: 'boolean' } } } } },
          },
          responses: {
            '201': { description: 'Daily Scope access granted', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Agent membership not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/daily-scope/agent-access/{agentActorId}': {
        delete: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Revoke my Daily Scope agent access',
          description: 'Revokes one agent’s explicit access to the signed-in human owner’s Daily Scope without changing channel permissions.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'agentActorId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Daily Scope access revoked', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/personal-wapps': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'List visible personal WApps',
          description: 'Lists personal WApp launchers visible to the signer. Visibility follows Daily Scope ownership and explicit Daily Scope agent access.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'owner_actor_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'include_archived', in: 'query', required: false, schema: { type: 'boolean' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Personal WApp list', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Personal WApp access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Create a personal WApp launcher',
          description: 'Creates a personal WApp launcher in the owner’s personal scope. Agents may target another owner only with explicit Daily Scope write access.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title', 'launch_url'],
                  properties: {
                    owner_actor_id: { type: 'string', format: 'uuid' },
                    owner_npub: { type: 'string' },
                    title: { type: 'string', minLength: 1 },
                    description: { type: ['string', 'null'] },
                    launch_url: { type: 'string', format: 'uri' },
                    icon_url: { type: ['string', 'null'], format: 'uri' },
                    app_id: { type: ['string', 'null'] },
                    wapp_id: { type: ['string', 'null'] },
                    source_wingman_url: { type: ['string', 'null'], format: 'uri' },
                    sort_order: { type: 'integer', minimum: 0 },
                    status: { type: 'string', enum: ['active', 'archived'] },
                    metadata: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Personal WApp created', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Personal WApp access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/personal-wapps/{personalWappId}': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Read one personal WApp launcher',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'personalWappId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Personal WApp detail', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Personal WApp access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Personal WApp not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        patch: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Update a personal WApp launcher',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'personalWappId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '200': { description: 'Personal WApp updated', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Personal WApp access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Personal WApp not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        delete: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Archive a personal WApp launcher',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'personalWappId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Personal WApp archived', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Personal WApp access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Personal WApp not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/personal-wapps/origin-policy': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Resolve trusted personal WApp signer policy by origin',
          description: 'Returns signer policy and Tower-owned personal WApp assignment identity only when exactly one active WApp visible to the authenticated actor explicitly trusts the exact HTTP(S) origin. Unregistered, disabled, archived, invisible, invalid, and ambiguous assignments fail closed.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'origin', in: 'query', required: true, description: 'Embedded page origin. URL paths are discarded and wildcard hostnames are not supported.', schema: { type: 'string', format: 'uri' } },
          ],
          responses: {
            '200': {
              description: 'Origin policy decision',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['identity', 'policy'],
                    properties: {
                      identity: { type: 'object' },
                      policy: {
                        type: 'object',
                        required: ['trusted', 'reason', 'origin', 'personal_wapp', 'signer_profile'],
                        properties: {
                          trusted: { type: 'boolean' },
                          reason: { type: 'string', enum: ['trusted', 'not_registered', 'ambiguous_origin'] },
                          origin: { type: 'string', format: 'uri' },
                          personal_wapp: { type: ['object', 'null'] },
                          signer_profile: { type: ['object', 'null'] },
                        },
                      },
                    },
                  },
                },
              },
            },
            '400': { description: 'Invalid origin', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/personal-wapps/reorder': {
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Reorder personal WApp launchers',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['ordered_ids'], properties: { ordered_ids: { type: 'array', items: { type: 'string', format: 'uuid' } }, owner_actor_id: { type: 'string', format: 'uuid' }, owner_npub: { type: 'string' } } } } },
          },
          responses: {
            '200': { description: 'Personal WApps reordered', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Personal WApp access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/wapp-activity/workspaces/{workspaceId}/grants/me': {
        get: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Read the signing installation publishing grant',
          description: 'Resolves the installation only from the verified NIP-98 signer. Supports ETag and If-None-Match and never enumerates other workspace data.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'If-None-Match', in: 'header', required: false, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Own grant', headers: { ETag: { schema: { type: 'string' } } }, content: { 'application/json': { schema: { type: 'object', properties: { grant: { $ref: '#/components/schemas/WappPublishingGrant' } } } } } },
            '304': { description: 'Grant version is unchanged' }, '401': { description: 'Invalid NIP-98 auth' }, '403': { description: 'Stale or unregistered publisher' }, '404': { description: 'No workspace grant' },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-delegations': {
        get: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'List owner grants or the delegate’s own wapp_management grants', description: 'The stable UI role wapp_management maps to the canonical Tower permission wapp.manage.', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Visible delegations' }, '403': { description: 'Workspace membership required' } } },
        post: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Owner grants filtered wapp_management authority', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['delegate_actor_id','expires_at','filters'], properties: { delegate_actor_id: { type: 'string', format: 'uuid' }, expires_at: { type: 'string', format: 'date-time' }, owner_signature: { type: 'string' }, filters: { type: 'object', description: 'Exact optional app/installation/scope/channel/capability/open-origin and Autopilot-origin filters.' } } } } } }, responses: { '201': { description: 'Delegation created' }, '403': { description: 'Workspace owner required' } } },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-delegations/{delegationId}': { get: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Read one visible WApp delegation', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },{ name: 'delegationId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Delegation' }, '404': { description: 'Not visible or missing' } } } },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-delegations/{delegationId}/revoke': { post: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Owner immediately revokes a WApp delegation', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },{ name: 'delegationId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Revoked delegation' }, '403': { description: 'Workspace owner required' } } } },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-install-intents': {
        get: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'List authorized WApp installation sagas', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Visible intents' } } },
        post: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Create an idempotent existing-app WApp installation intent', description: 'Delegated template creation returns step_up_required in v1.', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['client_request_id','app_id','app_version','title','launch_url','autopilot_origin','autopilot_npub'], properties: { client_request_id: { type: 'string' }, delegation_id: { type: 'string', format: 'uuid' }, app_id: { type: 'string' }, app_version: { type: 'string' }, wapp_installation_id: { type: 'string' }, title: { type: 'string' }, launch_url: { type: 'string', format: 'uri' }, autopilot_origin: { type: 'string', format: 'uri' }, autopilot_npub: { type: 'string' }, registered_open_origins: { type: 'array', items: { type: 'string', format: 'uri' } }, capabilities: { type: 'array', items: { type: 'string', enum: ['activity.publish'] } }, destinations: { type: 'array', items: { type: 'object' } } } } } } }, responses: { '201': { description: 'Intent and one-time claim challenge created' }, '200': { description: 'Idempotent replay' }, '403': { description: 'Delegation/filter/step-up denial' }, '409': { description: 'Idempotency conflict' } } },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-install-intents/{intentId}': { get: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Read one authorized WApp installation saga', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },{ name: 'intentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Intent' }, '404': { description: 'Not visible or missing' } } } },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-install-intents/{intentId}/claim': { post: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Claim an intent with its single-use Tower challenge', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },{ name: 'intentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Claimed' }, '409': { description: 'Not claimable or stale' } } } },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-install-intents/{intentId}/complete': { post: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Attest and atomically finalize installation, launcher, and Feed grant', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },{ name: 'intentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Active installation' }, '403': { description: 'Attestation or live delegation denied' }, '409': { description: 'Identity, destination, or version conflict' } } } },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-install-intents/{intentId}/fail': { post: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Record a repairable installation failure', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },{ name: 'intentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Failed intent recorded' }, '409': { description: 'Wrong claimant or state' } } } },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-installations': { get: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'List joined managed installation, launcher, and publishing lifecycle', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Authorized managed installations' }, '403': { description: 'wapp.manage required' } } } },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-installations/{installationId}': { get: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Read one joined managed installation lifecycle', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },{ name: 'installationId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Managed installation' }, '403': { description: 'Filtered wapp.manage required' } } } },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-installations/{installationId}/reconcile': { post: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Request asynchronous reconciliation without caller-supplied state', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },{ name: 'installationId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '202': { description: 'Reconciliation queued' }, '403': { description: 'Filtered wapp.manage required' } } } },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-installations/{installationId}/revoke': { post: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Immediately revoke Tower authority, Feed grant, and launcher', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },{ name: 'installationId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Revoked and teardown queued' }, '403': { description: 'Filtered wapp.manage required' } } } },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-installations/{installationId}/uninstall': { post: { tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Request protected runtime teardown', parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },{ name: 'installationId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '403': { description: 'step_up_required in Tower v1' } } } },
      '/api/v4/wapp-activity/workspaces/{workspaceId}/items': {
        post: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Publish or version-upsert one WApp activity projection',
          description: 'The publisher and stable installation are derived from the NIP-98 signer. The request targets exactly one approved destination and is limited to 16 KiB.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/WappActivityPublishRequest' } } } },
          responses: {
            '201': { description: 'Projection created or updated', content: { 'application/json': { schema: { type: 'object', properties: { item: { $ref: '#/components/schemas/WappActivityItem' }, replayed: { type: 'boolean' } } } } } },
            '200': { description: 'Idempotent replay' }, '400': { description: 'Invalid payload or unsafe open URL' }, '403': { description: 'Grant, capability, key, or destination rejected' },
            '409': { description: 'Version conflict, stale version, scope move, unavailable channel, or withdrawn tombstone' }, '413': { description: 'Payload exceeds 16 KiB' }, '429': { description: 'Publisher or destination rate limit exceeded' },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-publishing-grants': {
        get: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'List administrator-visible WApp publishing grants',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Publishing grants', content: { 'application/json': { schema: { type: 'object', properties: { grants: { type: 'array', items: { $ref: '#/components/schemas/WappPublishingGrant' } } } } } } }, '403': { description: 'workspace.manage required' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-publishing-grants/{wappInstallationId}': {
        get: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Inspect one WApp publishing grant',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'wappInstallationId', in: 'path', required: true, schema: { type: 'string', maxLength: 128 } }],
          responses: { '200': { description: 'Publishing grant', content: { 'application/json': { schema: { type: 'object', properties: { grant: { $ref: '#/components/schemas/WappPublishingGrant' } } } } } }, '403': { description: 'workspace.manage required' }, '404': { description: 'Grant not found' } },
        },
        put: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Create or replace a WApp publishing grant and destination allowlist',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'wappInstallationId', in: 'path', required: true, schema: { type: 'string', maxLength: 128 } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/WappPublishingGrantPutRequest' } } } },
          responses: { '201': { description: 'Grant created or replaced' }, '400': { description: 'Invalid destination, origin, or capability' }, '403': { description: 'workspace.manage required' }, '409': { description: 'Stable installation identity conflict' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-publishing-grants/{wappInstallationId}/disable': {
        post: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Disable or re-enable a WApp publishing grant immediately',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'wappInstallationId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['disabled'], properties: { disabled: { type: 'boolean' }, reason: { type: 'string' } } } } } },
          responses: { '200': { description: 'Updated grant' }, '403': { description: 'workspace.manage required' }, '404': { description: 'Grant not found' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-publishing-grants/{wappInstallationId}/revoke': {
        post: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Revoke a WApp publishing grant immediately',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'wappInstallationId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' }, disable_open_links: { type: 'boolean' } } } } } },
          responses: { '200': { description: 'Revoked grant' }, '403': { description: 'workspace.manage required' }, '404': { description: 'Grant not found' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-publishing-grants/{wappInstallationId}/rotate': {
        post: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Approve a bounded WApp publisher-key rotation',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'wappInstallationId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['current_publisher_npub', 'new_publisher_npub', 'nonce', 'expires_at'], properties: { current_publisher_npub: { type: 'string' }, new_publisher_npub: { type: 'string' }, nonce: { type: 'string', maxLength: 256 }, expires_at: { type: 'string', format: 'date-time' } } } } } },
          responses: { '200': { description: 'Rotated grant' }, '400': { description: 'Invalid or expired rotation request' }, '403': { description: 'workspace.manage required' }, '409': { description: 'Stale current publisher key' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-activity/items': {
        get: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'List ACL-filtered WApp activity for the current user',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'unread', in: 'query', schema: { type: 'boolean' } },
            { name: 'state', in: 'query', schema: { type: 'string', enum: ['active', 'resolved'] } }, { name: 'installation_id', in: 'query', schema: { type: 'string' } },
            { name: 'category', in: 'query', schema: { type: 'string' } }, { name: 'channel_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'include_resolved', in: 'query', schema: { type: 'boolean' } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: { '200': { description: 'Visible non-dismissed, non-muted activity', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/WappActivityItem' } }, next_cursor: { type: ['string', 'null'] } } } } } }, '403': { description: 'Workspace membership required' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-activity/items/{itemId}': {
        get: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Read one currently accessible WApp activity item',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'itemId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Visible item with current reader-safe source and open-link authority', content: { 'application/json': { schema: { type: 'object', required: ['item'], properties: { item: { $ref: '#/components/schemas/WappActivityItem' } } } } } }, '403': { description: 'Workspace membership required' }, '404': { description: 'Item absent or inaccessible' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-activity/counts': {
        get: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Count current ACL-filtered active and unread WApp activity',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Leak-safe current counts', content: { 'application/json': { schema: { type: 'object', properties: { counts: { type: 'object', properties: { active: { type: 'integer' }, unread: { type: 'integer' } } } } } } } } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-activity/items/{itemId}/user-state': {
        patch: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Set read, unread, dismiss, or restore state for an accessible item',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'itemId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/WappActivityUserStatePatch' } } } },
          responses: { '200': { description: 'Updated per-user state' }, '404': { description: 'Item absent or inaccessible' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-activity/mutes': {
        get: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'List current user WApp activity mutes',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Mute list' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/wapp-activity/mutes/{targetType}/{targetValue}': {
        put: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Mute one installation or category',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'targetType', in: 'path', required: true, schema: { type: 'string', enum: ['installation', 'category'] } }, { name: 'targetValue', in: 'path', required: true, schema: { type: 'string', maxLength: 128 } }], responses: { '201': { description: 'Mute created' } },
        },
        delete: {
          tags: ['WApp Activity'], security: [{ nip98: [] }], summary: 'Remove one installation or category mute',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'targetType', in: 'path', required: true, schema: { type: 'string', enum: ['installation', 'category'] } }, { name: 'targetValue', in: 'path', required: true, schema: { type: 'string', maxLength: 128 } }], responses: { '200': { description: 'Mute removal result' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/search': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Search readable Flight Deck records in one workspace',
          description: 'Returns up to five ranked active records from a selected scope group subtree, outside that subtree, or the whole workspace. Results are restricted to channels readable by the authenticated workspace member.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 2 } },
            { name: 'scope_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'mode', in: 'query', required: false, schema: { type: 'string', enum: ['subtree', 'outside_subtree', 'workspace'] } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 5, default: 5 } },
          ],
          responses: {
            '200': { description: 'Ranked readable search results', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid search parameters', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/events': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Poll visible Flight Deck PG outbox events',
          description: 'Returns access-filtered outbox rows newer than the opaque cursor, ordered by globally monotonic outbox row_version. Every event has a stable event_id/cursor plus entity_row_version. With bounded audience_npub values, Tower scans one workspace cursor page, returns the union visible under each explicitly manager-authorized workspace identity, adds deterministic per-identity visibility evidence, and advances next_cursor/through_cursor to the scanned workspace high-water even when no event is visible. Actor kind and membership role do not affect audience eligibility. Without audience_npub it retains the legacy authenticated-actor behavior.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.events.list'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque cursor returned as next_cursor by this endpoint.' },
            { name: 'since', in: 'query', required: false, schema: { type: 'string' }, description: 'Alias for cursor for backend-contract wording compatibility.' },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
            { name: 'audience_npub', in: 'query', required: false, schema: { type: 'array', maxItems: 32, items: { type: 'string' } }, style: 'form', explode: true, description: 'Repeat once per explicitly authorized managed workspace identity. Unavailable identities are reported and omitted without widening visibility for the remaining audience.' },
          ],
          responses: {
            '200': { description: 'Visible event cursor page', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid cursor', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/event-subscription-agents': {
        get: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'List the caller’s authorized event-subscription audience',
          description: 'Returns only the authenticated manager’s explicit managed-identity relation. Requires event_subscription.manage.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Authorized audience npubs' }, '401': { description: 'Invalid NIP-98 auth' }, '403': { description: 'event_subscription.manage required' }, '404': { description: 'Workspace not found' } },
        },
        put: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'Reconcile the caller’s authorized event-subscription audience',
          description: 'Requires event_subscription.manage. Reconciles only the authenticated caller’s bounded managed-identity set. Any active workspace member is eligible regardless of actor kind or membership role; unavailable identities are returned separately and do not disable accepted identities.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { agent_npubs: { type: 'array', maxItems: 32, uniqueItems: true, items: { type: 'string' } }, audience_npubs: { type: 'array', maxItems: 32, uniqueItems: true, items: { type: 'string' } } } } } } },
          responses: { '200': { description: 'Accepted and rejected audience npubs' }, '400': { description: 'Invalid target set' }, '401': { description: 'Invalid NIP-98 auth' }, '403': { description: 'event_subscription.manage required' }, '404': { description: 'Workspace not found' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/events/stream': {
        get: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'Stream visible Flight Deck PG events',
          description: 'SSE equivalent of event polling. Supports the same bounded repeated audience_npub set and per-identity visibility evidence, advances through the same bounded workspace scan cursor, and revalidates manager authority, active memberships, effective groups, and grants on every poll. Individual audience removals emit flightdeck_pg.audience_changed while valid identities continue; manager revocation closes the stream. Authorization-header clients sign the complete URL. Browser EventSource clients may provide exactly one transport-only token query parameter; token is excluded from URL verification, but cursor, since, limit, repeated audience_npub values, and their exact order remain signed.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'since', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
            { name: 'audience_npub', in: 'query', required: false, schema: { type: 'array', maxItems: 32, items: { type: 'string' } }, style: 'form', explode: true },
            { name: 'token', in: 'query', required: false, schema: { type: 'string' }, description: 'Transport-only base64 NIP-98 event for browser EventSource clients. Exactly one non-empty value is required when selected and this parameter alone is excluded from the signed URL.' },
          ],
          responses: { '200': { description: 'SSE event stream' }, '400': { description: 'Invalid cursor or audience' }, '401': { description: 'Invalid NIP-98 auth' }, '403': { description: 'Workspace membership or audience authorization required' }, '404': { description: 'Workspace not found' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/sync': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Fetch a bundled workspace snapshot or cursor delta',
          description: 'Returns one access-filtered materialization bundle. Without a cursor it returns a snapshot and high-water cursor. With a cursor it returns only channel bundles affected by visible outbox events after that cursor.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque cursor returned as next_cursor by this endpoint.' },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 2000, default: 500 } },
          ],
          responses: {
            '200': { description: 'Bundled snapshot or delta', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid cursor', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}/threads/{threadId}/workroom-context': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Resolve typed workroom context for a chat thread',
          description: 'Returns isWorkroom false for ordinary threads. Workroom responses include typed room, participant, app-target, event, link, and open-approval context.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'threadId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'participant_npub', in: 'query', required: false, schema: { type: 'string' }, description: 'Participant npub to resolve; defaults to the authenticated signer.' },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Typed workroom context or ordinary-thread result', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Channel read permission required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Channel or workspace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/storage/prepare': {
        post: {
          tags: ['Flight Deck PG'],
          summary: 'Prepare a private PG workspace storage upload',
          description: 'Authenticates a PG workspace member and authority-writes the workspace owner. Browser-supplied owner_group_id and access_group_ids are ignored; stable group UUID authorization is evaluated later from Tower-owned channel grants when the object is atomically associated with a message, file, doc, or audio note. Objects remain owner/uploader-only until association. Public prepares remain restricted to explicit workspace-profile avatar uploads.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['content_type'],
              properties: {
                content_type: { type: 'string' },
                size_bytes: { type: 'integer', minimum: 0 },
                file_name: { type: ['string', 'null'] },
                owner_group_id: { type: ['string', 'null'], format: 'uuid', deprecated: true, description: 'Ignored. Tower derives scoped access from authoritative PG record links and grants.' },
                access_group_ids: { type: ['array', 'null'], items: { type: 'string', format: 'uuid' }, deprecated: true, description: 'Ignored. Arbitrary browser-supplied stable group UUIDs are never trusted.' },
                is_public: { type: 'boolean', default: false },
                metadata: { type: ['object', 'null'], additionalProperties: true },
              },
            } } },
          },
          responses: {
            '201': { description: 'Prepared private PG upload; content_url remains protected until public opt-in or an authorized typed record link exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/PrepareStorageResponse' } } } },
            '400': { description: 'Invalid request or disallowed public storage purpose', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/drive/tree': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'List visible Drive file/folder tree items',
          description: 'Returns active Flight Deck PG file and file-folder metadata as Drive tree items. Optional scope_id, channel_id, and parent_folder_id filters let Drive list children without interpreting app-specific row shapes.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.drive.tree'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'scope_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'channel_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'parent_folder_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid', nullable: true }, description: 'Folder UUID to list children for, or an empty value to list roots.' },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque Drive tree cursor returned as next_cursor by this endpoint.' },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Visible Drive tree item page', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid filter or cursor', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'File/channel read permission required for explicit channel or parent folder', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace or parent folder not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/drive/delta': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Poll visible Drive file/folder changes',
          description: 'Returns Drive-specific file and folder operations from the Flight Deck PG outbox cursor stream. Each change includes a canonical refetch route for the current file or folder metadata.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.drive.delta'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque event cursor returned as next_cursor by this endpoint.' },
            { name: 'since', in: 'query', required: false, schema: { type: 'string' }, description: 'Alias for cursor.' },
            { name: 'scope_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'channel_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Visible Drive change cursor page', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid filter or cursor', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'File/channel read permission required for explicit channel', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/files/{fileId}/object': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Read authorized Flight Deck PG file object content',
          description: 'Returns the existing full-object JSON/base64 payload when no Range header is supplied. Supports a single HTTP bytes Range request and returns raw partial file bytes with 206 Partial Content, Content-Range, Accept-Ranges, and ETag when the current storage object has a sha256 validator.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'fileId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'Range', in: 'header', required: false, schema: { type: 'string', pattern: '^bytes=' }, description: 'Single byte range, for example bytes=0-1048575 or bytes=-65536. Multiple ranges are not supported.' },
          ],
          responses: {
            '200': {
              description: 'Full file object JSON payload with base64-encoded bytes',
              headers: {
                'Accept-Ranges': { schema: { type: 'string', enum: ['bytes'] } },
                ETag: { schema: { type: 'string' } },
              },
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            '206': {
              description: 'Raw partial file bytes for a valid single byte range',
              headers: {
                'Accept-Ranges': { schema: { type: 'string', enum: ['bytes'] } },
                'Content-Range': { schema: { type: 'string' } },
                'Content-Length': { schema: { type: 'integer', minimum: 0 } },
                ETag: { schema: { type: 'string' } },
              },
              content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
            },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'File or channel read permission required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'File, storage link, storage object, or content not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'File object upload is incomplete', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '416': {
              description: 'Requested byte range is not satisfiable',
              headers: {
                'Accept-Ranges': { schema: { type: 'string', enum: ['bytes'] } },
                'Content-Range': { schema: { type: 'string' } },
                ETag: { schema: { type: 'string' } },
              },
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/files/{fileId}': {
        delete: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Tombstone a Flight Deck PG file',
          description: 'Soft-deletes a file, creates a deleted file-version row for audit history, tombstones active storage links, and emits a visible Drive delta event with a durable tombstone payload.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.files.delete'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'fileId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    row_version: { type: 'integer', minimum: 1 },
                    client_mutation_id: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'File tombstoned with audit and outbox evidence', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'File or channel write permission required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace or file not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Stale row_version', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/file-folders/{folderId}': {
        delete: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Tombstone an empty Flight Deck PG file folder',
          description: 'Soft-deletes an empty folder and emits a visible Drive delta event with a durable tombstone payload. Version 1 supports empty-only deletes.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.file_folders.delete'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'folderId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    row_version: { type: 'integer', minimum: 1 },
                    mode: { type: 'string', enum: ['empty-only'], default: 'empty-only' },
                    client_mutation_id: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Folder tombstoned with audit and outbox evidence', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid body', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'File or channel write permission required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace or folder not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Stale row_version or folder_not_empty', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/files/{fileId}/versions': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'List Flight Deck PG file versions',
          description: 'Returns newest-first immutable version metadata for an active or tombstoned file. Each version includes its storage object reference, byte size, content type, SHA-256/ETag, creating actor, base version, and operation. Version 1 accepts a limit and returns next_cursor as null.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.files.versions.list'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'fileId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: {
            '200': { description: 'Newest-first file version metadata', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'File or channel read permission required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace or file not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Replace Flight Deck PG file content with optimistic base version',
          description: 'Creates a new file version and advances the file current storage object only when base_version_id matches the current version. Stale clients receive 409 stale_base_version with current file/version metadata.',
          'x-flightdeck-pg-contract-fixture': flightDeckPgContractFixturePaths['flightdeck_pg.files.versions.create'],
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'fileId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['base_version_id', 'storage_object_id'],
                  properties: {
                    base_version_id: { type: 'string', format: 'uuid' },
                    storage_object_id: { type: 'string', format: 'uuid' },
                    client_mutation_id: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created file version and advanced current file object', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid body or storage object', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'File or channel write permission required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace or file not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Stale base_version_id or storage object conflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/notifications/config': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Read Web Push notification configuration',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Notification config', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/notifications/settings': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Read Web Push notification configuration',
          description: 'Backward-compatible alias for /notifications/config used by Flight Deck clients.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Notification config', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/notifications/preferences': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Read workspace notification preferences for the current actor',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Notification preferences', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        patch: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Update workspace notification preferences for the current actor',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '200': { description: 'Updated notification preferences', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/notifications/subscriptions': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'List current actor Web Push subscriptions',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Push subscriptions', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Register or update a Web Push subscription',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['endpoint', 'keys'] } } },
          },
          responses: {
            '201': { description: 'Push subscription registered', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/notifications/subscriptions/{subscriptionId}': {
        delete: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Revoke a Web Push subscription for the current actor',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'subscriptionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Push subscription revoked', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Subscription not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/notifications/deliveries': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'List notification delivery evidence for the current actor',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Notification deliveries', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace membership required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/notifications/evaluate': {
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Evaluate one outbox event for notification delivery',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['outbox_event_id'], properties: { outbox_event_id: { type: 'string', format: 'uuid' } } } } },
          },
          responses: {
            '200': { description: 'Notification evaluation result', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace read permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/resource-view-states': {
        get: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }],
          summary: 'List the current viewer resource view states',
          description: 'Baselines visible resources on first use, then returns every visible thread/task/document in deterministic resource_type/resource_id order. Resources created after baseline without a stored view row are returned with viewed_activity_version and row_version 0. Unread is activity_version > viewed_activity_version. Follow next_cursor until null for a complete Dexie hydration snapshot.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'resource_type', in: 'query', schema: { type: 'string', enum: ['thread', 'task', 'document'] } },
            { name: 'channel_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque continuation cursor from next_cursor. Filters must remain unchanged across pages.' },
          ],
          responses: { '200': { description: 'Visible resource view states', content: { 'application/json': { schema: { type: 'object' } } } }, '401': { description: 'Invalid NIP-98 auth' }, '403': { description: 'Workspace membership required' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/resource-view-states/{resourceType}/{resourceId}': {
        put: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'Monotonically mark one visible resource viewed',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'resourceType', in: 'path', required: true, schema: { type: 'string', enum: ['thread', 'task', 'document'] } },
            { name: 'resourceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['viewed_activity_version'], properties: { viewed_activity_version: { type: 'integer', minimum: 0 } } } } } },
          responses: { '200': { description: 'Current monotonic view state', content: { 'application/json': { schema: { type: 'object' } } } }, '403': { description: 'Resource not visible' }, '404': { description: 'Resource not found' }, '409': { description: 'Requested version is ahead of resource' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/resource-view-states/mark-viewed': {
        post: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'Explicitly mark a visible resource collection viewed',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['resources'], properties: { resources: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', required: ['resource_type', 'resource_id'], properties: { resource_type: { type: 'string', enum: ['thread', 'task', 'document'] }, resource_id: { type: 'string', format: 'uuid' } } } } } } } } },
          responses: { '200': { description: 'Current states for the explicit collection', content: { 'application/json': { schema: { type: 'object' } } } }, '403': { description: 'A resource is not visible' }, '404': { description: 'A resource was not found' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/channels/{channelId}/tasks': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'List tasks for a channel task board',
          description: 'Implemented PH2-2 runtime channel task list. Authorizes task.read on the channel and returns only tasks anchored to that channel.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Channel task list', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Create a channel task',
          description: 'Creates a task transactionally. Canonical description agent mentions may be supplied as top-level mentions or metadata.mentions and are stored as metadata.mentions entries containing actor_id and npub after task.read validation. The outbox event includes the canonical task, mentions, author identity, entity row version, stable event ID, and cursor.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '201': { description: 'Channel task created', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Channel not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/agent-activities': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Hydrate current user-visible agent activity snapshots',
          description: 'Returns only unexpired latest snapshots visible through channel.read. Each snapshot includes immutable turn_id when known, created_at for cross-turn ordering, and commentary_history containing accepted user-visible working commentary for that exact turn in ascending sequence order. Legacy rows may serialize turn_id as null with an empty commentary_history. Use channel_id plus optional thread_id or activity_id after first load or SSE reconnect.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'channel_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'thread_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'activity_id', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Current agent activity snapshots with durable ordered commentary_history', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Channel read permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/agent-activities/{activityId}': {
        put: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Publish a latest user-visible agent activity snapshot',
          description: 'Authenticates the agent as the publisher, requires channel.write, validates trigger-message/thread correlation, requires an immutable turn_id, accepts only visibility=user_visible, replaces state only when sequence increases, and makes terminal replay idempotent. Accepted working updates with non-empty summary or body are appended transactionally to durable commentary_history; terminal bodies are never appended. Sequence is scoped to one activity lifecycle; consumers order lifecycles by created_at then activity_id. Changed snapshots are delivered through the normal Flight Deck PG SSE event stream as flightdeck_pg.agent_activity.snapshot and clients refetch hydration for history.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'activityId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['channel_id', 'thread_id', 'trigger_message_id', 'turn_id', 'session_id', 'agent_npub', 'state', 'visibility', 'sequence'], properties: { turn_id: { type: 'string', minLength: 1, maxLength: 255 } } } } } },
          responses: {
            '200': { description: 'Updated or idempotently replayed snapshot', content: { 'application/json': { schema: { type: 'object' } } } },
            '201': { description: 'Created snapshot', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Channel write permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Thread or trigger message not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Stale sequence, immutable turn identity mismatch, or attempted mutation after terminal state', content: { 'application/json': { schema: { type: 'object' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/scopes/{scopeId}/tasks': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'List visible tasks in a scope',
          description: 'Implemented PH2-2 runtime scope rollup. Returns tasks only from channels where the signer has task.read.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'scopeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: {
            '200': { description: 'Scope task rollup', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Get a task',
          description: 'Implemented PH2-2 runtime task read. Authorizes task.read on the task channel.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Task row', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Task not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        patch: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Patch a task',
          description: 'Patches a task transactionally. Canonical description agent mentions may be supplied as top-level mentions or metadata.mentions and are stored with actor_id and npub after task.read validation. The event payload exposes previous/current mention arrays, current task location, logical author and NIP-98 signer provenance, and entity row version for idempotent transition detection.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '200': { description: 'Task updated', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Task not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Task write conflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}/move': {
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Move a task to another visible writable channel',
          description: 'Atomically preserves the task ID, comments, assignments, watchers, reactions, thread link, and history while changing its canonical scope/channel placement. Requires task.read and task.update on the source plus channel.read and task.create on the destination. Emits source and destination outbox events.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['destination_channel_id'], properties: { destination_channel_id: { type: 'string', format: 'uuid' }, destination_scope_id: { type: 'string', format: 'uuid' }, row_version: { type: 'integer', minimum: 1 } } } } } },
          responses: {
            '200': { description: 'Canonical moved task and movement evidence', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid or inconsistent destination', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Source or destination permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Task or destination channel not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Same destination or stale row version', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/docs/{docId}': {
        patch: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'Save a document revision',
          description: 'Body saves compare row_version plus base_body_sha256_hex (and optional base_version_id) atomically against the canonical head. A match advances canonical history under the edit lease. A stale base, or base_available=false, returns 409 with an idempotent non-head recovery version and does not emit a canonical-updated event. Metadata-only saves retain the existing optimistic row-version and edit-lease behavior. Mentions remain canonicalized and emit flightdeck_pg.document_mention_added only for newly added agents.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { row_version: { type: 'integer', minimum: 1 }, base_available: { type: 'boolean', default: true }, base_version_id: { type: 'string' }, base_body_sha256_hex: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' }, storage_object_id: { type: 'string', format: 'uuid' }, lease_token: { type: 'string' }, title: { type: 'string' }, summary: { type: ['string', 'null'] }, archived: { type: 'boolean' }, mentions: { type: 'array', items: { $ref: '#/components/schemas/FlightDeckPgAgentMentionInput' } }, metadata: { type: 'object', additionalProperties: true } } } } } },
          responses: { '200': { description: 'Accepted canonical document and exact canonical version/body identity' }, '400': { description: 'Invalid base, body, or inaccessible mention' }, '403': { description: 'Document write denied' }, '409': { description: 'Recovery version evidence for a stale/unavailable base, or edit-lease conflict' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/docs/{docId}/recoveries': {
        get: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'List document recovery versions',
          description: 'Lists open recovery versions by default. Requires doc.read or channel.read and never exposes raw storage paths.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'state', in: 'query', required: false, schema: { type: 'string', enum: ['open', 'promoted', 'discarded', 'all'], default: 'open' } }, { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } },
          ],
          responses: { '200': { description: 'Authorized recovery version list' }, '403': { description: 'Document read denied' }, '404': { description: 'Document not found' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/docs/{docId}/recoveries/{recoveryId}': {
        get: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'Read document recovery evidence',
          description: 'Returns stored base/head/submitted identities, provenance, resolution state, and the then-current canonical head.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'recoveryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Authorized recovery evidence' }, '403': { description: 'Document read denied' }, '404': { description: 'Document or recovery not found' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/docs/{docId}/recoveries/{recoveryId}/body': {
        get: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'Read a recovery document body',
          description: 'Reads the recovery storage object through the document storage link and doc.read/channel.read authorization.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'recoveryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Authorized recovery body and content identity' }, '403': { description: 'Document read denied' }, '404': { description: 'Document, recovery, link, or content not found' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/docs/{docId}/recoveries/{recoveryId}/promote': {
        post: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'Optimistically promote a document recovery version',
          description: 'Requires doc.write/channel.write and a valid document edit lease. Atomically compares row_version plus current base body identity before advancing canonical head; a newer head returns structured 409 evidence rather than force-overwriting it.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'recoveryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['row_version', 'base_body_sha256_hex', 'lease_token'], properties: { row_version: { type: 'integer', minimum: 1 }, base_version_id: { type: 'string' }, base_body_sha256_hex: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' }, lease_token: { type: 'string' } } } } } },
          responses: { '200': { description: 'Recovery promoted and canonical head advanced once' }, '400': { description: 'Invalid promotion base' }, '403': { description: 'Document write denied' }, '404': { description: 'Document or recovery not found' }, '409': { description: 'Head changed, lease conflict, or recovery already discarded' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/docs/{docId}/recoveries/{recoveryId}/discard': {
        post: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'Discard an open document recovery version',
          description: 'Idempotently resolves an open recovery as discarded without changing canonical row_version. Its authorized storage link is retained as immutable audit evidence.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'recoveryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Recovery discarded or exact discard replay returned' }, '403': { description: 'Document write denied' }, '404': { description: 'Document or recovery not found' }, '409': { description: 'Recovery was already promoted' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/docs/{docId}/comments': {
        post: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'Create a document comment or inline reply',
          description: 'Creates a comment while preserving parent_comment_id. Structured mentions are canonicalized and doc.read access-checked; a non-empty canonical set emits flightdeck_pg.document_comment_mention_added with comment linkage, document body version/hash, logical author, signer provenance, stable event ID, and cursor.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['body'], properties: { body: { type: 'string', minLength: 1 }, parent_comment_id: { type: 'string', format: 'uuid', nullable: true }, mentions: { type: 'array', items: { $ref: '#/components/schemas/FlightDeckPgAgentMentionInput' } }, metadata: { type: 'object', additionalProperties: true } } } } } },
          responses: { '201': { description: 'Created comment plus ordinary and optional mention-trigger outbox evidence' }, '400': { description: 'Invalid or inaccessible mention' }, '403': { description: 'Document write denied' }, '404': { description: 'Document or parent comment not found' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/invocations': {
        post: {
          tags: ['Flight Deck PG'], security: [{ nip98: [] }], summary: 'Create an invocation, including a default-agent full-document review request',
          description: 'Extends the existing Flight Deck document-header invocation action. trigger=full_document_review_requested requires one readable document target, one readable agent recipient (the UI-selected default agent), and client_request_id. Exact retries deterministically return the existing invocation; conflicting reuse returns 409. Tower emits flightdeck_pg.full_document_review_requested and does not store Autopilot session state.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['scope_id', 'channel_id', 'prompt', 'recipients', 'targets'], properties: { trigger: { type: 'string', enum: ['full_document_review_requested'] }, client_request_id: { type: 'string' }, scope_id: { type: 'string', format: 'uuid' }, channel_id: { type: 'string', format: 'uuid' }, prompt: { type: 'string' }, recipients: { type: 'array', minItems: 1, maxItems: 1 }, targets: { type: 'array', minItems: 1, maxItems: 1 }, metadata: { type: 'object', additionalProperties: true } } } } } },
          responses: { '201': { description: 'Invocation and trigger created' }, '200': { description: 'Exact deterministic replay' }, '400': { description: 'Invalid review request' }, '403': { description: 'Target access denied' }, '409': { description: 'client_request_id conflict' } },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/docs/{docId}/move': {
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Move a document to another visible writable channel',
          description: 'Atomically preserves the document ID, body/storage link, versions, comments, reactions, and history while changing its canonical scope/channel placement. Requires doc.read and doc.write/channel.write on the source plus channel.read and doc.write/channel.write on the destination. Emits source and destination outbox events.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['destination_channel_id'], properties: { destination_channel_id: { type: 'string', format: 'uuid' }, destination_scope_id: { type: 'string', format: 'uuid' }, row_version: { type: 'integer', minimum: 1 } } } } } },
          responses: {
            '200': { description: 'Canonical moved document and movement evidence', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid or inconsistent destination', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Source or destination permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Document or destination channel not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Same destination or stale row version', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}/state': {
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Update task state',
          description: 'Implemented PH2-2 runtime task state transition with task.update authorization, no task edit lease requirement, and stale row_version values ignored for local-first task saves.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '200': { description: 'Task state updated', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Task not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Task write conflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}/comments': {
        get: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'List task comments',
          description: 'Lists readable task comments in stable creation order, preserving workspace/scope/channel/task/thread linkage, metadata.mentions, row_version, stable comment ID, and resolved creator actor npub.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Task comments', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Task not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Add a task comment',
          description: 'Creates a task comment transactionally. Canonical agent mentions may be supplied as top-level mentions or metadata.mentions and are stored with actor_id and npub after task.read validation. The event includes the serialized comment, mentions, linkage, entity version, logical author, signer provenance, stable event ID, and cursor.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '201': { description: 'Task comment created', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Task not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}/assignments': {
        post: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Assign a task',
          description: 'Idempotently assigns one workspace actor. A newly created assignment event includes assignee actor_id/npub, assignment row version, and an explicit absent-to-present transition; an unchanged assignment emits no event.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '201': { description: 'Task assignment recorded', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Task not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/flightdeck-pg/workspaces/{workspaceId}/tasks/{taskId}/assignments/{actorId}': {
        delete: {
          tags: ['Flight Deck PG'],
          security: [{ nip98: [] }],
          summary: 'Unassign a task',
          description: 'Unassigns one workspace actor and emits present-to-absent transition evidence with assignee identity and assignment row version.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'actorId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Task assignment removed', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid NIP-98 auth', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Assignment not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/billing/workspaces': {
        get: {
          tags: ['Billing'],
          summary: 'List billing summaries for workspaces the authenticated user can manage',
          responses: {
            '200': {
              description: 'Manageable workspace billing summaries',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/BillingWorkspacesResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/billing/status': {
        get: {
          tags: ['Billing'],
          summary: 'Get lightweight workspace billing status',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Billing status', content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingStatus' } } } },
            '403': { description: 'Not authorized to manage this workspace', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/billing': {
        get: {
          tags: ['Billing'],
          summary: 'Get detailed workspace billing view',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Billing details', content: { 'application/json': { schema: { allOf: [{ $ref: '#/components/schemas/BillingStatus' }] } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/billing/transactions': {
        get: {
          tags: ['Billing'],
          summary: 'List workspace credit ledger transactions',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500 } },
          ],
          responses: {
            '200': {
              description: 'Credit ledger',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      workspace_owner_npub: { type: 'string' },
                      transactions: { type: 'array', items: { $ref: '#/components/schemas/WorkspaceCreditTransaction' } },
                    },
                    required: ['workspace_owner_npub', 'transactions'],
                  },
                },
              },
            },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/billing/purchase': {
        post: {
          tags: ['Billing'],
          summary: 'Create a Mginx-backed credit purchase for a workspace',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BillingPurchaseRequest' },
              },
            },
          },
          responses: {
            '201': { description: 'Purchase order created', content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingOrderResponse' } } } },
            '400': { description: 'Bad quantity', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/billing/orders/{orderId}/status': {
        get: {
          tags: ['Billing'],
          summary: 'Refresh a credit order payment status and credit paid orders idempotently',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'orderId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Order status', content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingOrderResponse' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Order not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/usage': {
        get: {
          tags: ['Billing'],
          summary: 'Measure current workspace billable usage',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Current usage', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkspaceUsage' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/records/metadata': {
        get: {
          tags: ['Billing'],
          summary: 'Inspect encrypted record metadata for a manageable workspace',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
            { name: 'record_family_hash', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Record metadata', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/records/families': {
        get: {
          tags: ['Billing'],
          summary: 'Inspect record family hashes and app namespaces for a manageable workspace',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Record family metadata',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      workspace_owner_npub: { type: 'string' },
                      families: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            record_family_hash: { type: 'string' },
                            app_namespace: { type: ['string', 'null'] },
                            collection_space: { type: 'string' },
                            latest_record_count: { type: 'integer' },
                            total_versions: { type: 'integer' },
                            owner_ciphertext_bytes: { type: 'integer' },
                            group_payload_bytes: { type: 'integer' },
                            total_bytes: { type: 'integer' },
                            latest_updated_at: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                    required: ['workspace_owner_npub', 'families'],
                  },
                },
              },
            },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/storage/metadata': {
        get: {
          tags: ['Billing'],
          summary: 'Inspect storage object metadata for a manageable workspace',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
            { name: 'public', in: 'query', required: false, schema: { type: 'boolean' } },
            { name: 'completed', in: 'query', required: false, schema: { type: 'boolean' } },
          ],
          responses: {
            '200': { description: 'Storage metadata', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/apps': {
        get: {
          tags: ['Billing'],
          summary: 'List persisted app namespaces for a workspace',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Workspace apps',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      workspace_owner_npub: { type: 'string' },
                      apps: { type: 'array', items: { $ref: '#/components/schemas/WorkspaceApp' } },
                    },
                    required: ['workspace_owner_npub', 'apps'],
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['Billing'],
          summary: 'Create or rename a persisted app namespace for a workspace',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateWorkspaceAppRequest' } } },
          },
          responses: {
            '201': { description: 'Workspace app created', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/descriptor': {
        get: {
          tags: ['Billing'],
          summary: 'Discover a workspace app namespace descriptor',
          description: 'Returns a credential-free Flight Deck PG workspace locator for an app namespace. Tower verifies workspace membership, reports installed/enabled state, and exposes app/schema identity plus capability flags without encrypted schema payloads or raw database credentials.',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Workspace app namespace descriptor', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkspaceAppNamespaceDescriptorResponse' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/app-schemas': {
        get: {
          tags: ['Billing'],
          summary: 'Fetch encrypted app schema manifests visible to the current workspace member',
          description: 'Returns the latest visible encrypted schema manifest per app namespace by default. Tower indexes app npubs and schema family/version metadata, but schema contents stay opaque in owner_payload/group_payloads ciphertext.',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'app_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'latest', in: 'query', required: false, schema: { type: 'boolean', default: true } },
          ],
          responses: {
            '200': {
              description: 'Encrypted app schema manifests',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      workspace_owner_npub: { type: 'string' },
                      schemas: { type: 'array', items: { $ref: '#/components/schemas/WorkspaceAppSchemaManifest' } },
                    },
                    required: ['workspace_owner_npub', 'schemas'],
                  },
                },
              },
            },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/schemas': {
        get: {
          tags: ['Billing'],
          summary: 'Fetch encrypted schema manifests for one app namespace',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'latest', in: 'query', required: false, schema: { type: 'boolean', default: false } },
          ],
          responses: {
            '200': {
              description: 'Encrypted app schema manifests',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      workspace_owner_npub: { type: 'string' },
                      app_npub: { type: 'string' },
                      schemas: { type: 'array', items: { $ref: '#/components/schemas/WorkspaceAppSchemaManifest' } },
                    },
                    required: ['workspace_owner_npub', 'app_npub', 'schemas'],
                  },
                },
              },
            },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Billing'],
          summary: 'Publish an encrypted schema manifest for an app namespace',
          description: 'Workspace managers publish opaque schema ciphertext plus clear family/version metadata. Clients should include group_payloads for every workspace group that should be able to decrypt the schema bundle.',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PublishWorkspaceAppSchemaRequest' } } },
          },
          responses: {
            '201': {
              description: 'Encrypted schema manifest published',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      workspace_owner_npub: { type: 'string' },
                      app_npub: { type: 'string' },
                      schema: { $ref: '#/components/schemas/WorkspaceAppSchemaManifest' },
                    },
                    required: ['workspace_owner_npub', 'app_npub', 'schema'],
                  },
                },
              },
            },
            '400': { description: 'Invalid schema manifest', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/connection-token': {
        get: {
          tags: ['Billing'],
          summary: 'Generate connection details for a persisted app namespace',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'relay', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Connection details', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkspaceAppConnectionResponse' } } } },
            '402': { description: 'Insufficient credits', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'App namespace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Billing'],
          summary: 'Regenerate connection details for a persisted app namespace',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Connection details', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkspaceAppConnectionResponse' } } } },
            '402': { description: 'Insufficient credits', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/descriptor': {
        get: {
          tags: ['Workspace App DB'],
          summary: 'Get the Tower-managed WApp DB namespace descriptor',
          description: 'Returns the allocated schema name and supported WApp DB v1 capabilities. Requires app, Tower admin, or Tower service NIP-98 auth.',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'WApp DB descriptor', content: { 'application/json': { schema: { $ref: '#/components/schemas/WappDbDescriptor' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'App or namespace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/provision': {
        post: {
          tags: ['Workspace App DB'],
          summary: 'Provision the Tower-managed WApp DB namespace',
          description: 'Creates the persisted namespace mapping and app schema. Does not run WApp migrations.',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: false,
            content: { 'application/json': { schema: { type: 'object', properties: { app_slug: { type: 'string' } } } } },
          },
          responses: {
            '201': { description: 'WApp DB descriptor', content: { 'application/json': { schema: { $ref: '#/components/schemas/WappDbDescriptor' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'App not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/migrations': {
        get: {
          tags: ['Workspace App DB'],
          summary: 'List applied WApp DB migrations',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Applied migrations', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Namespace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Workspace App DB'],
          summary: 'Run app-signed constrained WApp DB migrations',
          description: 'Accepts ordered DDL migrations, validates the SQL allowlist, locks the namespace, executes inside the allocated schema, and records version/checksum history.',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { migrations: { type: 'array', items: { $ref: '#/components/schemas/WappDbMigration' } } },
                  required: ['migrations'],
                },
              },
            },
          },
          responses: {
            '200': { description: 'Applied migration records', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid migration input', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'App signer required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Migration checksum conflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/tables/{table}/rows': {
        get: {
          tags: ['Workspace App DB'],
          summary: 'List rows from a WApp table',
          description: 'App-signed constrained read against a safe table identifier in the allocated app schema.',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
          ],
          responses: {
            '200': { description: 'Rows', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'App signer required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Workspace App DB'],
          summary: 'Create a row in a WApp table',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, data: { type: 'object', additionalProperties: true } }, required: ['data'] } } },
          },
          responses: {
            '201': { description: 'Created row', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'App signer required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Row id conflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/tables/{table}/rows/{rowId}': {
        get: {
          tags: ['Workspace App DB'],
          summary: 'Fetch one WApp table row by id',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'rowId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Row', content: { 'application/json': { schema: { type: 'object' } } } },
            '404': { description: 'Row not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        patch: {
          tags: ['Workspace App DB'],
          summary: 'Patch one WApp table row by id',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'rowId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { set: { type: 'object', additionalProperties: true } }, required: ['set'] } } },
          },
          responses: {
            '200': { description: 'Updated row', content: { 'application/json': { schema: { type: 'object' } } } },
            '404': { description: 'Row not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        delete: {
          tags: ['Workspace App DB'],
          summary: 'Delete one WApp table row by id',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'rowId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Deleted row', content: { 'application/json': { schema: { type: 'object' } } } },
            '404': { description: 'Row not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/tables/{table}/query': {
        post: {
          tags: ['Workspace App DB'],
          summary: 'Run a constrained structured query against one WApp table',
          description: 'Supports safe select fields, single-table where operators, ordering, limit, and offset. Does not accept arbitrary SQL.',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: false,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WappDbQueryRequest' } } },
          },
          responses: {
            '200': { description: 'Rows', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid query shape', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'App signer required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/{collection}/rows': {
        get: {
          tags: ['Workspace App DB'],
          summary: 'List visible JSON rows for an app collection',
          description: 'HTTPS-mediated generic app database rows. Tower enforces registered app namespace, workspace membership, and row visibility before returning rows.',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'collection', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
            { name: 'owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'visibility', in: 'query', required: false, schema: { type: 'string', enum: ['private', 'group', 'workspace'] } },
            { name: 'group_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': {
              description: 'Visible app rows',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      workspace_owner_npub: { type: 'string' },
                      app_npub: { type: 'string' },
                      collection: { type: 'string' },
                      rows: { type: 'array', items: { $ref: '#/components/schemas/WorkspaceAppDbRow' } },
                    },
                    required: ['workspace_owner_npub', 'app_npub', 'collection', 'rows'],
                  },
                },
              },
            },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'App namespace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Workspace App DB'],
          summary: 'Create a JSON row for an app collection',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'collection', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateWorkspaceAppDbRowRequest' } } },
          },
          responses: {
            '201': { description: 'App row created', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid row input', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'App namespace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Row id already exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/workspaces/{workspaceOwnerNpub}/apps/{appNpub}/db/{collection}/rows/{rowId}': {
        get: {
          tags: ['Workspace App DB'],
          summary: 'Fetch one visible app database row',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'collection', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'rowId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'App row', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Row or app namespace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        patch: {
          tags: ['Workspace App DB'],
          summary: 'Update one writable app database row',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'collection', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'rowId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateWorkspaceAppDbRowRequest' } } },
          },
          responses: {
            '200': { description: 'Updated app row', content: { 'application/json': { schema: { type: 'object' } } } },
            '400': { description: 'Invalid row input', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Row or app namespace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        delete: {
          tags: ['Workspace App DB'],
          summary: 'Delete one writable app database row',
          parameters: [
            { name: 'workspaceOwnerNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'appNpub', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'collection', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'rowId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Deleted app row', content: { 'application/json': { schema: { type: 'object' } } } },
            '403': { description: 'Not authorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Row or app namespace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/admin/tower': {
        get: {
          tags: ['Admin'],
          summary: 'Get the effective public Tower profile',
          responses: {
            '200': {
              description: 'Tower profile',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/TowerProfileResponse' },
                },
              },
            },
            '403': {
              description: 'admin npub required',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
        patch: {
          tags: ['Admin'],
          summary: 'Update the public Tower profile',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateTowerProfileRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Tower profile updated',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/TowerProfileResponse' },
                },
              },
            },
            '400': {
              description: 'tower_name or tower_description required',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'admin npub required',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/admin/workspaces/{workspaceId}/inspect': {
        get: {
          tags: ['Admin'],
          security: [{ nip98: [] }],
          summary: 'Inspect one workspace as Tower admin',
          description: 'Admin-only operational summary for a workspace, including usage, encrypted record metadata, storage metadata, app namespaces, and visible app schema summaries. It does not decrypt record or storage payloads.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
          ],
          responses: {
            '200': {
              description: 'Workspace inspection summary',
              content: {
                'application/json': {
                  schema: { type: 'object', additionalProperties: true },
                },
              },
            },
            '401': {
              description: 'NIP-98 auth required',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '403': {
              description: 'admin npub required',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '404': {
              description: 'workspace not found',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/v4/admin/workspaces/{workspaceId}': {
        delete: {
          tags: ['Admin'],
          security: [{ nip98: [] }],
          summary: 'Delete one workspace and its database rows as Tower admin',
          description: 'Admin-only destructive cleanup. Requires confirmation matching the workspace owner npub. Deletes workspace-scoped Postgres rows, encrypted record metadata, group rows, billing/app rows, optional Flight Deck PG rows, and optional storage metadata rows. It does not delete object-storage blobs.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    confirmation: { type: 'string', description: 'Must equal workspace_owner_npub.' },
                    delete_flightdeck_pg: { type: 'boolean', default: true },
                    delete_storage_metadata: { type: 'boolean', default: true },
                  },
                  required: ['confirmation'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Workspace database rows deleted',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
            '400': {
              description: 'Invalid confirmation or request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '401': {
              description: 'NIP-98 auth required',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '403': {
              description: 'admin npub required',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '404': {
              description: 'workspace not found',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/v4/admin/workspaces/delete-preview': {
        post: {
          tags: ['Admin'],
          security: [{ nip98: [] }],
          summary: 'Preview bulk workspace database cleanup',
          description: 'Admin-only preview for destructive workspace cleanup. Accepts explicit workspace IDs only and returns per-workspace row counts before deletion. It does not delete data.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workspace_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, maxItems: 100 },
                    delete_flightdeck_pg: { type: 'boolean', default: true },
                    delete_storage_metadata: { type: 'boolean', default: true },
                  },
                  required: ['workspace_ids'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Bulk workspace delete preview',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
            '400': {
              description: 'Invalid request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '401': {
              description: 'NIP-98 auth required',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '403': {
              description: 'admin npub required',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '404': {
              description: 'workspace not found',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/v4/admin/workspaces/bulk-delete': {
        post: {
          tags: ['Admin'],
          security: [{ nip98: [] }],
          summary: 'Delete multiple workspaces and their database rows as Tower admin',
          description: 'Admin-only destructive cleanup. Accepts explicit workspace IDs only and deletes the selected workspaces in one transaction. Requires confirmation of the phrase DELETE N WORKSPACES. It does not delete object-storage blobs.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workspace_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, maxItems: 100 },
                    confirmation: { type: 'string', description: 'Must equal DELETE N WORKSPACES for the selected count.' },
                    delete_flightdeck_pg: { type: 'boolean', default: true },
                    delete_storage_metadata: { type: 'boolean', default: true },
                  },
                  required: ['workspace_ids', 'confirmation'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Bulk workspace database rows deleted',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
            '400': {
              description: 'Invalid confirmation or request',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '401': {
              description: 'NIP-98 auth required',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '403': {
              description: 'admin npub required',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
            '404': {
              description: 'workspace not found',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            },
          },
        },
      },
      '/api/v4/admin/flightdeck-pg/workspaces': {
        post: {
          tags: ['Admin'],
          summary: 'Create or update a Postgres-backed Flight Deck workspace setup',
          description: 'Admin-only human setup path that bootstraps default Flight Deck PG groups and returns a credential-free workspace descriptor. Optional smoke scope/channel names can be supplied for development fixtures.',
          security: [{ nip98: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/FlightDeckPgAdminWorkspaceSetupRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Flight Deck PG workspace setup result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/FlightDeckPgAdminWorkspaceSetupResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid setup input',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '401': {
              description: 'NIP-98 auth required',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'admin npub required',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/admin/billing/overview': {
        get: {
          tags: ['Admin'],
          summary: 'Get operational billing overview for at-risk workspaces, unpaid orders, and recent audits',
          responses: {
            '200': {
              description: 'Operational billing overview',
              content: {
                'application/json': {
                  schema: { type: 'object' },
                },
              },
            },
            '403': {
              description: 'admin npub required',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/groups/keys': {
        get: {
          tags: ['Groups'],
          summary: 'Bootstrap wrapped group keys for the authenticated member',
          parameters: [
            {
              name: 'member_npub',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Wrapped keys list',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WrappedKeysResponse' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'member_npub/auth mismatch',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/groups': {
        get: {
          tags: ['Groups'],
          summary: 'List groups visible to the authenticated user (owned + member)',
          parameters: [
            {
              name: 'npub',
              in: 'query',
              required: true,
              schema: { type: 'string' },
              description: 'npub of the authenticated user',
            },
          ],
          responses: {
            '200': {
              description: 'Groups list',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ListGroupsResponse' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'npub/auth mismatch',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
        post: {
          tags: ['Groups'],
          summary: 'Create a group',
          description: 'Create a normal shared group. Workspace owners, creators, and workspace admin-group members may create workspace-owned groups. Ordinary authenticated workspace members may also create normal shared groups in that workspace when the creator has a wrapped key in member_keys and, for member-created groups, every submitted member key belongs to an existing workspace member. Public callers cannot create protected system group kinds.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateGroupRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Group created',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/GroupResponse' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'owner_npub/auth mismatch',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/groups/{groupId}/members': {
        post: {
          tags: ['Groups'],
          summary: 'Add a member to an existing group',
          parameters: [
            {
              name: 'groupId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AddGroupMemberRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Member added',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AddGroupMemberResponse' },
                },
              },
            },
            '403': {
              description: 'Only owner may add members',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Group not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/groups/{groupId}/rotate': {
        post: {
          tags: ['Groups'],
          summary: 'Rotate a group to a fresh epoch and keypair',
          description:
            'Used primarily after member removal. The caller generates a fresh group keypair client-side, wraps the new nsec for remaining members, and the backend promotes the new epoch as current.',
          parameters: [
            {
              name: 'groupId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RotateGroupRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Group rotated to a new epoch',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/GroupResponse' },
                },
              },
            },
            '403': {
              description: 'Only owner may rotate groups',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Group not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/groups/{groupId}/members/{memberNpub}': {
        delete: {
          tags: ['Groups'],
          summary: 'Remove a member from an existing group',
          parameters: [
            {
              name: 'groupId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'memberNpub',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Member removed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DeleteGroupMemberResponse' },
                },
              },
            },
            '403': {
              description: 'Only owner may remove members',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Group or member not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/groups/{groupId}': {
        patch: {
          tags: ['Groups'],
          summary: 'Rename a group',
          parameters: [
            {
              name: 'groupId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateGroupRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Group renamed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/GroupResponse' },
                },
              },
            },
            '403': {
              description: 'Only owner may rename groups',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Group not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
        delete: {
          tags: ['Groups'],
          summary: 'Delete a group',
          parameters: [
            {
              name: 'groupId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'Group deleted',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DeleteGroupResponse' },
                },
              },
            },
            '403': {
              description: 'Only owner may delete group',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Group not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/records/{record_id}/checkout/acquire': {
        post: {
          tags: ['Records'],
          summary: 'Acquire a checkout for a checkout_required record',
          description: 'Phase 1 checkout acquire endpoint for `checkout_required` record families. Defaults include `<appNpub>:document` and `<appNpub>:directory`; `optimistic_write` families do not require checkout metadata. These endpoints require canonical delegated-key fields (`workspace_service_npub`, `user_npub`, `workspace_user_key_npub`) and then enforce checkout holder ownership + write authorization at write time.',
          parameters: [
            {
              name: 'record_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AcquireCheckoutRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Checkout granted or returned idempotently to the same holder',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RecordCheckoutResponse' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'Delegated key or identity mismatch',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '409': {
              description: 'Checkout held by another actor or mismatched checkout state',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/records/{record_id}/checkout/release': {
        post: {
          tags: ['Records'],
          summary: 'Release a checkout for a checkout_required record',
          description: 'Explicit checkout release for canonical delegated clients. These endpoints reject alias-only `owner_npub` or `ws_key_npub` requests and require `workspace_service_npub`, `user_npub`, and `workspace_user_key_npub`.',
          parameters: [
            {
              name: 'record_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ReleaseCheckoutRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Checkout released',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RecordCheckoutResponse' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'Checkout held by another actor',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '409': {
              description: 'Checkout does not match the record or is already inactive',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/records/{record_id}/checkout/renew': {
        post: {
          tags: ['Records'],
          summary: 'Renew a checkout lease for a checkout_required record',
          description: 'Checkout lease renewal for canonical delegated clients. These endpoints reject alias-only `owner_npub` or `ws_key_npub` requests and require `workspace_service_npub`, `user_npub`, and `workspace_user_key_npub`.',
          parameters: [
            {
              name: 'record_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RenewCheckoutRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Checkout renewed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RecordCheckoutResponse' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'Checkout held by another actor',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '409': {
              description: 'Checkout does not match the record or is already inactive',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/records/heartbeat': {
        post: {
          tags: ['Records'],
          summary: 'Check which record families have updates since client cursors',
          description: 'Accepts client-side cursors (latest_updated_at per family) and returns which families are stale. Designed for efficient 1/sec polling instead of per-family fetches.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    owner_npub: { type: 'string', description: 'Compatibility alias for workspace_service_npub' },
                    workspace_service_npub: { type: 'string', description: 'Canonical workspace service identity' },
                    ws_key_npub: { type: 'string', description: 'Compatibility alias for workspace_user_key_npub' },
                    workspace_user_key_npub: { type: 'string', description: 'Canonical delegated workspace user key. If present, Tower verifies signer_npub equals this key and the key is active for user_npub and workspace_service_npub.' },
                    viewer_npub: { type: 'string', description: 'Compatibility field. Tower evaluates viewerNpub as the resolved user_npub.' },
                    family_cursors: {
                      type: 'object',
                      additionalProperties: { type: 'string', format: 'date-time', nullable: true },
                      description: 'Map of record_family_hash to latest_updated_at ISO timestamp the client has seen (or null)',
                    },
                  },
                  anyOf: [
                    { required: ['owner_npub'] },
                    { required: ['workspace_service_npub'] },
                  ],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Heartbeat result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HeartbeatResponse' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'viewer_npub/auth mismatch',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/records/{record_id}/history': {
        get: {
          tags: ['Records'],
          summary: 'Fetch all visible versions of a record by record_id',
          parameters: [
            {
              name: 'record_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'owner_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Compatibility alias for workspace_service_npub',
            },
            {
              name: 'workspace_service_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Canonical workspace service identity',
            },
            {
              name: 'viewer_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Compatibility field. Tower evaluates viewerNpub as the resolved user_npub.',
            },
            {
              name: 'ws_key_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Compatibility alias for workspace_user_key_npub',
            },
            {
              name: 'workspace_user_key_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Canonical delegated workspace user key. If present, Tower verifies signer_npub equals this key and the key is active for user_npub and workspace_service_npub.',
            },
          ],
          responses: {
            '200': {
              description: 'Record history fetched',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RecordHistoryResponse' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'viewer_npub/auth mismatch',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/records/summary': {
        get: {
          tags: ['Records'],
          summary: 'Fetch per-family freshness summary for visible records',
          parameters: [
            {
              name: 'owner_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Compatibility alias for workspace_service_npub',
            },
            {
              name: 'workspace_service_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Canonical workspace service identity',
            },
            {
              name: 'viewer_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Compatibility field. Tower evaluates viewerNpub as the resolved user_npub.',
            },
            {
              name: 'ws_key_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Compatibility alias for workspace_user_key_npub',
            },
            {
              name: 'workspace_user_key_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Canonical delegated workspace user key. If present, Tower verifies signer_npub equals this key and the key is active for user_npub and workspace_service_npub.',
            },
            {
              name: 'record_family_hash',
              in: 'query',
              required: false,
              schema: { type: 'string' },
            },
            {
              name: 'since',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
            },
          ],
          responses: {
            '200': {
              description: 'Records summary fetched',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RecordsSummaryResponse' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'viewer_npub/auth mismatch',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/graph/search': {
        get: {
          tags: ['Graph'],
          summary: 'Search visible graph context for compact ranked node, edge, and memory matches',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search text matched against native graph IDs, labels, relationship types, compact properties, and memory summaries.' },
            { name: 'workspace_owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'visibility', in: 'query', required: false, schema: { type: 'string', enum: ['personal', 'agent', 'group'] } },
            { name: 'owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'actor_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'agent_npub', in: 'query', required: false, schema: { type: 'string', description: 'Compatibility alias for actor_npub.' } },
            { name: 'source_app_npub', in: 'query', required: false, schema: { type: 'string' }, description: 'Registered workspace app npub filter. Requires workspace_owner_npub.' },
            { name: 'group_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'source', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'label', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'relationship_type', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          ],
          responses: {
            '200': {
              description: 'Ranked visible graph context',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/GraphSearchResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid graph search request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'Authenticated npub is not allowlisted for graph access',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '501': {
              description: 'Graph feature disabled',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/graph/memories': {
        post: {
          tags: ['Graph'],
          summary: 'Create an encrypted graph memory in a personal, agent, or group scope',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateGraphMemoryRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Graph memory created',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/GraphMemoryResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid graph memory request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'Authenticated npub is not allowed to use the requested graph scope',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '501': {
              description: 'Graph feature disabled',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
        get: {
          tags: ['Graph'],
          summary: 'List graph memories visible to the authenticated npub',
          parameters: [
            { name: 'workspace_owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'visibility', in: 'query', required: false, schema: { type: 'string', enum: ['personal', 'agent', 'group', 'workspace'] } },
            { name: 'memory_type', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'actor_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'agent_npub', in: 'query', required: false, schema: { type: 'string', description: 'Compatibility alias for actor_npub.' } },
            { name: 'source_app_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'group_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
          ],
          responses: {
            '200': {
              description: 'Visible graph memories',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/GraphMemoryListResponse' },
                },
              },
            },
            '403': {
              description: 'Authenticated npub is not allowlisted for graph memory',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '501': {
              description: 'Graph feature disabled',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/graph/memories/{memoryId}': {
        get: {
          tags: ['Graph'],
          summary: 'Get one visible graph memory by ID',
          parameters: [
            { name: 'memoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'workspace_owner_npub', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Visible graph memory',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/GraphMemoryResponse' },
                },
              },
            },
            '404': {
              description: 'Memory does not exist or is not visible to this npub',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '501': {
              description: 'Graph feature disabled',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/graph/import-runs': {
        post: {
          tags: ['Graph'],
          summary: 'Idempotently import native property graph nodes, edges, and schema metadata',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/NativeGraphImportRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Graph import completed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/NativeGraphImportResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid graph import request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'Authenticated npub is not allowed to write the requested graph scope',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '501': {
              description: 'Graph feature disabled',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/graph/repository-deltas': {
        post: {
          tags: ['Graph'],
          summary: 'Transactionally reconcile one repository subgraph and advance its checkpoint',
          description: 'Incremental requests require a matching base_sha. Full rebuilds reconcile only IDs under the declared corpus/repository prefix. Cross-repository edge endpoints are rejected.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/GraphRepositoryDeltaRequest' } } } },
          responses: {
            '200': { description: 'Delta committed or idempotently replayed', content: { 'application/json': { schema: { $ref: '#/components/schemas/GraphRepositoryDeltaResponse' } } } },
            '400': { description: 'Invalid mutation or repository-prefix escape', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Authenticated npub/importer is not allowed to write the requested graph scope', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Stale base SHA or a legacy cross-repository edge blocks safe deletion', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '501': { description: 'Graph feature disabled', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/graph/repository-checkpoints': {
        get: {
          tags: ['Graph'],
          summary: 'List visible repository graph checkpoints',
          description: 'Reads RLS-visible checkpoints for one required source. Supplying corpus_id and repository_id performs an exact lookup within the requested graph scope.',
          parameters: [
            { name: 'source', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'workspace_owner_npub', in: 'query', schema: { type: 'string' } },
            { name: 'visibility', in: 'query', schema: { type: 'string', enum: ['personal', 'agent', 'group'] } },
            { name: 'owner_npub', in: 'query', schema: { type: 'string' } },
            { name: 'actor_npub', in: 'query', schema: { type: 'string' } },
            { name: 'agent_npub', in: 'query', schema: { type: 'string' }, description: 'Compatibility alias for actor_npub.' },
            { name: 'source_app_npub', in: 'query', schema: { type: 'string' } },
            { name: 'group_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'corpus_id', in: 'query', schema: { type: 'string', pattern: '^[A-Za-z0-9._/-]+$' } },
            { name: 'repository_id', in: 'query', schema: { type: 'string', pattern: '^[A-Za-z0-9._/-]+$' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
          ],
          responses: {
            '200': {
              description: 'Visible repository checkpoints',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  checkpoints: { type: 'array', items: { $ref: '#/components/schemas/GraphRepositoryCheckpoint' } },
                  count: { type: 'integer' }, limit: { type: 'integer' },
                },
                required: ['checkpoints', 'count', 'limit'],
              } } },
            },
            '400': { description: 'Missing source or malformed scope/repository filter', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Authenticated npub or requested workspace/app/actor scope is not allowed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '501': { description: 'Graph feature disabled', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/graph/nodes/bulk-upsert': {
        post: {
          tags: ['Graph'],
          summary: 'Bulk upsert native graph nodes by source and external ID',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/NativeGraphBulkNodesRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Nodes upserted',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/NativeGraphBulkNodesResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid node upsert request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'Authenticated npub is not allowed to write the requested graph scope',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '501': {
              description: 'Graph feature disabled',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/graph/edges/bulk-upsert': {
        post: {
          tags: ['Graph'],
          summary: 'Bulk upsert native graph edges by source and external ID',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/NativeGraphBulkEdgesRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Edges upserted',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/NativeGraphBulkEdgesResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid edge upsert request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'Authenticated npub is not allowed to write the requested graph scope',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '501': {
              description: 'Graph feature disabled',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/graph/nodes': {
        get: {
          tags: ['Graph'],
          summary: 'List native graph nodes visible to the authenticated npub',
          parameters: [
            { name: 'workspace_owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'visibility', in: 'query', required: false, schema: { type: 'string', enum: ['personal', 'agent', 'group'] } },
            { name: 'owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'actor_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'agent_npub', in: 'query', required: false, schema: { type: 'string', description: 'Compatibility alias for actor_npub.' } },
            { name: 'source_app_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'group_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'source', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'run_id', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'label', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
          ],
          responses: {
            '200': {
              description: 'Visible native graph nodes',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/NativeGraphNodesResponse' },
                },
              },
            },
            '403': {
              description: 'Authenticated npub is not allowlisted for graph access',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '501': {
              description: 'Graph feature disabled',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/graph/edges': {
        get: {
          tags: ['Graph'],
          summary: 'List native graph edges visible to the authenticated npub',
          parameters: [
            { name: 'workspace_owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'visibility', in: 'query', required: false, schema: { type: 'string', enum: ['personal', 'agent', 'group'] } },
            { name: 'owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'actor_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'agent_npub', in: 'query', required: false, schema: { type: 'string', description: 'Compatibility alias for actor_npub.' } },
            { name: 'source_app_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'group_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'source', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'run_id', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'relationship_type', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500 } },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0 } },
          ],
          responses: {
            '200': {
              description: 'Visible native graph edges',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/NativeGraphEdgesResponse' },
                },
              },
            },
            '403': {
              description: 'Authenticated npub is not allowlisted for graph access',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '501': {
              description: 'Graph feature disabled',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/graph/neighborhood': {
        get: {
          tags: ['Graph'],
          summary: 'Fetch one native graph node and its adjacent edges and nodes',
          parameters: [
            { name: 'node_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'source', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'external_id', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'direction', in: 'query', required: false, schema: { type: 'string', enum: ['in', 'out', 'both'], default: 'both' } },
            { name: 'workspace_owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'visibility', in: 'query', required: false, schema: { type: 'string', enum: ['personal', 'agent', 'group'] } },
            { name: 'owner_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'actor_npub', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'agent_npub', in: 'query', required: false, schema: { type: 'string', description: 'Compatibility alias for actor_npub.' } },
            { name: 'group_id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500 } },
          ],
          responses: {
            '200': {
              description: 'Visible native graph neighborhood',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/NativeGraphNeighborhoodResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid neighborhood request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Center graph node not found or not visible',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'Authenticated npub is not allowlisted for graph access',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '501': {
              description: 'Graph feature disabled',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/records': {
        get: {
          tags: ['Records'],
          summary: 'Fetch latest visible record versions for a family hash',
          parameters: [
            {
              name: 'owner_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Compatibility alias for workspace_service_npub',
            },
            {
              name: 'workspace_service_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Canonical workspace service identity',
            },
            {
              name: 'viewer_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Compatibility field. Tower evaluates viewerNpub as the resolved user_npub.',
            },
            {
              name: 'ws_key_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Compatibility alias for workspace_user_key_npub',
            },
            {
              name: 'workspace_user_key_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Canonical delegated workspace user key. If present, Tower verifies signer_npub equals this key and the key is active for user_npub and workspace_service_npub.',
            },
            {
              name: 'record_family_hash',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'since',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 1000 },
              description: 'Page size for family fetches. Defaults to 200.',
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0 },
              description: 'Zero-based offset into the oldest-first visible record list.',
            },
          ],
          responses: {
            '200': {
              description: 'Records fetched',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/FetchRecordsResponse' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'viewer_npub/auth mismatch',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/storage/prepare': {
        post: {
          tags: ['Storage'],
          summary: 'Prepare an opaque storage object upload',
          security: [{ nip98: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PrepareStorageRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Prepared upload target',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PrepareStorageResponse' },
                },
              },
            },
            '400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '402': { description: 'Workspace is in read-only grace because credits are depleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/storage/{objectId}': {
        get: {
          tags: ['Storage'],
          summary: 'Get storage object metadata and stable content URL',
          description: 'Private reads use the generic owner/uploader/group ACL first, then a narrow message-attachment fallback that requires an active Tower-authored message link and current channel.read permission. Unassociated private objects remain owner-only; public access remains explicit.',
          security: [{ nip98: [] }],
          parameters: [
            { name: 'objectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': {
              description: 'Storage object metadata',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/StorageObjectResponse' },
                },
              },
            },
          },
        },
        put: {
          tags: ['Storage'],
          summary: 'Upload opaque bytes for a prepared storage object',
          security: [{ nip98: [] }],
          parameters: [
            { name: 'objectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    base64_data: { type: 'string', description: 'Base64 encoded opaque bytes' },
                  },
                  required: ['base64_data'],
                },
              },
            },
          },
          responses: {
            '200': { description: 'Upload stored' },
            '404': { description: 'Object not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/storage/{objectId}/complete': {
        post: {
          tags: ['Storage'],
          summary: 'Mark a storage object upload as complete',
          security: [{ nip98: [] }],
          parameters: [
            { name: 'objectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CompleteStorageRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Storage object completed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CompleteStorageResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/storage/{objectId}/download-url': {
        get: {
          tags: ['Storage'],
          summary: 'Get a time-limited download URL for a storage object',
          description: 'Uses the same owner/group/public or active message-link authorization as metadata and content reads.',
          security: [{ nip98: [] }],
          parameters: [
            { name: 'objectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': {
              description: 'Download URL',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DownloadUrlResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/storage/{objectId}/content': {
        get: {
          tags: ['Storage'],
          summary: 'Download opaque object bytes',
          description: 'Private bytes are readable through generic owner/uploader/group ACLs or through an active message link whose workspace/channel is currently readable by the authenticated actor. Association does not make the object public.',
          security: [{ nip98: [] }],
          parameters: [
            { name: 'objectId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': {
              description: 'Opaque bytes',
              content: {
                'application/octet-stream': {
                  schema: { type: 'string', format: 'binary' },
                },
              },
            },
          },
        },
      },
      '/api/v4/records/sync': {
        post: {
          tags: ['Records'],
          summary: 'Append new record versions',
          description:
            'Creates new record versions only when `previous_version` matches the latest stored version. Canonical writes should use `workspace_service_npub`, `workspace_user_key_npub`, sync record `signature_npub`, and durable `write_group_id`; legacy aliases remain accepted for compatibility unless strict groupId mode is enabled. Families resolved to `checkout_required` must include `checkout.checkout_id`; families resolved to `optimistic_write` use the existing non-checkout flow. Existing record family hashes are immutable, and accepted checkout_required writes atomically release that checkout by default.',
          parameters: [
            {
              name: 'x-superbased-strict-group-id-writes',
              in: 'header',
              required: false,
              schema: { type: 'string' },
              description: 'Opt-in strict groupId mode. Truthy values reject records containing legacy write_group_npub write references.',
            },
            {
              name: 'x-superbased-identity-strict',
              in: 'header',
              required: false,
              schema: { type: 'string' },
              description: 'Comma-separated strict identity modes. Include group_id, write_group_id, or strict_group_id_writes to reject legacy write_group_npub write references.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SyncRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Sync result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SyncResponse' },
                },
              },
            },
            '400': {
              description: 'Bad request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'owner_npub/auth mismatch or write-group/edit-policy failure',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '402': {
              description: 'Workspace is in read-only grace because credits are depleted',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '409': {
              description: 'Checkout conflict or prior-version mismatch',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/user/devices': {
        post: {
          tags: ['User'],
          summary: 'Register a device key',
          description: 'Register a per-device Nostr key for a workspace. Auth must be signed by the real user or another approved registration signer, not by the unregistered device key.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeviceRegisterRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Device registered',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DeviceResponse' },
                },
              },
            },
            '400': { description: 'Missing required fields', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'User does not have access to the workspace', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Device key already registered to a different user', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        get: {
          tags: ['User'],
          summary: 'List registered devices',
          responses: {
            '200': {
              description: 'Registered devices for authenticated user',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DevicesResponse' },
                },
              },
            },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/user/devices/{deviceNpub}/seen': {
        post: {
          tags: ['User'],
          summary: 'Touch device last-seen timestamp',
          parameters: [
            { name: 'deviceNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workspace_owner_npub: { type: 'string' },
                    workspace_service_npub: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Device touched', content: { 'application/json': { schema: { $ref: '#/components/schemas/DeviceResponse' } } } },
            '400': { description: 'Missing workspace identity', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Device not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/user/devices/{deviceNpub}/revoke': {
        post: {
          tags: ['User'],
          summary: 'Revoke a device key',
          description: 'Revokes the device by deactivating its workspace-user-key grant. POST requests must include a NIP-98 payload hash, even when the JSON body is empty.',
          parameters: [
            { name: 'deviceNpub', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Device revoked', content: { 'application/json': { schema: { $ref: '#/components/schemas/DeviceResponse' } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Device not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/user/workspace-keys': {
        post: {
          tags: ['User'],
          summary: 'Register a workspace session key',
          description: 'Register a ws_key_npub to act on behalf of the authenticated user in a workspace. Auth must be signed by the real user npub.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RegisterWorkspaceKeyRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Key registered',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WorkspaceKeyEntry' },
                },
              },
            },
            '400': {
              description: 'Missing required fields',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'User does not have access to the workspace',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '409': {
              description: 'ws_key_npub already registered to a different user',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
        get: {
          tags: ['User'],
          summary: 'List workspace session keys for the authenticated user',
          responses: {
            '200': {
              description: 'Workspace keys list',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WorkspaceKeysResponse' },
                },
              },
            },
            '401': {
              description: 'NIP-98 auth required',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/user/workspace-keys/rotate': {
        post: {
          tags: ['User'],
          summary: 'Rotate a workspace session key',
          description: 'Deactivate an old workspace key and register a new one. Auth must be signed by the real user npub.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RotateWorkspaceKeyRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Key rotated',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WorkspaceKeyEntry' },
                },
              },
            },
            '400': {
              description: 'Missing required fields',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Old key not found for this user and workspace',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '409': {
              description: 'New key already registered to a different user',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/user/workspace-key-mappings': {
        get: {
          tags: ['User'],
          summary: 'List active workspace user key mappings for a workspace',
          description: 'Public authenticated endpoint for clients that need to resolve active delegated workspace user keys to canonical real user identities for display and actor diagnostics. Accepts workspace_service_npub as canonical and workspace_owner_npub as a compatibility alias.',
          parameters: [
            {
              name: 'workspace_service_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Canonical workspace service identity',
            },
            {
              name: 'workspace_owner_npub',
              in: 'query',
              required: false,
              schema: { type: 'string' },
              description: 'Compatibility alias for workspace_service_npub',
            },
          ],
          responses: {
            '200': {
              description: 'Active workspace user key mappings',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WorkspaceKeyMappingsResponse' },
                },
              },
            },
            '400': {
              description: 'Missing workspace identity or mismatched aliases',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '401': {
              description: 'NIP-98 auth required',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/git/oidc/.well-known/openid-configuration': {
        get: { tags: ['Git Authority'], summary: 'Discover Tower OpenID Connect endpoints for Forgejo', responses: { '200': { description: 'OIDC provider metadata' }, '503': { description: 'OIDC provider is not configured' } } },
      },
      '/api/v4/git/oidc/authorize': {
        get: { tags: ['Git Authority'], summary: 'Authorize Forgejo through a Nostr browser signer', responses: { '200': { description: 'Nostr authorization page', content: { 'text/html': { schema: { type: 'string' } } } }, '400': { description: 'Invalid OAuth authorization request' } } },
      },
      '/api/v4/git/oidc/token': {
        post: { tags: ['Git Authority'], summary: 'Exchange a one-use authorization code for OIDC tokens', responses: { '200': { description: 'OIDC token response' }, '400': { description: 'Invalid or expired grant' }, '401': { description: 'Client authentication failed' } } },
      },
      '/api/v4/git/oidc/userinfo': {
        get: { tags: ['Git Authority'], summary: 'Return claims for a Tower-issued Forgejo access token', responses: { '200': { description: 'Stable Tower actor claims' }, '401': { description: 'Invalid or expired access token' } } },
      },
      '/api/v4/git/oidc/jwks': {
        get: { tags: ['Git Authority'], summary: 'Return Tower OIDC public signing keys', responses: { '200': { description: 'JSON Web Key Set' } } },
      },
      '/api/v4/git/workspaces/{workspaceId}/namespace': {
        put: {
          tags: ['Git Authority'], security: [{ nip98: [] }],
          summary: 'Claim or adjust a readable Git namespace before repository creation',
          description: 'Workspace owner/admin route. Namespaces are globally unique and become locked when the workspace has its first active repository.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ClaimGitWorkspaceNamespaceRequest' } } } },
          responses: {
            '200': { description: 'Namespace claimed', content: { 'application/json': { schema: { type: 'object', required: ['namespace'], properties: { namespace: { $ref: '#/components/schemas/GitWorkspaceNamespace' } } } } } },
            '400': { description: 'Invalid or reserved namespace', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Workspace owner/admin required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Namespace already claimed or locked', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/workspaces/{workspaceId}/actor-bootstrap': {
        get: {
          tags: ['Git'], summary: 'Read authenticated actor Forgejo bootstrap',
          description: 'Account and organization readiness are separate from repository grants. Uses only the authenticated workspace member identity. Provider work runs in isolated reconcilers.',
          security: [{ NostrAuth: [] }],
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Bootstrap state', content: { 'application/json': { schema: { type: 'object', properties: { bootstrap: { $ref: '#/components/schemas/GitActorBootstrap' } } } } } }, '404': { description: 'Workspace unavailable to actor' } },
        },
        post: {
          tags: ['Git'], summary: 'Request idempotent headless authenticated actor Forgejo bootstrap',
          description: 'Account and organization readiness are separate from repository grants. Uses only the authenticated workspace member identity. Provider work runs in isolated reconcilers.',
          security: [{ NostrAuth: [] }],
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '202': { description: 'Bootstrap state', content: { 'application/json': { schema: { type: 'object', properties: { bootstrap: { $ref: '#/components/schemas/GitActorBootstrap' } } } } } }, '404': { description: 'Workspace unavailable to actor' } },
        },
      },
      '/api/v4/git/internal/forgejo/repositories/pending': {
        get: { tags: ['Git'], summary: 'Isolated reconciler pending repository queue', responses: { '200': { description: 'Pending repository UUIDs' }, '401': { description: 'Internal service token required' } } },
      },
      '/api/v4/git/workspaces/{workspaceId}/actor-username': {
        get: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'Read the current actor’s Forgejo username projection',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Current desired and applied username', content: { 'application/json': { schema: { type: 'object', required: ['actor_username'], properties: { actor_username: { $ref: '#/components/schemas/GitActorUsername' } } } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Actor is not a workspace member', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        put: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'Choose the initial Forgejo username before first OIDC login',
          description: 'This sets the preferred username used for first OIDC registration. Once linked, Forgejo owns username changes through its native Settings page and Tower follows the immutable account binding.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateGitActorUsernameRequest' } } } },
          responses: {
            '202': { description: 'Username change accepted for reconciliation', content: { 'application/json': { schema: { type: 'object', required: ['actor_username'], properties: { actor_username: { $ref: '#/components/schemas/GitActorUsername' } } } } } },
            '400': { description: 'Invalid or reserved username', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Actor is not a workspace member', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Username is already claimed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/workspaces/{workspaceId}/repositories': {
        post: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'Register a private workspace Git repository',
          description: 'Workspace owner/admin bootstrap route. It creates protected service-managed main, staging, and deployed rules plus an explicit repository-admin grant for the creating logical actor.',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateGitRepositoryRequest' } } } },
          responses: {
            '201': { description: 'Repository registered', content: { 'application/json': { schema: { type: 'object', required: ['repository'], properties: { repository: { $ref: '#/components/schemas/GitRepository' } } } } } },
            '400': { description: 'Invalid repository input', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Repository creation denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Workspace or scope not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Repository slug conflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        get: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'List repositories visible through active actor/group Git grants',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Visible private repositories', content: { 'application/json': { schema: { type: 'object', required: ['repositories'], properties: { repositories: { type: 'array', items: { $ref: '#/components/schemas/GitRepository' } } } } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/workspaces/{workspaceId}/repositories/resolve': {
        get: {
          tags: ['Git Authority'], security: [{ nip98: [] }],
          summary: 'Resolve one canonical gateway path to a visible Tower repository',
          description: 'Credential-broker discovery seam. Accepts only /organization/repository.git and returns the stable repository UUID after current workspace membership and actor/group grants are checked. Unknown, foreign, malformed, and ungranted paths are non-disclosing.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'path', in: 'query', required: true, schema: { type: 'string', pattern: '^/[a-z0-9][a-z0-9-]{0,38}/[a-z0-9][a-z0-9._-]{0,62}\\.git$' } },
          ],
          responses: {
            '200': { description: 'Canonical path and visible repository', content: { 'application/json': { schema: { type: 'object', required: ['canonical_path', 'repository'], properties: { canonical_path: { type: 'string' }, repository: { $ref: '#/components/schemas/GitRepository' } } } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Repository path not found or not visible', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/workspaces/{workspaceId}/repositories/{repositoryId}': {
        get: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'Read a visible private repository',
          description: 'Unknown, foreign-workspace, and ungranted repositories return the same non-disclosing not-found response.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Repository', content: { 'application/json': { schema: { type: 'object', required: ['repository'], properties: { repository: { $ref: '#/components/schemas/GitRepository' } } } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Repository not found or not visible', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/workspaces/{workspaceId}/repositories/{repositoryId}/issues': {
        get: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'List Forgejo issues through Tower authorization',
          description: 'Any actor with an active repository grant may list issues. Tower forwards only an authorized actor alias to the isolated private issue broker; Forgejo credentials are never returned.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'state', in: 'query', required: false, schema: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' } },
            { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
          ],
          responses: {
            '200': { description: 'Visible repository issues', content: { 'application/json': { schema: { type: 'object', required: ['issues'], properties: { issues: { type: 'array', items: { $ref: '#/components/schemas/GitIssue' } } } } } } },
            '400': { description: 'Invalid filters', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Repository not found or not visible', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Forgejo repository access is not reconciled', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Issue broker unavailable or unconfigured', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'Create a Forgejo issue as the Tower actor',
          description: 'Requires git.repo.write or git.repo.admin plus a strict payload-bound, 60-second, one-time NIP-98 event. Successful replays return the cached result without creating a duplicate issue.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateGitIssueRequest' } } } },
          responses: {
            '201': { description: 'Issue created and audited', content: { 'application/json': { schema: { type: 'object', required: ['issue'], properties: { issue: { $ref: '#/components/schemas/GitIssue' } } } } } },
            '400': { description: 'Invalid issue input', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Strict NIP-98 verification failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Repository issue write permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Repository not found or not visible', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'NIP-98 replay or unreconciled provider access', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Issue broker unavailable or unconfigured', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/workspaces/{workspaceId}/repositories/{repositoryId}/issues/{issueNumber}': {
        get: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'Read one Forgejo issue through Tower authorization',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'issueNumber', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
          ],
          responses: {
            '200': { description: 'Issue', content: { 'application/json': { schema: { type: 'object', required: ['issue'], properties: { issue: { $ref: '#/components/schemas/GitIssue' } } } } } },
            '400': { description: 'Invalid issue number', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Issue or repository not found or not visible', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/workspaces/{workspaceId}/repositories/{repositoryId}/issues/{issueNumber}/comments': {
        post: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'Comment on a Forgejo issue as the Tower actor',
          description: 'Requires git.repo.write or git.repo.admin plus the same strict one-time NIP-98 mutation contract as issue creation.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'issueNumber', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateGitIssueCommentRequest' } } } },
          responses: {
            '201': { description: 'Issue comment created and audited', content: { 'application/json': { schema: { type: 'object', required: ['comment'], properties: { comment: { $ref: '#/components/schemas/GitIssueComment' } } } } } },
            '400': { description: 'Invalid comment input or issue number', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Strict NIP-98 verification failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Repository issue write permission denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Issue or repository not found or not visible', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'NIP-98 replay or unreconciled provider access', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/workspaces/{workspaceId}/repositories/{repositoryId}/grants': {
        post: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'Create an explicit actor or stable-group repository grant',
          description: 'Principals are stable Flight Deck PG actor/group UUIDs. Rotating group_npub values are not accepted. Grant creation increments the repository policy revision.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateGitRepositoryGrantRequest' } } } },
          responses: {
            '201': { description: 'Grant created', content: { 'application/json': { schema: { type: 'object', required: ['grant', 'policy_revision'], properties: { grant: { $ref: '#/components/schemas/GitRepositoryGrant' }, policy_revision: { type: 'integer' } } } } } },
            '400': { description: 'Invalid permission, principal, or ref constraints', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Repository/admin authority or principal not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Active matching grant already exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        get: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'List repository grants as a repository administrator',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Repository grants', content: { 'application/json': { schema: { type: 'object', required: ['grants'], properties: { grants: { type: 'array', items: { $ref: '#/components/schemas/GitRepositoryGrant' } } } } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Repository/admin authority not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/workspaces/{workspaceId}/repositories/{repositoryId}/grants/{grantId}': {
        delete: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'Revoke a repository grant',
          description: 'Revocation is retained as history and increments policy_revision so existing capabilities fail stale-policy introspection. The final admin grant cannot be removed.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'grantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Grant revoked', content: { 'application/json': { schema: { type: 'object', required: ['grant', 'policy_revision'], properties: { grant: { $ref: '#/components/schemas/GitRepositoryGrant' }, policy_revision: { type: 'integer' } } } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Repository/admin authority or grant not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Final administrator grant cannot be revoked', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/workspaces/{workspaceId}/repositories/{repositoryId}/policy': {
        get: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'Read repository protected-ref policy',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': { description: 'Repository policy', content: { 'application/json': { schema: { type: 'object', required: ['policy'], properties: { policy: { $ref: '#/components/schemas/GitRepositoryPolicy' } } } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Repository not found or not visible', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        patch: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'Update repository protected-ref policy with optimistic revision',
          description: 'main, staging, and deployed must remain protected, service-managed, non-direct-writable, non-force-writable, and non-deletable.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateGitRepositoryPolicyRequest' } } } },
          responses: {
            '200': { description: 'Policy updated', content: { 'application/json': { schema: { type: 'object', required: ['policy'], properties: { policy: { $ref: '#/components/schemas/GitRepositoryPolicy' } } } } } },
            '400': { description: 'Invalid or weakened protected-ref policy', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Repository/admin authority not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'Policy revision conflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/workspaces/{workspaceId}/repositories/{repositoryId}/audit-events': {
        get: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'List redacted immutable Git security evidence',
          description: 'Repository-admin view of normalized allow/deny/issue/introspect/revoke decisions. Capability plaintext, Authorization headers, service tokens, and arbitrary request bodies are absent.',
          parameters: [
            { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
          ],
          responses: {
            '200': { description: 'Redacted Git audit events', content: { 'application/json': { schema: { type: 'object', required: ['events'], properties: { events: { type: 'array', items: { $ref: '#/components/schemas/GitAuditEvent' } } } } } } },
            '401': { description: 'NIP-98 auth required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Repository/admin authority not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/credential-exchanges': {
        post: {
          tags: ['Git Authority'], security: [{ nip98: [] }], summary: 'Exchange one strict NIP-98 event for a short-lived Git capability',
          description: 'Requires exact scheme/host/path/query/method, a mandatory body payload hash, a 60-second age/skew window, and one-time event ID consumption. Current clients send repository_id and audience; Tower resolves the NIP-98 actor and derives every currently authorized transport scope from active actor/group grants. Restricted legacy actor_id/service/requested_scopes fields are accepted only together and only as a validated subset. The response is the only Tower serialization containing capability plaintext.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/GitCredentialExchangeRequest' } } } },
          responses: {
            '201': { description: 'Short-lived repository/audience/scopes/policy-bound capability; current capabilities are service-neutral until gateway introspection', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitCredentialExchangeResponse' } } } },
            '400': { description: 'Invalid exchange request or service/scope combination', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Strict NIP-98 verification failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '403': { description: 'Actor, audience, or scope denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Repository not found or not visible', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '409': { description: 'NIP-98 exchange event replayed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Git capability runtime is not configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/internal/capabilities/introspect': {
        post: {
          tags: ['Git Authority'], security: [{ gitInternalService: [] }], summary: 'Introspect an opaque capability for one repository/Git service/scope',
          description: 'Private wingman-git seam. Fails closed for missing service authentication and checks repository, audience, upload-pack/receive-pack, requested transport scope, expiry, revocation, policy revision, membership, and current actor/group grants. A bearer capability alone never proves administration, merge, approval, promotion, deployment, or arbitrary ref authority.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/GitCapabilityIntrospectionRequest' } } } },
          responses: {
            '200': { description: 'Active or stable inactive decision', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitCapabilityIntrospectionResponse' } } } },
            '400': { description: 'Invalid introspection binding', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid internal service authentication', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Internal authentication or capability hashing is unconfigured', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/internal/capabilities/revoke': {
        post: {
          tags: ['Git Authority'], security: [{ gitInternalService: [] }], summary: 'Revoke a capability by non-secret ID and repository/audience binding',
          description: 'Private wingman-git seam. The internal service credential, not the bearer capability, authorizes revocation.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RevokeGitCapabilityRequest' } } } },
          responses: {
            '200': { description: 'Capability revoked or already revoked', content: { 'application/json': { schema: { type: 'object', required: ['revoked', 'capability_id', 'reason_code'], properties: { revoked: { type: 'boolean', enum: [true] }, capability_id: { type: 'string', format: 'uuid' }, reason_code: { type: 'string' } } } } } },
            '400': { description: 'Invalid revoke request', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Invalid internal service authentication', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Capability not found for repository/audience binding', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Internal authentication or capability hashing is unconfigured', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/internal/forgejo/resolve': {
        get: {
          tags: ['Git Authority'], security: [{ gitInternalService: [] }], summary: 'Resolve a canonical Forgejo path and reconciliation readiness',
          description: 'Gateway-only path resolution. Names are Tower-claimed workspace namespaces plus Tower-validated repository slugs; stable UUIDs remain the authority keys.',
          parameters: [
            { name: 'owner', in: 'query', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,38}$' } },
            { name: 'repository', in: 'query', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,62}$' } },
          ],
          responses: {
            '200': { description: 'Canonical binding', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitForgejoRepositoryBinding' } } } },
            '401': { description: 'Invalid internal service authentication', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Path not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/internal/forgejo/browser/validate': {
        post: {
          tags: ['Git Authority'], security: [{ gitInternalService: [] }],
          summary: 'Revalidate a Forgejo browser signer and current Tower repository entitlements',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['signer_npub'], properties: { signer_npub: { type: 'string' }, expected_actor_id: { type: 'string', format: 'uuid', nullable: true } } } } } },
          responses: {
            '200': { description: 'Current actor/session validity and repository paths', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid internal service authentication', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Authority or reconciliation unavailable', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/internal/forgejo/repositories/{repositoryId}/desired-state': {
        get: {
          tags: ['Git Authority'], security: [{ gitInternalService: [] }], summary: 'Read Tower-canonical Forgejo reconciliation input',
          parameters: [{ name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Private repository, branch protection, shadow-user access, and workspace-derived organization role state', content: { 'application/json': { schema: { type: 'object' } } } },
            '401': { description: 'Invalid internal service authentication', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '404': { description: 'Repository not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/internal/forgejo/organizations/pending': {
        get: {
          tags: ['Git Authority'], security: [{ gitInternalService: [] }], summary: 'List workspace organizations awaiting Forgejo projection',
          responses: { '200': { description: 'Pending or retryable workspace organization bindings', content: { 'application/json': { schema: { type: 'object' } } } }, '401': { description: 'Invalid internal service authentication' } },
        },
      },
      '/api/v4/git/internal/forgejo/organizations/{workspaceId}/desired-state': {
        get: {
          tags: ['Git Authority'], security: [{ gitInternalService: [] }], summary: 'Read Tower-canonical workspace organization and team membership state',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Private organization name, desired generation, and provider-linked owner/member access. Echo desired_generation in both success and failure acknowledgements.', content: { 'application/json': { schema: { type: 'object', required: ['desired_generation'], properties: { desired_generation: { type: 'integer', minimum: 1 } } } } } }, '404': { description: 'Workspace not found' } },
        },
      },
      '/api/v4/git/internal/forgejo/organizations/{workspaceId}/ack': {
        post: {
          tags: ['Git Authority'], security: [{ gitInternalService: [] }], summary: 'Acknowledge exact workspace organization reconciliation state',
          parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['forgejo_owner', 'desired_generation', 'ok'], properties: { forgejo_owner: { type: 'string' }, desired_generation: { type: 'integer', minimum: 1 }, ok: { type: 'boolean' }, error_code: { type: 'string' } } } } } },
          responses: { '200': { description: 'Workspace organization reconciliation state' }, '409': { description: 'Stale organization name or desired generation (including missing generation)' } },
        },
      },
      '/api/v4/git/internal/forgejo/actor-usernames/pending': {
        get: {
          tags: ['Git Authority'], security: [{ gitInternalService: [] }], summary: 'List pending actor username changes for the isolated identity reconciler',
          responses: { '200': { description: 'Pending actor usernames', content: { 'application/json': { schema: { type: 'object' } } } }, '401': { description: 'Invalid internal service authentication' } },
        },
      },
      '/api/v4/git/internal/forgejo/actor-usernames/{actorId}/ack': {
        post: {
          tags: ['Git Authority'], security: [{ gitInternalService: [] }], summary: 'Acknowledge an exact actor username reconciliation request',
          parameters: [{ name: 'actorId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['desired_username', 'ok'], properties: { desired_username: { type: 'string' }, ok: { type: 'boolean' }, error_code: { type: 'string' } } } } } },
          responses: { '200': { description: 'Actor username reconciliation state' }, '409': { description: 'Stale username request' } },
        },
      },
      '/api/v4/git/internal/forgejo/repositories/{repositoryId}/ack': {
        post: {
          tags: ['Git Authority'], security: [{ gitInternalService: [] }], summary: 'Acknowledge one exact Forgejo policy reconciliation revision',
          parameters: [{ name: 'repositoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['applied_policy_revision', 'ok'], properties: { applied_policy_revision: { type: 'integer', minimum: 1 }, ok: { type: 'boolean' }, error_code: { type: 'string' } } } } } },
          responses: {
            '200': { description: 'Reconciliation state', content: { 'application/json': { schema: { $ref: '#/components/schemas/GitForgejoRepositoryBinding' } } } },
            '409': { description: 'Stale reconciliation revision', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/git/forgejo/webhooks': {
        post: {
          tags: ['Git Authority'], summary: 'Ingest HMAC-verified, delivery-deduplicated Forgejo evidence',
          description: 'Requires X-Forgejo-Signature, X-Forgejo-Delivery, and X-Forgejo-Event. Only normalized non-secret evidence enters Tower audit/projection state.',
          responses: {
            '200': { description: 'Duplicate delivery accepted without a second mutation' },
            '202': { description: 'Verified evidence accepted' },
            '401': { description: 'Signature invalid', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '503': { description: 'Webhook verification not configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/v4/admin/tables': {
        get: {
          tags: ['Admin'],
          summary: 'List inspectable backend tables',
          responses: {
            '200': {
              description: 'Table summaries',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AdminTablesResponse' },
                },
              },
            },
            '401': {
              description: 'NIP-98 auth required',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/v4/admin/tables/{table}': {
        get: {
          tags: ['Admin'],
          summary: 'Read rows from an inspectable backend table',
          parameters: [
            {
              name: 'table',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', default: 100 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', default: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'Paged table rows',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AdminTableRowsResponse' },
                },
              },
            },
            '401': {
              description: 'NIP-98 auth required',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Unknown table',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
    },
  };
}
