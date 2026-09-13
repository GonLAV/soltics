/**
 * Live flow inspector. Subscribes to the internal trace bus over
 * /ws/inspector and maps each entry onto the architecture diagram, the
 * activity feed and the KPI row. Purely observability — nothing here
 * feeds back into the delivery path.
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
        return;
      }

      if (message.type === 'trace') {
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

  var refreshTimer = null;
  function refreshPanelsSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshPanels, 250);
  }

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

  buildDiagram();
  connect();
  refreshPanels();
})();
