/**
 * Vanilla SSE client for POST /stream/analyzeScenario.
 *
 * The demo app's Express-mounted endpoint streams `streamAgents()` events over
 * text/event-stream (Server-Sent Events wire format). Native EventSource can't
 * do POST, so we drive it manually with fetch() + a ReadableStream reader.
 *
 * Event surface (matches lib/agents.js streamAgents()):
 *   { type: 'turn_start',        step }
 *   { type: 'text_delta',        step, text }              // ← streamed tokens (1.42+)
 *   { type: 'text',              step, text }              // ← atomic per-turn commit
 *   { type: 'agent_call_start',  step, agent, question }
 *   { type: 'agent_call_result', step, agent, answer, isError }
 *   { type: 'done',              step, text, trace, steps, usage, model, stopReason }
 *   { type: 'error',             message }                 // ← added by the SSE handler
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const els = {
    scenario:      $('#scenario'),
    run:           $('#run'),
    stop:          $('#stop'),
    connStatus:    $('#conn-status'),
    connLabel:     $('#conn-label'),
    turnBadge:     $('#turn-badge'),
    agents:        $('#agents'),
    coordinator:   $('#coordinator-text'),
    donePanel:     $('#done-panel'),
    trace:         $('#trace'),
    stats:         $('#stats'),
  };

  let controller = null;

  els.run.addEventListener('click', () => start());
  els.stop.addEventListener('click', () => stop());

  function setConn(state, label) {
    els.connStatus.className = 'dot ' + state;
    els.connLabel.textContent = label;
  }
  function setRunning(running) {
    els.run.disabled = running;
    els.stop.disabled = !running;
    els.scenario.disabled = running;
    if (!running) els.turnBadge.hidden = true;
  }
  function reset() {
    els.agents.innerHTML = '';
    els.coordinator.innerHTML = '';
    els.trace.innerHTML = '';
    els.stats.textContent = '';
    els.donePanel.hidden = true;
    els.turnBadge.hidden = true;
  }

  // ---- Agent card factory --------------------------------------------
  const agentCards = new Map();
  function getAgentCard(name) {
    if (agentCards.has(name)) return agentCards.get(name);
    const div = document.createElement('div');
    div.className = 'agent-card';
    div.innerHTML = `
      <div class="name">${escapeHtml(name)} <span class="status">idle</span></div>
      <div class="question" hidden></div>
      <div class="answer" hidden></div>
    `;
    els.agents.appendChild(div);
    const card = {
      el: div,
      status: div.querySelector('.status'),
      question: div.querySelector('.question'),
      answer: div.querySelector('.answer'),
    };
    agentCards.set(name, card);
    return card;
  }
  function setAgentState(name, state, patch = {}) {
    const card = getAgentCard(name);
    card.el.classList.remove('running', 'done', 'error');
    if (state) card.el.classList.add(state);
    if (patch.status) card.status.textContent = patch.status;
    if (patch.question != null) {
      card.question.textContent = patch.question;
      card.question.hidden = false;
    }
    if (patch.answer != null) {
      card.answer.textContent = patch.answer;
      card.answer.hidden = false;
    }
  }

  // ---- Coordinator text rendering ------------------------------------
  let currentTurnSpan = null;
  function commitTurnSeparator(step) {
    // Called when a new turn_start arrives AFTER the first turn's text.
    const sep = document.createElement('div');
    sep.className = 'turn-sep';
    sep.textContent = `Turn ${step}`;
    els.coordinator.appendChild(sep);
    currentTurnSpan = null;
  }
  function appendCoordinatorDelta(text) {
    // If no active span, create one.
    if (!currentTurnSpan) {
      currentTurnSpan = document.createElement('span');
      currentTurnSpan.className = 'cursor';
      els.coordinator.appendChild(currentTurnSpan);
    }
    // Insert text BEFORE the cursor character.
    currentTurnSpan.insertAdjacentText('beforeend', text);
    els.coordinator.scrollTop = els.coordinator.scrollHeight;
  }
  function endCoordinatorTurn() {
    if (currentTurnSpan) currentTurnSpan.classList.remove('cursor');
  }

  // ---- Event dispatcher ---------------------------------------------
  function dispatch(evt) {
    switch (evt.type) {
      case 'turn_start':
        els.turnBadge.hidden = false;
        els.turnBadge.textContent = `Turn ${evt.step}`;
        if (evt.step > 1) commitTurnSeparator(evt.step);
        break;
      case 'text_delta':
        appendCoordinatorDelta(evt.text);
        break;
      case 'text':
        // If deltas already streamed, `text` is redundant (final commit) — just remove cursor.
        endCoordinatorTurn();
        break;
      case 'agent_call_start':
        setAgentState(evt.agent, 'running', {
          status: 'running…',
          question: evt.question,
        });
        break;
      case 'agent_call_result':
        setAgentState(evt.agent, evt.isError ? 'error' : 'done', {
          status: evt.isError ? 'error' : 'done',
          answer: evt.answer,
        });
        break;
      case 'done':
        endCoordinatorTurn();
        renderDonePanel(evt);
        setConn('idle', 'done');
        setRunning(false);
        break;
      case 'error':
        setConn('err', 'error: ' + evt.message);
        setRunning(false);
        break;
      default:
        // Unknown event — future-compat, ignore.
        break;
    }
  }

  function renderDonePanel(done) {
    const html = (done.trace ?? []).map((row) => `
      <div class="trace-row ${row.isError ? 'err' : ''}">
        <div class="agent">${escapeHtml(row.agent)}</div>
        <div class="q">${escapeHtml(row.question ?? '')}</div>
        <div>${escapeHtml(row.answer)}</div>
      </div>
    `).join('');
    els.trace.innerHTML = html || '<em>(no specialist calls)</em>';
    const stats = [];
    if (done.steps != null) stats.push(`${done.steps} coordinator turn(s)`);
    if (done.usage) {
      const t = (done.usage.input_tokens ?? 0) + (done.usage.output_tokens ?? 0);
      stats.push(`${t.toLocaleString()} tokens`);
    }
    if (done.model) stats.push(done.model);
    if (done.stopReason) stats.push(`stopReason: ${done.stopReason}`);
    els.stats.textContent = stats.join(' · ');
    els.donePanel.hidden = false;
  }

  // ---- SSE reader ---------------------------------------------------
  async function start() {
    const scenario = els.scenario.value.trim();
    if (!scenario) { setConn('err', 'scenario is empty'); return; }
    reset();
    agentCards.clear();
    setRunning(true);
    setConn('live', 'streaming');
    controller = new AbortController();
    try {
      const res = await fetch('/stream/analyzeScenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ scenario }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        setConn('err', `http ${res.status}`);
        setRunning(false);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames separated by \n\n; a frame carries one or more `data:` lines
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'));
          if (!dataLines.length) continue;
          const raw = dataLines.map((l) => l.slice(5).trimStart()).join('\n');
          try { dispatch(JSON.parse(raw)); }
          catch (_e) { /* ignore malformed frame */ }
        }
      }
      // Stream closed cleanly; done event should have already fired
      if (els.donePanel.hidden) {
        setConn('idle', 'closed');
        setRunning(false);
      }
    } catch (e) {
      if (e.name !== 'AbortError') setConn('err', 'error: ' + e.message);
      setRunning(false);
    }
  }
  function stop() {
    if (controller) controller.abort();
    setConn('idle', 'stopped');
    setRunning(false);
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
})();
