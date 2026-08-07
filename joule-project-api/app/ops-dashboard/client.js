/**
 * Ops dashboard — polls the existing observability HTTP endpoints and
 * renders live counters + budget bars + resilience state + middleware chain.
 *
 * Endpoints consumed (all read-only, no auth in dev):
 *   GET /resilience      (aggregate — drives the top-level health dot)
 *   GET /budget-status
 *   GET /cache-stats
 *   GET /retry-stats
 *   GET /guardrails-stats
 *   GET /injection-stats
 *   GET /deadline-state
 *   GET /breaker-state
 *   GET /bulkhead-state
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

    deadlineExpired: $('#deadline-expired'),
    deadlineSub:     $('#deadline-sub'),
    breakerState:    $('#breaker-state'),
    breakerSub:      $('#breaker-sub'),
    bulkheadInflight:$('#bulkhead-inflight'),
    bulkheadSub:     $('#bulkhead-sub'),
    costGuardBlocked:$('#costguard-blocked'),
    costGuardSub:    $('#costguard-sub'),
    jsonLogFailed:   $('#jsonlog-failed'),
    jsonLogSub:      $('#jsonlog-sub'),
    tunerMax:        $('#tuner-max'),
    tunerSub:        $('#tuner-sub'),
    probeStatus:     $('#probe-status'),
    probeSub:        $('#probe-sub'),
    amtAdjusted:     $('#amt-adjusted'),
    amtSub:          $('#amt-sub'),
    traceRatio:      $('#trace-ratio'),
    traceSub:        $('#trace-sub'),

    // Quote widget
    quoteInput:  $('#quote-input'),
    quoteModel:  $('#quote-model'),
    quoteMax:    $('#quote-max'),
    quoteBtn:    $('#quote-btn'),
    quoteResult: $('#quote-result'),

    healthDot:   $('#health-dot'),
    healthLabel: $('#health-label'),

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
  function renderDeadline(data) {
    if (!data) return;
    els.deadlineExpired.textContent = String(data.expired ?? 0);
    els.deadlineSub.textContent = `${data.requests ?? 0} requests · ${data.activeCount ?? 0} active`;
  }
  function renderBreaker(data) {
    if (!data) return;
    // Show the worst-case state across all provider buckets, or 'closed' if no buckets seen yet
    const buckets = Object.entries(data.buckets ?? {});
    let worst = 'closed';
    const rank = { closed: 0, halfOpen: 1, open: 2 };
    for (const [, s] of buckets) {
      if ((rank[s.state] ?? 0) > (rank[worst] ?? 0)) worst = s.state;
    }
    els.breakerState.textContent = worst.toUpperCase();
    els.breakerState.className = 'kpi-primary ' + (worst === 'open' ? 'err' : worst === 'halfOpen' ? 'warn' : 'ok');
    const opens  = data.opens ?? 0;
    const closes = data.closes ?? 0;
    const nBuckets = buckets.length;
    els.breakerSub.textContent = `${opens} opens · ${closes} closes · ${nBuckets} providers`;
  }
  function renderBulkhead(data) {
    if (!data) return;
    // Sum in-flight across buckets. Max concurrent shown as denominator.
    const buckets = Object.entries(data.buckets ?? {});
    const totalInFlight = buckets.reduce((s, [, b]) => s + (b.inFlight ?? 0), 0);
    const totalQueued   = buckets.reduce((s, [, b]) => s + (b.queued ?? 0), 0);
    const cap = data.maxConcurrent ?? 0;
    els.bulkheadInflight.textContent = `${totalInFlight}/${cap * Math.max(1, buckets.length)}`;
    const rej = data.rejected ?? 0;
    const to  = data.timedOut ?? 0;
    els.bulkheadSub.textContent = `${totalQueued} queued · ${rej} rejected · ${to} timed out`;
    els.bulkheadInflight.className = 'kpi-primary ' + (rej > 0 || to > 0 ? 'warn' : '');
  }
  function renderCostGuard(data) {
    if (!data) return;
    const blocked = data.blocked ?? 0;
    const warned  = data.warned  ?? 0;
    const checked = data.checked ?? 0;
    const est     = data.estimatedUsdTotal ?? 0;
    els.costGuardBlocked.textContent = String(blocked);
    els.costGuardBlocked.className = 'kpi-primary ' + (blocked > 0 ? 'err' : warned > 0 ? 'warn' : '');
    els.costGuardSub.textContent = `${checked} checked · ${warned} warned · ${money(est)} forecast`;
  }
  function renderJsonLog(data) {
    if (!data) return;
    const failed = data.failed ?? 0;
    const ok     = data.ok     ?? 0;
    const codes  = Object.entries(data.byErrorCode ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([code, n]) => `${code}:${n}`)
      .join(' · ');
    els.jsonLogFailed.textContent = String(failed);
    els.jsonLogFailed.className = 'kpi-primary ' + (failed > 0 ? 'err' : '');
    els.jsonLogSub.textContent = `${ok} ok · ${failed} failed${codes ? ' · ' + codes : ' · no error codes'}`;
  }
  function renderTuner(data) {
    if (!data) return;
    els.tunerMax.textContent = String(data.currentMaxConcurrent ?? '–');
    // Color the primary: green for grow, yellow for shrink, neutral for noop
    const action = data.lastAction ?? 'none';
    const cls = action === 'grow' ? 'ok' : action === 'shrink' ? 'warn' : '';
    els.tunerMax.className = 'kpi-primary ' + cls;
    const p95 = data.lastP95Ms != null ? `${data.lastP95Ms}ms` : '–';
    els.tunerSub.textContent = `p95 ${p95} · target ${data.p95TargetMs}ms · ${data.grows ?? 0}↑ ${data.shrinks ?? 0}↓ · ${action}`;
  }
  function renderProbe(data) {
    if (!data) return;
    // Show the worst-case healthy state across providers
    const providers = Object.entries(data.providers ?? {});
    let overall = 'unknown';
    if (providers.length > 0) {
      const anyUnhealthy = providers.some(([, s]) => s.healthy === false);
      const allHealthy   = providers.every(([, s]) => s.healthy === true);
      overall = anyUnhealthy ? 'unhealthy' : allHealthy ? 'healthy' : 'probing';
    }
    els.probeStatus.textContent = overall.toUpperCase();
    els.probeStatus.className = 'kpi-primary ' + (overall === 'unhealthy' ? 'err' : overall === 'healthy' ? 'ok' : '');
    const failures = data.failures ?? 0;
    const timeouts = data.timeouts ?? 0;
    els.probeSub.textContent = `${data.probes ?? 0} probes · ${failures} failures · ${timeouts} timeouts · ${data.running ? 'running' : 'stopped'}`;
  }
  function renderAdaptiveTokens(data) {
    if (!data) return;
    const adjusted = data.adjusted ?? 0;
    const rejected = data.rejected ?? 0;
    const saved    = data.totalSavedTokens ?? 0;
    els.amtAdjusted.textContent = String(adjusted);
    els.amtAdjusted.className = 'kpi-primary ' + (rejected > 0 ? 'err' : adjusted > 0 ? 'warn' : '');
    els.amtSub.textContent = `${adjusted} shrunk · ${rejected} rejected · ${saved.toLocaleString()} tokens saved`;
  }
  function renderTrace(data) {
    if (!data) return;
    const extracted = data.extracted ?? 0;
    const generated = data.generated ?? 0;
    const total     = extracted + generated;
    const pctExtracted = total === 0 ? '–' : Math.round((extracted / total) * 100) + '%';
    els.traceRatio.textContent = pctExtracted;
    // Low extracted ratio = upstream not propagating headers. Not an error,
    // but ops might want to add a header at the ingress.
    els.traceRatio.className = 'kpi-primary';
    els.traceSub.textContent = `${extracted} extracted · ${generated} generated`;
  }
  function renderHealth(data) {
    if (!data) {
      els.healthDot.className = 'dot idle';
      els.healthLabel.textContent = 'unknown';
      return;
    }
    const status = data.status ?? 'unknown';
    els.healthDot.className = 'dot ' + (status === 'ok' ? 'live' : status === 'degraded' ? 'warn' : 'err');
    const degradedLayers = (data.degraded ?? []).map((d) => d.layer).join(', ');
    els.healthLabel.textContent = degradedLayers ? `degraded: ${degradedLayers}` : status;
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
    const [budget, cache, retry, guardrails, injection, deadline, breaker, bulkhead, costguard, jsonlog, tuner, probe, amt, trace, health, chain] = await Promise.all([
      safeJson('/budget-status'),
      safeJson('/cache-stats'),
      safeJson('/retry-stats'),
      safeJson('/guardrails-stats'),
      safeJson('/injection-stats'),
      safeJson('/deadline-state'),
      safeJson('/breaker-state'),
      safeJson('/bulkhead-state'),
      safeJson('/cost-guard-state'),
      safeJson('/log-state'),
      safeJson('/tuner-state'),
      safeJson('/probe-state'),
      safeJson('/adaptive-tokens-state'),
      safeJson('/trace-state'),
      safeJson('/resilience'),
      readChain(),
    ]);
    renderBudget(budget);
    renderCache(cache);
    renderRetry(retry);
    renderGuardrails(guardrails);
    renderInjection(injection);
    renderDeadline(deadline);
    renderBreaker(breaker);
    renderBulkhead(bulkhead);
    renderCostGuard(costguard);
    renderJsonLog(jsonlog);
    renderTuner(tuner);
    renderProbe(probe);
    renderAdaptiveTokens(amt);
    renderTrace(trace);
    renderHealth(health);   // health = /resilience payload
    renderChain(chain);
    const now = new Date().toLocaleTimeString();
    setConn('live', `updated ${now}`);
  }

  // ---- Quote widget --------------------------------------------------
  async function submitQuote() {
    const text  = (els.quoteInput.value ?? '').trim();
    const model = els.quoteModel.value;
    const maxTokens = Math.max(1, parseInt(els.quoteMax.value, 10) || 500);
    if (!text) {
      els.quoteResult.innerHTML = '<div class="empty">(enter a prompt above)</div>';
      return;
    }
    els.quoteResult.innerHTML = '<div class="empty">estimating…</div>';
    try {
      const r = await fetch('/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, maxTokens,
          messages: [{ role: 'user', content: text }],
        }),
      });
      if (!r.ok) {
        const err = await r.text();
        els.quoteResult.innerHTML = `<div class="err">HTTP ${r.status}: ${escapeHtml(err.slice(0, 200))}</div>`;
        return;
      }
      const est = await r.json();
      const priceBadge = est.priced ? '' : ' <span class="warn-badge">unpriced</span>';
      const notes = (est.notes ?? []).map(n => `<li>${escapeHtml(n)}</li>`).join('');
      els.quoteResult.innerHTML = `
        <div class="quote-cost">${money(est.estimatedUsd)}${priceBadge}</div>
        <div class="quote-detail">
          <span class="q-label">model</span> ${escapeHtml(est.model)}<br>
          <span class="q-label">tokens in</span> ${est.tokensIn.toLocaleString()}
          &middot; <span class="q-label">est max out</span> ${est.estMaxTokensOut.toLocaleString()}<br>
          <span class="q-label">input</span> ${money(est.inputUsd)}
          &middot; <span class="q-label">output</span> ${money(est.outputUsd)}<br>
          <span class="q-label">tokenizer</span> ${escapeHtml(est.tokenizerUsed)}
        </div>
        ${notes ? `<ul class="quote-notes">${notes}</ul>` : ''}
      `;
    } catch (e) {
      els.quoteResult.innerHTML = `<div class="err">fetch failed: ${escapeHtml(e.message)}</div>`;
    }
  }
  els.quoteBtn.addEventListener('click', submitQuote);
  els.quoteInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitQuote();
  });

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  restart();
})();
