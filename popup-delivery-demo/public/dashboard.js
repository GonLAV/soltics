/**
 * Flow inspector — renders the architecture diagram and lights each box as the
 * backend traces activity through it over /ws/inspector.
 *
 * Enhanced: scenario triggers, live decision detail, reason distribution,
 * fire counters, and a structured delivery timeline.
 */
(function () {
  'use strict';

  var LAYOUT = {
    client: [{ id: 'sdk', label: 'Solitics SDK' }],
    backend: [
      { id: 'api', label: 'API Layer (REST)' },
      { id: 'ingestion', label: 'Event Ingestion' },
      { id: 'profile', label: 'Profile & Segmentation' },
      { id: 'realtime', label: 'Real-time Server (WS)' },
    ],
    engine: [
      { id: 'campaign-manager', label: 'Campaign Manager' },
      { id: 'rules', label: 'Audience & Rules' },
      { id: 'decision', label: 'Decision Engine' },
      { id: 'action-sender', label: 'Action Sender' },
    ],
    stores: [
      { id: 'campaigns-db', label: 'Campaigns DB' },
      { id: 'profiles-db', label: 'User Profiles DB' },
      { id: 'analytics-db', label: 'Analytics DB' },
    ],
  };

  var nodes = {};
  var timers = {};
  var fireCounts = {};
  var reasonCounts = {};
  var lastDecision = null;

  /* ------------------------------------------------------------------ */
  /* Build the diagram with fire counters                                */
  /* ------------------------------------------------------------------ */
  function buildDiagram() {
    Object.keys(LAYOUT).forEach(function (column) {
      var host = document.querySelector('[data-col="' + column + '"]');
      LAYOUT[column].forEach(function (spec) {
        var box = document.createElement('div');
        box.className = 'node';
        box.setAttribute('data-node', spec.id);
        box.innerHTML =
          '<div class="node__head">' +
            '<span class="label">' + spec.label + '</span>' +
            '<span class="node__count" data-count="' + spec.id + '">0</span>' +
          '</div>' +
          '<div class="last"></div>';
        host.appendChild(box);
        nodes[spec.id] = box;
        fireCounts[spec.id] = 0;
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

  function appendLog(entry) {
    var line = document.createElement('div');
    var time = new Date(entry.at).toLocaleTimeString();
    var color = NODE_COLORS[entry.node] || '#95bf47';
    line.innerHTML =
      '<span class="stage" style="color:' + color + '">[' + time + ' ' + entry.node + ']</span> ' +
      entry.message;
    logbox.appendChild(line);
    while (logbox.childElementCount > 300) logbox.removeChild(logbox.firstChild);
    logbox.scrollTop = logbox.scrollHeight;
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
    });

    socket.addEventListener('message', function (event) {
      var message = JSON.parse(event.data);

      if (message.type === 'backlog') {
        message.entries.forEach(function (entry) {
          appendLog(entry);
          pulse(entry);
        });
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
      setTimeout(connect, 1000);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Campaign + analytics panels                                         */
  /* ------------------------------------------------------------------ */
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
          row.className = 'campaign';
          row.setAttribute('data-campaign-row', campaign.id);

          var left = document.createElement('div');
          left.innerHTML =
            '<div><strong>' + campaign.name + '</strong></div>' +
            '<div class="price">on ' + campaign.trigger.event +
            ' → [' + (campaign.audience.segments.join(', ') || 'everyone') + ']</div>';

          var right = document.createElement('div');
          right.style.display = 'flex';
          right.style.alignItems = 'center';
          right.style.gap = '8px';

          var badge = document.createElement('span');
          badge.className = 'badge' + (campaign.status === 'active' ? ' active' : '');
          badge.textContent = campaign.status;

          var toggle = document.createElement('button');
          toggle.className = 'ghost';
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
          host.appendChild(cell);
        });
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
      refreshPanels();
    });
  });

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */
  buildDiagram();
  connect();
  refreshPanels();
})();
