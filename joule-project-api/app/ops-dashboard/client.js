/**
 * Ops dashboard — polls the existing observability HTTP endpoints and
 * renders live counters + budget bars + middleware chain.
 *
 * Endpoints consumed (all read-only, no auth in dev):
 *   GET /budget-status
 *   GET /cache-stats
 *   GET /retry-stats
 *   GET /guardrails-stats
 *   GET /injection-stats
 *   POST /mcp resources/read config://chain  (chain snapshot)
 *
 * Zero framework. Just fetch() + DOM update. Polling interval controlled
 * via the header input. Pause button halts polling without unloading.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    interval: $('#interval'),
    pause: $('#pause'),
    pollInterval: $('#poll-interval'),
    connStatus: $('#conn-status'),
    connLabel: $('#conn-label'),

    budgetWindow: $('#budget-window'),
    budgetTotal: $('#budget-total'),
    budgetTenants: $('#budget-tenants'),
    budgetModels: $('#budget-models'),

    cacheHitrate: $('#cache-hitrate'),
    cacheSub: $('#cache-sub'),
    retryRetried: $('#retry-retried'),
    retrySub: $('#retry-sub'),
    guardrailsBlocks: $('#guardrails-blocks'),
    guardrailsSub: $('#guardrails-sub'),
    injectionScanned: $('#injection-scanned'),
    injectionSub: $('#injection-sub'),

    chainList: $('#chain-list'),
  };

  let timer = null;
  let paused = false;
  let mcpSession = null;   // filled lazily on first MCP call

  els.interval.addEventListener('change', () => {
    const v = parseInt(els.interval.value, 10);
    if (v >= 1 && v <= 60) {
      els.pollInterval.textContent = v;
      restart();
    }
  });
  els.pause.addEventListener('click', () => togglePause());

  function setConn(state, label) {
    els.connStatus.className = 'dot ' + state;
    els.connLabel.textContent = label;
  }
  function togglePause() {
    paused = !paused;
    els.pause.textContent = paused ? 'Resume' : 'Pause';
    els.pause.classList.toggle('paused', paused);
    if (paused) { clearInterval(timer); setConn('idle', 'paused'); }
    else restart();
  }
  function restart() {
    if (timer) clearInterval(timer);
    if (paused) return;
    poll();
    const secs = parseInt(els.interval.value, 10) || 3;
    timer = setInterval(poll, secs * 1000);
  }

  // ---- Endpoint fetchers ---------------------------------------------
  async function safeJson(url, opts) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  async function initMcpSession() {
    const r = await fetch('http://127.0.0.1:3334/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ops-dashboard', version: '0' } },
      }),
    });
    mcpSession = r.headers.get('Mcp-Session-Id');
    return !!mcpSession;
  }
  async function readChain() {
    if (!mcpSession) {
      const ok = await initMcpSession();
      if (!ok) return null;
    }
    const r = await fetch('http://127.0.0.1:3334/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': mcpSession,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'resources/read',
        params: { uri: 'config://chain' },
      }),
    });
    if (!r.ok) return null;
    const body = await r.json();
    const text = body?.result?.contents?.[0]?.text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  // ---- Rendering -----------------------------------------------------
  function money(n) {
    if (n == null) return '–';
    if (n < 1) return '$' + n.toFixed(4);
    return '$' + n.toFixed(2);
  }
  function pct(hit, total) {
    if (!total) return '0%';
    return Math.round((hit / total) * 100) + '%';
  }

  function renderBudget(data) {
    if (!data) return;
    els.budgetWindow.textContent = `window ${data.window}`;
    // Total
    const total = data.total ?? { spent: 0, limit: 0 };
    const ratio = total.limit ? Math.min(1, total.spent / total.limit) : 0;
    let barClass = '';
    if (ratio > 0.9) barClass = 'err';
    else if (ratio > 0.6) barClass = 'warn';
    els.budgetTotal.innerHTML = `
      <div>
        <div class="spent">${money(total.spent)}</div>
        <div class="limit">of ${money(total.limit)} · ${Math.round(ratio*100)}%</div>
      </div>
      <div class="bar"><div class="bar-fill ${barClass}" style="width: ${Math.round(ratio*100)}%"></div></div>
    `;
    // Per-tenant
    els.budgetTenants.innerHTML = renderBreakdownRows(data.perTenant ?? []);
    // Per-model
    els.budgetModels.innerHTML = renderBreakdownRows(data.perModel ?? []);
  }
  function renderBreakdownRows(rows) {
    if (!rows.length) return '<div class="empty">(no spend recorded)</div>';
    return rows.map((r) => {
      const spent = r.spent ?? 0;
      const limit = r.limit ?? 0;
      const ratio = limit ? Math.min(1, spent / limit) : 0;
      const cls = ratio > 0.9 ? 'err' : ratio > 0.6 ? 'warn' : '';
      return `
        <div class="row">
          <span class="name">${escapeHtml(r.key)}</span>
          <span class="amt">${money(spent)} / ${money(limit)}</span>
          <div class="mini-bar"><div class="mini-bar-fill ${cls}" style="width: ${Math.round(ratio*100)}%"></div></div>
        </div>
      `;
    }).join('');
  }

  function renderCache(data) {
    if (!data) return;
    const exact = data.hits ?? 0;
    const semantic = data.semanticHits ?? 0;
    const miss = data.misses ?? 0;
    const total = exact + semantic + miss;
    els.cacheHitrate.textContent = pct(exact + semantic, total);
    els.cacheSub.textContent = `exact ${exact} · semantic ${semantic} · miss ${miss}${data.size != null ? ` · size ${data.size}` : ''}`;
  }
  function renderRetry(data) {
    if (!data) return;
    const retried = data.retriedRequests ?? 0;
    const total = data.requests ?? 0;
    els.retryRetried.textContent = pct(retried, total);
    const waited = ((data.totalWaitMs ?? 0) / 1000).toFixed(1);
    els.retrySub.textContent = `${data.totalRetries ?? 0} attempts · ${waited}s waited · ${data.givenUp ?? 0} gave up`;
  }
  function renderGuardrails(data) {
    if (!data) return;
    const totalBlocks = (data.inputBlocks ?? 0) + (data.outputBlocks ?? 0);
    els.guardrailsBlocks.textContent = String(totalBlocks);
    els.guardrailsSub.textContent = `blocks in ${data.inputBlocks ?? 0} / out ${data.outputBlocks ?? 0} · redacts in ${data.inputRedacts ?? 0} / out ${data.outputRedacts ?? 0}`;
  }
  function renderInjection(data) {
    if (!data) return;
    els.injectionScanned.textContent = String(data.scanned ?? 0);
    els.injectionSub.textContent = `${data.blocked ?? 0} blocked · ${data.sanitized ?? 0} sanitized · ${data.warned ?? 0} warned`;
  }
  function renderChain(data) {
    if (!data || !data.order) return;
    els.chainList.innerHTML = data.order.map((m) => `
      <li>
        <span class="kind">${escapeHtml(m.kind)}</span>
        <span class="config">${escapeHtml(configPreview(m.config))}</span>
      </li>
    `).join('');
  }
  function configPreview(cfg) {
    if (!cfg || typeof cfg !== 'object') return '';
    // Show ~3 top-level scalar/short fields for a one-line preview.
    const parts = [];
    for (const [k, v] of Object.entries(cfg)) {
      if (parts.length >= 3) break;
      if (v == null) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`${k}: ${v}`);
      } else if (Array.isArray(v)) {
        parts.push(`${k}: [${v.slice(0, 3).join(',')}${v.length > 3 ? '…' : ''}]`);
      }
    }
    return parts.join(' · ');
  }

  // ---- Poll cycle ----------------------------------------------------
  async function poll() {
    setConn('live', 'polling…');
    const [budget, cache, retry, guardrails, injection, chain] = await Promise.all([
      safeJson('/budget-status'),
      safeJson('/cache-stats'),
      safeJson('/retry-stats'),
      safeJson('/guardrails-stats'),
      safeJson('/injection-stats'),
      readChain(),
    ]);
    renderBudget(budget);
    renderCache(cache);
    renderRetry(retry);
    renderGuardrails(guardrails);
    renderInjection(injection);
    renderChain(chain);
    const now = new Date().toLocaleTimeString();
    setConn('live', `updated ${now}`);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  restart();
})();
