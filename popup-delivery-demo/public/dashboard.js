/**
 * Live flow inspector. Subscribes to the internal trace bus over
 * /ws/inspector and maps each entry onto the architecture diagram, the
 * activity feed and the KPI row. Purely observability — nothing here
 * feeds back into the delivery path.
 * Live journey dashboard. It maps backend trace events to the visual
 * orchestration stages while keeping campaign and KPI data in sync.
 */
(function () {
  'use strict';

  var NODE_META = {
    sdk: { label: 'Storefront SDK', icon: 'cursor' },
    api: { label: 'API gateway', icon: 'brackets' },
    ingestion: { label: 'Event ingestion', icon: 'inbox' },
    profile: { label: 'Profile builder', icon: 'user' },
    realtime: { label: 'Realtime socket', icon: 'signal' },
    'campaign-manager': { label: 'Campaign manager', icon: 'campaign' },
    rules: { label: 'Audience rules', icon: 'filter' },
    decision: { label: 'Decision engine', icon: 'spark' },
    'action-sender': { label: 'Action delivery', icon: 'send' },
    'campaigns-db': { label: 'Campaigns', icon: 'database' },
    'profiles-db': { label: 'Profiles', icon: 'database' },
    'analytics-db': { label: 'Analytics', icon: 'database' },
  };

  var LAYOUT = {
    client: ['sdk'],
    backend: ['api', 'ingestion', 'profile', 'realtime'],
    engine: ['campaign-manager', 'rules', 'decision', 'action-sender'],
    stores: ['campaigns-db', 'profiles-db', 'analytics-db'],
  };

  var ICONS = {
    cursor: '<path d="m6 4 12 8-6 1-3 6-3-15Z"/>',
    brackets: '<path d="M8 4H5v16h3M16 4h3v16h-3M10 8l4 4-4 4"/>',
    inbox: '<path d="M4 5h16v14H4V5Zm0 9h4l2 2h4l2-2h4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    signal: '<path d="M5 12.55a11 11 0 0 1 14 0M8.5 16a6 6 0 0 1 7 0M12 20h.01"/>',
    campaign: '<path d="m4 13 11-7v12L4 13Zm11-3h3a2 2 0 0 1 0 4h-3M6 14l1 5h4l-1-4"/>',
    filter: '<path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z"/>',
    spark: '<path d="m13 2-8 11h7l-1 9 8-11h-7l1-9Z"/>',
    send: '<path d="m3 11 18-8-8 18-2-8-8-2Zm8 2 4-4"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  };

  var nodes = {};
  var timers = {};
  var recentEntries = [];
  var refreshTimer = null;
  var logbox = document.querySelector('[data-testid="trace-log"]');
  var emptyState = document.querySelector('[data-empty-state]');
  var overlay = document.querySelector('.flow__overlay');
  var lastFiredNode = null;
  var lastFiredAt = 0;
  var STALE_GAP_MS = 1500; // a new burst after this much silence starts a fresh trail, not a jump from history

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  function buildDiagram() {
    Object.keys(LAYOUT).forEach(function (column) {
      var host = document.querySelector('[data-col="' + column + '"]');
      LAYOUT[column].forEach(function (id) {
        var meta = NODE_META[id];
        var box = document.createElement('div');
        box.className = 'journey-node';
        box.setAttribute('data-node', id);
        box.innerHTML =
          '<div class="node__head">' +
          '<span class="status-dot"></span>' +
          '<span class="node__label">' + meta.label + '</span>' +
          '<span class="node__time"></span>' +
          '</div>' +
          '<div class="node__meta">Ready</div>';
          '<span class="node-icon">' + icon(meta.icon) + '</span>' +
          '<span class="node-copy"><b>' + meta.label + '</b><small class="last">Ready</small></span>' +
          '<span class="node-state"></span>';
        host.appendChild(box);
        nodes[id] = box;
      });
    });
  }

  // Real coordinates of a node's center, relative to the overlay's own box —
  // recomputed live so it stays correct across resizes and horizontal scroll.
  function centerOf(el) {
    var overlayRect = overlay.getBoundingClientRect();
    var rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2 - overlayRect.left,
      y: rect.top + rect.height / 2 - overlayRect.top,
    };
  }

  // Draws one real hop: a line plus a dot that travels it, exactly the path
  // this specific trace entry actually took through the architecture. Not a
  // canned animation — the endpoints come from the real DOM node positions,
  // in the real order the backend emitted them.
  function drawTravel(fromBox, toBox) {
    var svgns = 'http://www.w3.org/2000/svg';
    var a = centerOf(fromBox);
    var b = centerOf(toBox);

    var group = document.createElementNS(svgns, 'g');

    var line = document.createElementNS(svgns, 'line');
    line.setAttribute('x1', a.x);
    line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x);
    line.setAttribute('y2', b.y);
    line.setAttribute('class', 'flow__line');
    line.style.animation = 'flow-dash-move .45s linear';
    group.appendChild(line);

    var dot = document.createElementNS(svgns, 'circle');
    dot.setAttribute('r', 4);
    dot.setAttribute('class', 'flow__dot');
    var motion = document.createElementNS(svgns, 'animateMotion');
    motion.setAttribute('dur', '0.45s');
    motion.setAttribute('fill', 'freeze');
    motion.setAttribute('path', 'M' + a.x + ',' + a.y + ' L' + b.x + ',' + b.y);
    dot.appendChild(motion);
    group.appendChild(dot);

    overlay.appendChild(group);
    setTimeout(function () { line.style.opacity = '0'; }, 420);
    setTimeout(function () { group.remove(); }, 750);
  }

  function pulse(entry) {
    var box = nodes[entry.node];
    if (!box) return;

    if (lastFiredNode && lastFiredNode !== box && entry.at - lastFiredAt < STALE_GAP_MS) {
      drawTravel(lastFiredNode, box);
    }
    lastFiredNode = box;
    lastFiredAt = entry.at;

    var isWarn = WARN_PATTERN.test(entry.message);
    box.classList.add('is-hot');
    box.classList.toggle('is-warn', isWarn);
    box.querySelector('.node__meta').textContent = entry.message;
    box.querySelector('.node__time').textContent = new Date(entry.at).toLocaleTimeString();

    clearTimeout(timers[entry.node]);
    timers[entry.node] = setTimeout(function () {
      box.classList.remove('is-hot', 'is-warn');
    }, 900);
  }

  function appendLog(entry) {
    if (emptyState && emptyState.parentNode) {
      emptyState.remove();
      emptyState = null;
    }

    var meta = NODE_META[entry.node] || { label: entry.node };
    var isWarn = WARN_PATTERN.test(entry.message);
    box.classList.add('is-active');
    box.querySelector('.last').textContent = entry.message;

    clearTimeout(timers[entry.node]);
    timers[entry.node] = setTimeout(function () {
      box.classList.remove('is-active');
      box.classList.add('is-complete');
    }, 850);
    setTimeout(function () {
      box.classList.remove('is-complete');
    }, 4000);
  }

  function appendLog(entry) {
    if (emptyState && emptyState.parentNode) emptyState.remove();
    recentEntries.unshift(entry);
    recentEntries = recentEntries.slice(0, 50);

    var line = document.createElement('div');
    var time = new Date(entry.at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    var meta = NODE_META[entry.node] || { label: entry.node, icon: 'spark' };
    line.className = 'activity-row';
    line.innerHTML =
      '<span class="activity-icon">' + icon(meta.icon) + '</span>' +
      '<span class="activity-copy"><b>' + escapeHtml(meta.label) + '</b>' +
      '<small>' + escapeHtml(entry.message) + '</small></span>' +
      '<time>' + time + '</time>';
    logbox.insertBefore(line, logbox.firstChild);
    while (logbox.childElementCount > 50) logbox.removeChild(logbox.lastChild);

    var lastEvent = document.querySelector('[data-last-event]');
    if (lastEvent) lastEvent.textContent = 'Updated just now';
  }

  function setConnection(connected) {
    var badge = document.querySelector('[data-connection-state]');
    var label = document.querySelector('[data-testid="inspector-ws-label"]');
    if (!badge || !label) return;
    badge.classList.toggle('is-connected', connected);
    label.textContent = connected ? 'live' : 'reconnecting…';
  }

  // Trace entries for one click arrive within a few milliseconds of each
  // other (it's all synchronous on the server) — too fast to actually see as
  // a request crossing the diagram. Replaying the queue at a fixed pace turns
  // real backend causal order into a visible left-to-right/back-and-forth
  // sweep, instead of one simultaneous flash.
  var playQueue = [];
  var playing = false;
  var STEP_MS = 130;

  function playNext() {
    var entry = playQueue.shift();
    if (!entry) { playing = false; return; }
    pulse(entry);
    appendLog(entry);
    refreshPanelsSoon();
    setTimeout(playNext, STEP_MS);
  }

  function enqueueTrace(entry) {
    playQueue.push(entry);
    if (!playing) { playing = true; playNext(); }
    var status = document.querySelector('[data-connection-state]');
    if (!status) return;
    status.classList.toggle('is-connected', connected);
    status.innerHTML = '<i></i>' + (connected ? 'Live' : 'Reconnecting');
  }

  function connect() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var socket = new WebSocket(protocol + '//' + window.location.host + '/ws/inspector');

    socket.addEventListener('open', function () {
      setConnection(true);
    });

    socket.addEventListener('message', function (event) {
      var message = JSON.parse(event.data);

      if (message.type === 'backlog') {
        message.entries.slice(-15).forEach(appendLog);
        message.entries.slice(-12).forEach(appendLog);
        return;
      }

      if (message.type === 'trace') {
        enqueueTrace(message.entry);
        pulse(message.entry);
        appendLog(message.entry);
        refreshPanelsSoon();
      }
    });

    socket.addEventListener('close', function () {
      setConnection(false);
      setTimeout(connect, 1000);
    });
  }

  function refreshPanelsSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshPanels, 250);
  }

  function campaignIcon(campaign) {
    if (campaign.trigger.event === 'add_to_cart') return 'cart';
    if (campaign.audience.segments.indexOf('vip') >= 0) return 'star';
    return 'tag';
  }

  function campaignIconSvg(name) {
    var paths = {
      cart: '<circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/><path d="M3 4h2l2.4 11h10.8l2-7H6"/>',
      star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9L12 3Z"/>',
      tag: '<path d="M20 13 13 20 4 11V4h7l9 9ZM8.5 8.5h.01"/>',
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths[name] + '</svg>';
  }

  function renderCampaigns(campaigns) {
    var host = document.querySelector('[data-testid="campaign-list"]');
    var count = document.querySelector('[data-testid="campaign-count"]');
    host.innerHTML = '';
    count.textContent = campaigns.length;

    campaigns.forEach(function (campaign) {
      var row = document.createElement('div');
      row.className = 'campaign-row';
      row.setAttribute('data-campaign-row', campaign.id);

      var segment = campaign.audience.segments.join(', ') || 'All visitors';
      var trigger = campaign.trigger.event.replace(/_/g, ' ');
      row.innerHTML =
        '<span class="campaign-icon campaign-icon--' + campaignIcon(campaign) + '">' +
        campaignIconSvg(campaignIcon(campaign)) + '</span>' +
        '<span class="campaign-copy"><b>' + escapeHtml(campaign.name) + '</b>' +
        '<small>When ' + escapeHtml(trigger) + ' · ' + escapeHtml(segment) + '</small></span>' +
        '<span class="campaign-status ' + (campaign.status === 'active' ? 'is-active' : '') + '">' +
        '<i></i>' + escapeHtml(campaign.status) + '</span>';

      var toggle = document.createElement('button');
      toggle.className = 'campaign-action';
      toggle.type = 'button';
      toggle.setAttribute('aria-label', (campaign.status === 'active' ? 'Pause ' : 'Activate ') + campaign.name);
      toggle.textContent = campaign.status === 'active' ? 'Pause' : 'Activate';
      toggle.addEventListener('click', function () {
        toggle.disabled = true;
        fetch('/api/v1/campaigns/' + campaign.id + '/status', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: campaign.status === 'active' ? 'paused' : 'active',
          }),
        }).then(refreshPanels);
      });

      row.appendChild(toggle);
      host.appendChild(row);
    });
  }

  function setMetric(name, value) {
    var element = document.querySelector('[data-metric="' + name + '"]');
    if (element) element.textContent = value;
  }

  function refreshPanels() {
    Promise.all([
      fetch('/api/v1/campaigns').then(function (response) { return response.json(); }),
      fetch('/api/v1/analytics?limit=200').then(function (response) { return response.json(); }),
      fetch('/api/v1/health').then(function (response) { return response.json(); }),
    ]).then(function (results) {
      var campaignData = results[0];
      var analyticsData = results[1];
      var healthData = results[2];
      var byType = analyticsData.summary.byType;
      var events = byType.event || 0;
      var delivered = byType.campaign_delivered || 0;
      var rate = events ? Math.round((delivered / events) * 100) : 0;

      renderCampaigns(campaignData.campaigns);
      setMetric('events', events.toLocaleString());
      setMetric('delivered', delivered.toLocaleString());
      setMetric('profiles', healthData.profiles.toLocaleString());
      setMetric('delivery-rate', rate + '%');
    });
  }

  function showToast() {
    var toast = document.querySelector('[data-toast]');
    toast.classList.add('is-visible');
    setTimeout(function () {
      toast.classList.remove('is-visible');
    }, 2600);
  }

  document.querySelector('[data-testid="reset-state"]').addEventListener('click', function () {
    fetch('/api/v1/admin/reset', { method: 'POST' }).then(function () {
      recentEntries = [];
      logbox.innerHTML =
        '<div class="activity-empty" data-empty-state>' +
        '<span><svg viewBox="0 0 24 24"><path d="M4 17h3l2-10 4 14 2-9 2 5h3"/></svg></span>' +
        '<b>Your live events will appear here</b>' +
        '<small>Open the storefront and add a product to begin.</small></div>';
      emptyState = document.querySelector('[data-empty-state]');
      document.querySelector('[data-last-event]').textContent = 'Waiting for an event';
      showToast();
      refreshPanels();
    });
  });

  document.querySelector('.mobile-menu').addEventListener('click', function () {
    document.body.classList.toggle('sidebar-open');
  });

  document.querySelector('[data-sidebar-close]').addEventListener('click', function () {
    document.body.classList.remove('sidebar-open');
  });

  document.querySelectorAll('.sidebar-link').forEach(function (link) {
    link.addEventListener('click', function () {
      document.body.classList.remove('sidebar-open');
    });
  });

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response.json().then(function (json) {
        if (!response.ok) throw new Error(json.error || 'Request failed');
        return json;
      });
    });
  }

  function initProbe(testUser) {
    var body = { userId: 'synthetic-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) };
    if (testUser) body.testUser = testUser;
    return postJson('/api/v1/sdk/init', body);
  }

  function sendProbeEvent(sessionId, name, properties) {
    return postJson('/api/v1/events', {
      sessionId: sessionId,
      event: { name: name, properties: properties || {}, timestamp: Date.now() },
    }).then(function (response) { return response.results[0]; });
  }

  function decisionFor(result, campaignId) {
    return result.decisions.find(function (decision) {
      return decision.campaignId === campaignId;
    });
  }

  function connectProbe(sessionId) {
    return new Promise(function (resolve, reject) {
      var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      var socket = new WebSocket(
        protocol + '//' + window.location.host + '/ws?sessionId=' + encodeURIComponent(sessionId)
      );
      var timer = setTimeout(function () {
        socket.close();
        reject(new Error('WebSocket handshake exceeded 3 seconds'));
      }, 3000);

      socket.addEventListener('message', function onMessage(event) {
        var message = JSON.parse(event.data);
        if (message.type === 'connected') {
          clearTimeout(timer);
          socket.removeEventListener('message', onMessage);
          resolve(socket);
        }
      });
      socket.addEventListener('error', function () {
        clearTimeout(timer);
        reject(new Error('WebSocket connection failed'));
      }, { once: true });
    });
  }

  function nextAction(socket) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('No campaign action received within 3 seconds'));
      }, 3000);
      socket.addEventListener('message', function onMessage(event) {
        var message = JSON.parse(event.data);
        if (message.type !== 'action') return;
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        resolve(message);
      });
    });
  }

  function requireDecision(result, campaignId, reasonCode) {
    var decision = decisionFor(result, campaignId);
    if (!decision || decision.reasonCode !== reasonCode) {
      throw new Error(
        'Expected ' + campaignId + ' to return ' + reasonCode +
        ', received ' + (decision ? decision.reasonCode : 'no decision')
      );
    }
    return decision;
  }

  async function runScenario(name) {
    if (name === 'delivery') {
      var deliverySession = await initProbe();
      var socket = await connectProbe(deliverySession.sessionId);
      var actionPromise = nextAction(socket);
      var deliveryResult = await sendProbeEvent(deliverySession.sessionId, 'page_view');
      var deliveryDecision = requireDecision(deliveryResult, 'cmp-20-off', 'ELIGIBLE');
      var action = await actionPromise;
      socket.close();
      return {
        title: 'End-to-end delivery passed',
        detail: deliveryDecision.reasonCode + ' -> WebSocket action ' + action.deliveryId.slice(0, 8),
      };
    }

    if (name === 'audience') {
      var audienceSession = await initProbe('non-eligible');
      var audienceResult = await sendProbeEvent(audienceSession.sessionId, 'page_view');
      var audienceDecision = requireDecision(
        audienceResult,
        'cmp-20-off',
        'AUDIENCE_MISMATCH'
      );
      return {
        title: 'Audience isolation passed',
        detail: audienceDecision.reason,
      };
    }

    if (name === 'frequency') {
      var frequencySession = await initProbe();
      await sendProbeEvent(frequencySession.sessionId, 'page_view');
      var repeated = await sendProbeEvent(frequencySession.sessionId, 'page_view');
      var frequencyDecision = requireDecision(repeated, 'cmp-20-off', 'FREQUENCY_CAP');
      return {
        title: 'Frequency cap passed',
        detail: frequencyDecision.reason,
      };
    }

    if (name === 'threshold') {
      var thresholdSession = await initProbe();
      var below = await sendProbeEvent(thresholdSession.sessionId, 'add_to_cart', { price: 40 });
      requireDecision(below, 'cmp-free-shipping', 'CONDITION_FAILED');
      var above = await sendProbeEvent(thresholdSession.sessionId, 'add_to_cart', { price: 75 });
      var thresholdDecision = requireDecision(above, 'cmp-free-shipping', 'ELIGIBLE');
      return {
        title: 'Behavioral threshold passed',
        detail: '$40 rejected; cumulative $115 returned ' + thresholdDecision.reasonCode,
      };
    }

    throw new Error('Unknown synthetic scenario');
  }

  var scenarioButtons = Array.from(document.querySelectorAll('[data-scenario]'));
  scenarioButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      var name = button.getAttribute('data-scenario');
      var state = document.querySelector('[data-scenario-state="' + name + '"]');
      var summary = document.querySelector('[data-probe-summary]');
      var result = document.querySelector('[data-probe-result]');

      scenarioButtons.forEach(function (item) { item.disabled = true; });
      state.className = 'scenario-state is-running';
      state.textContent = 'Running...';
      summary.className = 'probe-status is-running';
      summary.textContent = 'Checking';

      runScenario(name)
        .then(function (outcome) {
          state.className = 'scenario-state is-passed';
          state.textContent = 'Passed';
          summary.className = 'probe-status is-passed';
          summary.textContent = 'Last check passed';
          result.className = 'probe-result is-passed';
          result.hidden = false;
          result.querySelector('[data-probe-title]').textContent = outcome.title;
          result.querySelector('[data-probe-detail]').textContent = outcome.detail;
          result.querySelector('[data-probe-time]').textContent =
            new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          refreshPanels();
        })
        .catch(function (error) {
          state.className = 'scenario-state is-failed';
          state.textContent = 'Failed';
          summary.className = 'probe-status is-failed';
          summary.textContent = 'Attention needed';
          result.className = 'probe-result is-failed';
          result.hidden = false;
          result.querySelector('[data-probe-title]').textContent = 'Check failed';
          result.querySelector('[data-probe-detail]').textContent = error.message;
          result.querySelector('[data-probe-time]').textContent =
            new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        })
        .finally(function () {
          scenarioButtons.forEach(function (item) { item.disabled = false; });
        });
    });
  });

  var commandOverlay = document.querySelector('[data-command-overlay]');
  var commandInput = document.querySelector('[data-command-input]');
  var commandItems = Array.from(document.querySelectorAll('[data-command-item]'));
  var commandEmpty = document.querySelector('[data-command-empty]');
  var visibleCommandItems = commandItems.slice();
  var activeCommandIndex = 0;

  function setActiveCommand(index) {
    visibleCommandItems.forEach(function (item) {
      item.classList.remove('is-selected');
    });
    if (!visibleCommandItems.length) return;
    activeCommandIndex = (index + visibleCommandItems.length) % visibleCommandItems.length;
    visibleCommandItems[activeCommandIndex].classList.add('is-selected');
  }

  function openCommand() {
    commandOverlay.hidden = false;
    document.body.classList.add('command-open');
    commandInput.value = '';
    commandItems.forEach(function (item) { item.hidden = false; });
    visibleCommandItems = commandItems.slice();
    commandEmpty.hidden = true;
    setActiveCommand(0);
    setTimeout(function () { commandInput.focus(); }, 0);
  }

  function closeCommand() {
    commandOverlay.hidden = true;
    document.body.classList.remove('command-open');
  }

  document.querySelector('[data-command-open]').addEventListener('click', openCommand);
  commandOverlay.addEventListener('click', function (event) {
    if (event.target === commandOverlay) closeCommand();
  });

  commandItems.forEach(function (item, index) {
    item.addEventListener('mouseenter', function () {
      var visibleIndex = visibleCommandItems.indexOf(item);
      if (visibleIndex >= 0) setActiveCommand(visibleIndex);
    });
    item.addEventListener('click', closeCommand);
  });

  commandInput.addEventListener('input', function () {
    var query = commandInput.value.trim().toLowerCase();
    visibleCommandItems = commandItems.filter(function (item) {
      var matches = !query || item.getAttribute('data-search').indexOf(query) >= 0;
      item.hidden = !matches;
      return matches;
    });
    commandEmpty.hidden = visibleCommandItems.length !== 0;
    setActiveCommand(0);
  });

  document.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (commandOverlay.hidden) openCommand();
      else closeCommand();
      return;
    }
    if (commandOverlay.hidden) return;
    if (event.key === 'Escape') closeCommand();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveCommand(activeCommandIndex + 1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveCommand(activeCommandIndex - 1);
    }
    if (event.key === 'Enter' && visibleCommandItems[activeCommandIndex]) {
      visibleCommandItems[activeCommandIndex].click();
    }
  });

  buildDiagram();
  connect();
  refreshPanels();
})();
