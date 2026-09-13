/**
 * Flow inspector — renders the architecture diagram and lights each box as the
 * backend traces activity through it over /ws/inspector.
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

  // Heuristic only — the trace bus carries no severity field, so a node is
  // flagged "warn" when its own message reads like a rejection. Purely a
  // presentation touch; nothing here feeds back into the delivery path.
  var WARN_PATTERN = /reject|declin|miss|error|fail|invalid/i;

  var nodes = {};
  var timers = {};

  function buildDiagram() {
    Object.keys(LAYOUT).forEach(function (column) {
      var host = document.querySelector('[data-col="' + column + '"]');
      LAYOUT[column].forEach(function (spec) {
        var box = document.createElement('div');
        box.className = 'node';
        box.setAttribute('data-node', spec.id);
        box.innerHTML =
          '<div class="node__head">' +
          '<span class="status-dot"></span>' +
          '<span class="node__label">' + spec.label + '</span>' +
          '<span class="node__time"></span>' +
          '</div>' +
          '<div class="node__meta"></div>';
        host.appendChild(box);
        nodes[spec.id] = box;
      });
    });
  }

  function pulse(entry) {
    var box = nodes[entry.node];
    if (!box) return;

    var isWarn = WARN_PATTERN.test(entry.message);
    box.classList.add('hot', 'is-hot');
    box.classList.toggle('is-warn', isWarn);
    box.querySelector('.node__meta').textContent = entry.message;
    box.querySelector('.node__time').textContent = new Date(entry.at).toLocaleTimeString();

    clearTimeout(timers[entry.node]);
    timers[entry.node] = setTimeout(function () {
      box.classList.remove('hot', 'is-hot', 'is-warn');
    }, 900);
  }

  var logbox = document.querySelector('[data-testid="trace-log"]');

  function appendLog(entry) {
    var line = document.createElement('div');
    var time = new Date(entry.at).toLocaleTimeString();
    var warnClass = WARN_PATTERN.test(entry.message) ? ' warn' : '';
    line.innerHTML =
      '<span class="stage' + warnClass + '">[' + time + ' ' + entry.node + ']</span> ' + entry.message;
    logbox.appendChild(line);
    while (logbox.childElementCount > 300) logbox.removeChild(logbox.firstChild);
    logbox.scrollTop = logbox.scrollHeight;
  }

  var wsDot = document.querySelector('[data-testid="inspector-ws-dot"]');
  var wsLabel = document.querySelector('[data-testid="inspector-ws-label"]');

  function setConnState(state) {
    if (!wsDot || !wsLabel) return;
    wsDot.classList.toggle('is-live', state === 'live');
    wsLabel.textContent = state === 'live' ? 'live' : state === 'reconnecting' ? 'reconnecting…' : 'connecting…';
  }

  function connect() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var socket = new WebSocket(protocol + '//' + window.location.host + '/ws/inspector');

    socket.addEventListener('open', function () {
      setConnState('live');
    });

    socket.addEventListener('message', function (event) {
      var message = JSON.parse(event.data);

      if (message.type === 'backlog') {
        message.entries.forEach(appendLog);
        return;
      }

      if (message.type === 'trace') {
        pulse(message.entry);
        appendLog(message.entry);
        refreshPanelsSoon();
      }
    });

    socket.addEventListener('close', function () {
      // The dev server restarts often; retry quietly.
      setConnState('reconnecting');
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
          row.className = 'campaign-row';
          row.setAttribute('data-campaign-row', campaign.id);

          var left = document.createElement('div');
          left.innerHTML =
            '<div><strong>' + campaign.name + '</strong></div>' +
            '<div class="campaign-row__meta">on ' + campaign.trigger.event +
            ' → [' + (campaign.audience.segments.join(', ') || 'everyone') + ']</div>';

          var right = document.createElement('div');
          right.className = 'campaign-row__right';
          var badge = document.createElement('span');
          badge.className = 'badge' + (campaign.status === 'active' ? ' active' : '');
          badge.textContent = campaign.status;

          var toggle = document.createElement('button');
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

        [
          ['events', byType.event || 0],
          ['delivered', byType.campaign_delivered || 0],
          ['duplicates', byType.campaign_delivered_duplicate || 0],
        ].forEach(function (pair) {
          var cell = document.createElement('div');
          cell.className = 'stat';
          cell.innerHTML = '<b>' + pair[1] + '</b><span>' + pair[0] + '</span>';
          host.appendChild(cell);
        });
      });
  }

  document.querySelector('[data-testid="reset-state"]').addEventListener('click', function (event) {
    event.preventDefault();
    fetch('/api/v1/admin/reset', { method: 'POST' }).then(function () {
      logbox.innerHTML = '';
      refreshPanels();
    });
  });

  buildDiagram();
  connect();
  refreshPanels();
})();
