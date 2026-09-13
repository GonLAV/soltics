/**
 * Live flow inspector. Subscribes to the internal trace bus over
 * /ws/inspector and maps each entry onto the architecture diagram, the
 * activity feed and the KPI row. Purely observability — nothing here
 * feeds back into the delivery path.
 * Flow inspector — renders the architecture diagram and lights each box as the
 * backend traces activity through it over /ws/inspector.
 *
 * Enhanced: scenario triggers, live decision detail, reason distribution,
 * fire counters, and a structured delivery timeline.
 * Live journey dashboard. It maps backend trace events to the visual
 * orchestration stages while keeping campaign and KPI data in sync.
 */
(function () {
  'use strict';

  var NODE_META = {
    sdk: { label: 'Storefront SDK', icon: 'cursor' },
    api: { label: 'API layer', icon: 'brackets' },
    ingestion: { label: 'Event ingestion', icon: 'inbox' },
    profile: { label: 'Profile & segmentation', icon: 'user' },
    realtime: { label: 'Real-time server', icon: 'signal' },
    'campaign-manager': { label: 'Campaign manager', icon: 'campaign' },
    rules: { label: 'Audience & rules', icon: 'filter' },
    decision: { label: 'Decision engine', icon: 'spark' },
    'action-sender': { label: 'Action sender', icon: 'send' },
    'campaigns-db': { label: 'Campaigns DB', icon: 'database' },
    'profiles-db': { label: 'User profiles DB', icon: 'database' },
    'analytics-db': { label: 'Analytics DB', icon: 'database' },
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
    cart: '<circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/><path d="M3 4h2l2.4 11h10.8l2-7H6"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9L12 3Z"/>',
    tag: '<path d="M20 13 13 20 4 11V4h7l9 9ZM8.5 8.5h.01"/>',
  };

  // Heuristic only — the trace bus carries no severity field, so a node is
  // flagged "warn" when its own message reads like a rejection. Presentation
  // only; nothing here feeds back into the delivery path.
  var WARN_PATTERN = /reject|declin|miss|error|fail|invalid/i;

  var nodes = {};
  var timers = {};
  var fireCounts = {};
  var reasonCounts = {};
  var lastDecision = null;
  var recentEntries = [];
  var refreshTimer = null;
  var logbox = document.querySelector('[data-testid="trace-log"]');
  var emptyState = document.querySelector('[data-empty-state]');

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || ICONS.spark) + '</svg>';
  }

  /* ------------------------------------------------------------------ */
  /* Build the diagram with fire counters                                */
  /* ------------------------------------------------------------------ */
  function buildDiagram() {
    Object.keys(LAYOUT).forEach(function (column) {
      var host = document.querySelector('[data-col="' + column + '"]');
      LAYOUT[column].forEach(function (id) {
        var meta = NODE_META[id];
        var box = document.createElement('div');
        box.className = 'node';
        box.setAttribute('data-node', id);
        box.innerHTML =
          '<div class="node__head">' +
            '<span class="label">' + spec.label + '</span>' +
            '<span class="node__count" data-count="' + spec.id + '">0</span>' +
          '</div>' +
          '<div class="last"></div>';
        host.appendChild(box);
        nodes[spec.id] = box;
        fireCounts[spec.id] = 0;
          '<span class="status-dot"></span>' +
          '<span class="node__label">' + meta.label + '</span>' +
          '<span class="node__time"></span>' +
          '</div>' +
          '<div class="node__meta">Ready</div>';
        host.appendChild(box);
        nodes[id] = box;
      });
    });
  }

  function pulse(entry) {
    var box = nodes[entry.node];
    if (!box) return;

    fireCounts[entry.node] = (fireCounts[entry.node] || 0) + 1;
    var countEl = document.querySelector('[data-count="' + entry.node + '"]');
    if (countEl) countEl.textContent = fireCounts[entry.node];

    box.classList.add('hot');
    box.querySelector('.last').textContent = entry.message;

    clearTimeout(timers[entry.node]);
    timers[entry.node] = setTimeout(function () {
      box.classList.remove('hot');
    }, 1200);
  }

  /* ------------------------------------------------------------------ */
  /* Trace log with color-coded node types                                */
  /* ------------------------------------------------------------------ */
  var NODE_COLORS = {
    'sdk': '#95bf47',
    'api': '#008060',
    'ingestion': '#008060',
    'profile': '#008060',
    'realtime': '#6b4fd8',
    'campaign-manager': '#008060',
    'rules': '#e34850',
    'decision': '#008060',
    'action-sender': '#95bf47',
    'campaigns-db': '#616066',
    'profiles-db': '#616066',
    'analytics-db': '#616066',
  };

  var logbox = document.querySelector('[data-testid="trace-log"]');
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
    if (emptyState && emptyState.parentNode) emptyState.remove();
    recentEntries.unshift(entry);
    recentEntries = recentEntries.slice(0, 50);

    var line = document.createElement('div');
    var time = new Date(entry.at).toLocaleTimeString();
    var color = NODE_COLORS[entry.node] || '#95bf47';
    line.innerHTML =
      '<span class="stage" style="color:' + color + '">[' + time + ' ' + entry.node + ']</span> ' +
      entry.message;
    var warnClass = WARN_PATTERN.test(entry.message) ? ' warn' : '';
    line.innerHTML =
      '<span class="stage' + warnClass + '">[' + time + ' ' + entry.node + ']</span> ' + entry.message;
    logbox.appendChild(line);
    while (logbox.childElementCount > 300) logbox.removeChild(logbox.firstChild);
    logbox.scrollTop = logbox.scrollHeight;
    var time = new Date(entry.at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    var row = document.createElement('div');
    row.className = 'activity-row' + (isWarn ? ' is-warn' : '');
    row.innerHTML =
      '<span class="node-tag">' + escapeHtml(meta.label) + '</span>' +
      '<span class="msg">' + escapeHtml(entry.message) + '</span>' +
      '<time>' + time + '</time>';

    logbox.insertBefore(row, logbox.firstChild);
    while (logbox.childElementCount > 60) logbox.removeChild(logbox.lastChild);

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

  /* ------------------------------------------------------------------ */
  /* Decision detail — parse decision traces to show per-campaign results */
  /* ------------------------------------------------------------------ */
  function categorizeReason(reason) {
    if (!reason) return 'unknown';
    if (reason.startsWith('trigger mismatch')) return 'trigger mismatch';
    if (reason.includes('audience')) return 'audience miss';
    if (reason.includes('condition')) return 'condition failed';
    if (reason.includes('frequency cap')) return 'frequency cap';
    if (reason.includes('segment match') || reason.includes('passed') || reason.includes('never delivered') || reason.includes('within')) return 'triggered';
    return 'other';
  }

  function updateDecisionDetail(entry) {
    if (entry.node !== 'decision') return;

    var data = entry.data || {};
    var skipped = data.skipped || [];
    var triggered = [];
    var match = entry.message.match(/TRIGGER\s+(.+)/);
    if (match) {
      triggered = match[1].split(',').map(function (s) { return s.trim(); });
    }

    var host = document.querySelector('[data-testid="decision-detail"]');
    host.innerHTML = '';

    var allCampaigns = [];

    triggered.forEach(function (id) {
      allCampaigns.push({ id: id, triggered: true, reason: 'matched audience + conditions' });
    });

    skipped.forEach(function (skip) {
      allCampaigns.push({ id: skip.campaignId, triggered: false, reason: skip.reason });
    });

    if (allCampaigns.length === 0) {
      host.innerHTML = '<div class="decision-empty">No campaigns evaluated.</div>';
      return;
    }

    // Event label
    var eventMatch = entry.message.match(/"([^"]+)"/);
    var eventLabel = document.createElement('div');
    eventLabel.className = 'decision-event';
    eventLabel.textContent = eventMatch ? 'Event: ' + eventMatch[1] : 'Event: unknown';
    host.appendChild(eventLabel);

    allCampaigns.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'decision-row' + (c.triggered ? ' decision-row--triggered' : ' decision-row--skipped');

      var status = document.createElement('span');
      status.className = 'decision-row__status';
      status.textContent = c.triggered ? 'TRIGGER' : 'SKIP';

      var name = document.createElement('span');
      name.className = 'decision-row__name';
      name.textContent = c.id;

      var reason = document.createElement('div');
      reason.className = 'decision-row__reason';
      reason.textContent = c.reason;

      row.appendChild(status);
      row.appendChild(name);
      row.appendChild(reason);
      host.appendChild(row);

      // Track reason distribution
      var cat = c.triggered ? 'triggered' : categorizeReason(c.reason);
      reasonCounts[cat] = (reasonCounts[cat] || 0) + 1;
    });

    updateReasonDistribution();
  }

  function updateReasonDistribution() {
    var host = document.querySelector('[data-testid="reason-distribution"]');
    var total = 0;
    Object.keys(reasonCounts).forEach(function (k) { total += reasonCounts[k]; });
    if (total === 0) {
      host.innerHTML = '<div class="decision-empty">No decisions evaluated yet.</div>';
      return;
    }

    var categories = [
      { key: 'triggered', label: 'Triggered', color: '#008060' },
      { key: 'audience miss', label: 'Audience miss', color: '#e34850' },
      { key: 'condition failed', label: 'Condition failed', color: '#e34850' },
      { key: 'frequency cap', label: 'Frequency cap', color: '#e34850' },
      { key: 'trigger mismatch', label: 'Trigger mismatch', color: '#b3b3b3' },
      { key: 'other', label: 'Other', color: '#b3b3b3' },
    ];

    host.innerHTML = '';
    categories.forEach(function (cat) {
      var count = reasonCounts[cat.key] || 0;
      if (count === 0) return;
      var pct = Math.round((count / total) * 100);

      var bar = document.createElement('div');
      bar.className = 'reason-bar';
      bar.innerHTML =
        '<div class="reason-bar__head">' +
          '<span>' + cat.label + '</span>' +
          '<span class="reason-bar__count">' + count + ' (' + pct + '%)</span>' +
        '</div>' +
        '<div class="reason-bar__track">' +
          '<div class="reason-bar__fill" style="width:' + pct + '%;background:' + cat.color + '"></div>' +
        '</div>';
      host.appendChild(bar);
    });

    var totalEl = document.createElement('div');
    totalEl.className = 'reason-total';
    totalEl.textContent = total + ' total decisions evaluated';
    host.appendChild(totalEl);
  }

  /* ------------------------------------------------------------------ */
  /* WebSocket connection                                                */
  /* ------------------------------------------------------------------ */
  var wsStatusDot = document.querySelector('.ws-status__dot');
  var wsStatusText = document.querySelector('.ws-status__text');

  function setWsStatus(connected) {
    if (connected) {
      wsStatusDot.classList.add('ws-status__dot--live');
      wsStatusText.textContent = 'live';
    } else {
      wsStatusDot.classList.remove('ws-status__dot--live');
      wsStatusText.textContent = 'reconnecting…';
    }
  }

  function connect() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var socket = new WebSocket(protocol + '//' + window.location.host + '/ws/inspector');

    socket.addEventListener('open', function () {
      setWsStatus(true);
      setConnState('live');
      setConnection(true);
    });

    socket.addEventListener('message', function (event) {
      var message = JSON.parse(event.data);

      if (message.type === 'backlog') {
        message.entries.slice(-15).forEach(appendLog);
        message.entries.forEach(function (entry) {
          appendLog(entry);
          pulse(entry);
        });
        message.entries.slice(-12).forEach(appendLog);
        return;
      }

      if (message.type === 'trace') {
        pulse(message.entry);
        appendLog(message.entry);
        updateDecisionDetail(message.entry);
        refreshPanelsSoon();
      }
    });

    socket.addEventListener('close', function () {
      setWsStatus(false);
      // The dev server restarts often; retry quietly.
      setConnState('reconnecting');
      setConnection(false);
      setTimeout(connect, 1000);
    });
  }

  var refreshTimer = null;
  function refreshPanelsSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshPanels, 250);
  }

  function refreshPanels() {
    fetch('/api/v1/campaigns')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var host = document.querySelector('[data-testid="campaign-list"]');
        host.innerHTML = '';

        data.campaigns.forEach(function (campaign) {
          var row = document.createElement('div');
          row.className = 'campaign-row';
          row.setAttribute('data-campaign-row', campaign.id);

          var left = document.createElement('div');
          left.innerHTML =
            '<div><strong>' + campaign.name + '</strong></div>' +
            '<div class="campaign-row__meta">on ' + campaign.trigger.event +
            ' → [' + (campaign.audience.segments.join(', ') || 'everyone') + ']</div>';

          var right = document.createElement('div');
          right.style.display = 'flex';
          right.style.alignItems = 'center';
          right.style.gap = '8px';

          right.className = 'campaign-row__right';
          var badge = document.createElement('span');
          badge.className = 'badge' + (campaign.status === 'active' ? ' active' : '');
          badge.textContent = campaign.status;

          var toggle = document.createElement('button');
          toggle.className = 'ghost';
          toggle.className = 'btn btn--ghost btn--sm';
          toggle.textContent = campaign.status === 'active' ? 'Pause' : 'Activate';
          toggle.addEventListener('click', function () {
            fetch('/api/v1/campaigns/' + campaign.id + '/status', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                status: campaign.status === 'active' ? 'paused' : 'active',
              }),
            }).then(refreshPanels);
          });

          right.appendChild(badge);
          right.appendChild(toggle);
          row.appendChild(left);
          row.appendChild(right);
          host.appendChild(row);
        });
      });

    fetch('/api/v1/analytics?limit=1')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var byType = data.summary.byType;
        var host = document.querySelector('[data-testid="analytics"]');
        host.innerHTML = '';

        var events = byType.event || 0;
        var delivered = byType.campaign_delivered || 0;
        var duplicates = byType.campaign_delivered_duplicate || 0;
        var deliveryRate = events > 0 ? Math.round((delivered / events) * 100) : 0;

        [
          ['events', events],
          ['delivered', delivered],
          ['delivery rate', deliveryRate + '%'],
          ['duplicates', duplicates],
        ].forEach(function (pair) {
          var cell = document.createElement('div');
          cell.className = 'stat-cell';
          cell.innerHTML = '<b>' + pair[1] + '</b>' + pair[0];
          cell.className = 'stat';
          cell.innerHTML = '<b>' + pair[1] + '</b><span>' + pair[0] + '</span>';
          host.appendChild(cell);
        });
  function campaignIcon(campaign) {
    if (campaign.trigger.event === 'add_to_cart') return 'cart';
    if (campaign.audience.segments.indexOf('vip') >= 0) return 'star';
    return 'tag';
  }

  function renderCampaigns(campaigns) {
    var host = document.querySelector('[data-testid="campaign-list"]');
    host.innerHTML = '';

    campaigns.forEach(function (campaign) {
      var segment = campaign.audience.segments.join(', ') || 'All visitors';
      var trigger = campaign.trigger.event.replace(/_/g, ' ');
      var isActive = campaign.status === 'active';

      var row = document.createElement('div');
      row.className = 'campaign-row';
      row.setAttribute('data-campaign-row', campaign.id);
      row.innerHTML =
        '<div>' +
        '<div class="campaign-row__name">' + icon(campaignIcon(campaign)) + escapeHtml(campaign.name) + '</div>' +
        '<div class="campaign-row__meta">on ' + escapeHtml(trigger) + ' → [' + escapeHtml(segment) + ']</div>' +
        '</div>';

      var right = document.createElement('div');
      right.className = 'campaign-row__right';

      var badge = document.createElement('span');
      badge.className = 'badge' + (isActive ? ' active' : ' paused');
      badge.textContent = campaign.status;

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn btn--ghost btn--sm';
      toggle.textContent = isActive ? 'Pause' : 'Activate';
      toggle.addEventListener('click', function () {
        toggle.disabled = true;
        fetch('/api/v1/campaigns/' + campaign.id + '/status', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: isActive ? 'paused' : 'active' }),
        }).then(refreshPanels);
      });

      right.appendChild(badge);
      right.appendChild(toggle);
      row.appendChild(right);
      host.appendChild(row);
    });
  }

  function setMetric(name, value) {
    var element = document.querySelector('[data-metric="' + name + '"]');
    if (element) element.textContent = value;
  }

  function refreshPanels() {
    Promise.all([
      fetch('/api/v1/campaigns').then(function (r) { return r.json(); }),
      fetch('/api/v1/analytics?limit=1').then(function (r) { return r.json(); }),
      fetch('/api/v1/health').then(function (r) { return r.json(); }),
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

  /* ------------------------------------------------------------------ */
  /* Scenario triggers                                                    */
  /* ------------------------------------------------------------------ */
  var scenarioUrls = {
    'eligible': function () {
      return '/?userId=qa-demo-eligible-' + Date.now();
    },
    'non-eligible': function () {
      return '/?testUser=non-eligible&userId=qa-demo-non-eligible-' + Date.now();
    },
    'duplicate': function () {
      return '/?testScenario=duplicate-delivery&userId=qa-demo-dup-' + Date.now();
    },
    'cart': function () {
      return '/?userId=qa-demo-cart-' + Date.now();
    },
  };

  document.querySelectorAll('[data-scenario]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var scenario = btn.getAttribute('data-scenario');
      var url = scenarioUrls[scenario] ? scenarioUrls[scenario]() : '/';
      window.open(url, '_blank');
    });
  });

  /* ------------------------------------------------------------------ */
  /* Reset                                                               */
  /* ------------------------------------------------------------------ */
  document.querySelector('[data-testid="reset-state"]').addEventListener('click', function (event) {
    event.preventDefault();
    fetch('/api/v1/admin/reset', { method: 'POST' }).then(function () {
      logbox.innerHTML = '';
      // Reset all counters
      Object.keys(fireCounts).forEach(function (k) { fireCounts[k] = 0; });
      document.querySelectorAll('[data-count]').forEach(function (el) {
        el.textContent = '0';
      });
      reasonCounts = {};
      document.querySelector('[data-testid="decision-detail"]').innerHTML =
        '<div class="decision-empty">No events yet — trigger a scenario to see decisions.</div>';
      updateReasonDistribution();
  function showToast() {
    var toast = document.querySelector('[data-toast]');
    toast.classList.add('is-visible');
    setTimeout(function () { toast.classList.remove('is-visible'); }, 2600);
  }

  document.querySelector('[data-testid="reset-state"]').addEventListener('click', function () {
    fetch('/api/v1/admin/reset', { method: 'POST' }).then(function () {
      logbox.innerHTML =
        '<div class="activity-empty" data-empty-state>' +
        '<span><svg viewBox="0 0 24 24"><path d="M4 17h3l2-10 4 14 2-9 2 5h3"/></svg></span>' +
        '<b>Your live events will appear here</b>' +
        '<small>Open the storefront and add a product to begin.</small></div>';
      emptyState = document.querySelector('[data-empty-state]');
      var lastEvent = document.querySelector('[data-last-event]');
      if (lastEvent) lastEvent.textContent = 'Waiting for an event';
      showToast();
      refreshPanels();
    });
  });

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */
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
