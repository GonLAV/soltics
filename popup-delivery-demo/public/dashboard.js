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
          '<div class="label">' + spec.label + '</div><div class="last"></div>';
        host.appendChild(box);
        nodes[spec.id] = box;
      });
    });
  }

  function pulse(entry) {
    var box = nodes[entry.node];
    if (!box) return;

    box.classList.add('hot');
    box.querySelector('.last').textContent = entry.message;

    clearTimeout(timers[entry.node]);
    timers[entry.node] = setTimeout(function () {
      box.classList.remove('hot');
    }, 900);
  }

  var logbox = document.querySelector('[data-testid="trace-log"]');

  function appendLog(entry) {
    var line = document.createElement('div');
    var time = new Date(entry.at).toLocaleTimeString();
    line.innerHTML =
      '<span class="stage">[' + time + ' ' + entry.node + ']</span> ' + entry.message;
    logbox.appendChild(line);
    while (logbox.childElementCount > 300) logbox.removeChild(logbox.firstChild);
    logbox.scrollTop = logbox.scrollHeight;
  }

  function connect() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var socket = new WebSocket(protocol + '//' + window.location.host + '/ws/inspector');

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
          var badge = document.createElement('span');
          badge.className = 'badge' + (campaign.status === 'active' ? ' active' : '');
          badge.textContent = campaign.status;

          var toggle = document.createElement('button');
          toggle.className = 'ghost';
          toggle.style.marginLeft = '8px';
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
          cell.innerHTML = '<b>' + pair[1] + '</b>' + pair[0];
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
