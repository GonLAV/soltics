/**
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
    // The Decision Engine reads campaignsDb directly, so this node only
    // traces when a campaign is authored or paused — never on the event
    // path. Labelled so a permanently idle box does not read as a fault.
    'campaign-manager': {
      label: 'Campaign manager',
      icon: 'campaign',
      note: 'Authoring · not on event path',
    },
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
          '<span class="node-icon">' + icon(meta.icon) + '</span>' +
          '<span class="node-copy"><b>' + meta.label + '</b><small class="last">' +
          (meta.note || 'Ready') + '</small></span>' +
          '<span class="node-state"></span>';
        host.appendChild(box);
        nodes[id] = box;
      });
    });
  }

  // The backend answers a page view in a few milliseconds, so pulsing each
  // trace the instant it arrives lights all twelve nodes inside one frame —
  // a flash, not a flow. Entries are queued instead and replayed one step at
  // a time, which is what makes the path through the system legible.
  var queue = [];
  var draining = false;
  var stepMs = 380;

  // Which stage column each node belongs to, so the connector between two
  // stages can animate as the flow crosses it, plus a rank for left-to-right
  // ordering within the diagram.
  var STAGE_OF = {};
  var RANK_OF = {};
  var rank = 0;
  Object.keys(LAYOUT).forEach(function (column, index) {
    LAYOUT[column].forEach(function (id) {
      STAGE_OF[id] = index;
      RANK_OF[id] = rank++;
    });
  });
  var lastStage = -1;

  // One event produces its traces as a burst, but not in diagram order — the
  // stores are written to midway through, so raw arrival order sends the
  // highlight jumping backwards. Each burst is buffered briefly and sorted by
  // position in the diagram, so the highlight sweeps left to right.
  // The activity log below is appended in true arrival order and is untouched
  // by this: the log is the record, the diagram is the guided tour.
  var incoming = [];
  var flushTimer = null;

  function enqueue(entry) {
    appendLog(entry);
    refreshPanelsSoon();

    if (!nodes[entry.node]) return;
    incoming.push(entry);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushIncoming, 90);
  }

  function flushIncoming() {
    incoming.sort(function (a, b) { return RANK_OF[a.node] - RANK_OF[b.node]; });
    for (var i = 0; i < incoming.length; i++) queue.push(incoming[i]);
    incoming = [];
    if (!draining) drain();
  }

  function drain() {
    if (!queue.length) {
      draining = false;
      return;
    }
    draining = true;

    pulse(queue.shift());

    // A burst must never fall behind the live system: the more that is
    // waiting, the faster the replay runs.
    var step = stepMs === 0 ? 0 : Math.max(70, stepMs - queue.length * 25);
    setTimeout(drain, step);
  }

  function flowConnector(stage) {
    if (stage <= lastStage) {
      lastStage = stage;
      return;
    }
    var connectors = document.querySelectorAll('.journey-connector');
    for (var i = lastStage; i < stage && i < connectors.length; i++) {
      if (i < 0) continue;
      (function (el) {
        el.classList.remove('is-flowing');
        void el.offsetWidth; // restart the animation
        el.classList.add('is-flowing');
        setTimeout(function () { el.classList.remove('is-flowing'); }, 900);
      })(connectors[i]);
    }
    lastStage = stage;
  }

  function pulse(entry) {
    var box = nodes[entry.node];
    if (!box) return;

    // One highlight at a time. Several nodes lit at once reads as noise
    // rather than as a request moving through the system, so whatever was
    // active is demoted to its completed state first.
    Object.keys(nodes).forEach(function (id) {
      if (id === entry.node) return;
      var other = nodes[id];
      if (other.classList.contains('is-active')) {
        clearTimeout(timers[id]);
        other.classList.remove('is-active');
        other.classList.add('is-done');
      }
    });

    box.classList.remove('is-done');
    box.classList.add('is-active');
    box.querySelector('.last').textContent = entry.message;

    if (STAGE_OF[entry.node] !== undefined) flowConnector(STAGE_OF[entry.node]);

    // Settle into a resting "completed" state and stay there. Clearing back
    // to blank made the panel look dead between events.
    clearTimeout(timers[entry.node]);
    timers[entry.node] = setTimeout(function () {
      box.classList.remove('is-active');
      box.classList.add('is-done');
    }, Math.max(stepMs + 240, 620));
  }

  function setPace(value) {
    stepMs = Number(value) || 0;
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
        // History fills the activity log only. Lighting the diagram from the
        // backlog left nine of twelve nodes already marked complete before
        // anything had happened, so the first live event had nothing visible
        // to change — the panel has to start at rest.
        message.entries.slice(-12).forEach(appendLog);
        return;
      }

      if (message.type === 'trace') {
        enqueue(message.entry);
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

  function renderDecisionSummary(summary) {
    var reasons = summary.byDecisionReason || {};
    var total = Object.keys(reasons).reduce(function (sum, key) {
      return sum + reasons[key];
    }, 0);
    var triggered = reasons.ELIGIBLE || 0;
    var blocked = Math.max(total - triggered, 0);

    document.querySelector('[data-decision-total]').textContent = total.toLocaleString();
    document.querySelector('[data-decision-triggered]').textContent = triggered.toLocaleString();
    document.querySelector('[data-decision-blocked]').textContent = blocked.toLocaleString();

    var labels = {
      ELIGIBLE: 'Qualified',
      AUDIENCE_MISMATCH: 'Audience mismatch',
      CONDITION_FAILED: 'Condition failed',
      FREQUENCY_CAP: 'Frequency cap',
      TRIGGER_MISMATCH: 'Trigger mismatch',
      INVALID_CONDITION: 'Invalid condition',
    };
    var order = [
      'ELIGIBLE',
      'AUDIENCE_MISMATCH',
      'CONDITION_FAILED',
      'FREQUENCY_CAP',
      'TRIGGER_MISMATCH',
      'INVALID_CONDITION',
    ];
    var host = document.querySelector('[data-reason-list]');
    var populated = order.filter(function (reason) { return reasons[reason]; });

    if (!populated.length) {
      host.innerHTML =
        '<div class="reason-empty">Run a shopper journey or synthetic check to populate decision evidence.</div>';
      return;
    }

    host.innerHTML = populated.map(function (reason) {
      var count = reasons[reason];
      var width = total ? Math.max(5, Math.round((count / total) * 100)) : 0;
      return '<div class="reason-row">' +
        '<div><span><i class="reason-dot reason-dot--' + reason.toLowerCase() + '"></i>' +
        escapeHtml(labels[reason] || reason) + '</span><b>' + count + '</b></div>' +
        '<div class="reason-track"><i style="width:' + width + '%"></i></div></div>';
    }).join('');
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

      // Delivery rate is "of the decisions that said yes, how many reached the
      // user" — not deliveries over all events. Dividing by `event` counted
      // popup_displayed and popup_closed in the denominator, so a journey
      // where every delivery succeeded still read 33%.
      var eligible = (analyticsData.summary.byDecisionReason || {}).ELIGIBLE || 0;
      var rate = eligible ? Math.round((delivered / eligible) * 100) : 0;

      renderCampaigns(campaignData.campaigns);
      setMetric('events', events.toLocaleString());
      setMetric('delivered', delivered.toLocaleString());
      setMetric('profiles', healthData.profiles.toLocaleString());
      setMetric('delivery-rate', rate + '%');
      renderDecisionSummary(analyticsData.summary);

      var metricBar = document.querySelector('[data-metric-bar]');
      if (metricBar) metricBar.style.width = Math.min(rate, 100) + '%';
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

  var paceSelect = document.querySelector('[data-pace]');
  if (paceSelect) {
    setPace(paceSelect.value);
    paceSelect.addEventListener('change', function () { setPace(paceSelect.value); });
  }

  buildDiagram();
  connect();
  refreshPanels();
})();
