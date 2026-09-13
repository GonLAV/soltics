/**
 * Solitics SDK (mock) — the "Client Browser" column of the architecture.
 *
 *   1. Initialize      POST /api/v1/sdk/init   -> sessionId + config
 *   2. Collect events  POST /api/v1/events     -> ack with engine decisions
 *   3. Real-time       ws://host/ws?sessionId= -> campaign instructions
 *   4. Render popup    idempotent per delivery
 *
 * Rendering is deliberately idempotent: the transport is at-least-once, so a
 * duplicated campaign instruction must never produce a second popup.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'solitics_user_id';

  var state = {
    userId: null,
    sessionId: null,
    connected: false,
    socket: null,
    renderedDeliveries: new Set(),
    renderedCampaigns: new Set(),
    log: [],
  };

  /* ------------------------------------------------------------------ */
  /* Debug log — mirrored onto the page and to window for assertions     */
  /* ------------------------------------------------------------------ */
  function log(stage, message, data) {
    var entry = { at: Date.now(), stage: stage, message: message, data: data || null };
    state.log.push(entry);
    document.dispatchEvent(new CustomEvent('solitics:log', { detail: entry }));
    return entry;
  }

  function getUserId(params) {
    // Explicit override wins, so a test can pin a known user id.
    var forced = params.get('userId');
    if (forced) return forced;

    var stored = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      /* private mode — fall through to an ephemeral id */
    }
    if (stored) return stored;

    var generated =
      'user-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
    try {
      window.localStorage.setItem(STORAGE_KEY, generated);
    } catch (error) {
      /* ignore */
    }
    return generated;
  }

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

  /* ------------------------------------------------------------------ */
  /* Popup rendering                                                     */
  /* ------------------------------------------------------------------ */
  function renderPopup(message) {
    var deliveryId = message.deliveryId;
    var campaignId = message.campaignId;

    // Three layers of de-duplication: same delivery, same campaign, and a
    // single popup slot in the DOM at any time.
    if (deliveryId && state.renderedDeliveries.has(deliveryId)) {
      // Phrased so the line reads as the pass it is. On screen this sits next
      // to a visible popup, which looks like a contradiction until you see
      // that the popup carries this very deliveryId — it is the second copy
      // that was dropped, not the first.
      log('sdk', 'Ignored duplicate delivery ' + deliveryId.slice(0, 8) +
        ' — still 1 popup on screen');
      return;
    }
    if (campaignId && state.renderedCampaigns.has(campaignId)) {
      log('sdk', 'Ignored repeat campaign ' + campaignId);
      return;
    }
    if (document.querySelector('[data-testid="campaign-popup"]')) {
      log('sdk', 'Popup slot already occupied — skipping render');
      return;
    }

    if (deliveryId) state.renderedDeliveries.add(deliveryId);
    if (campaignId) state.renderedCampaigns.add(campaignId);

    var payload = message.payload || {};
    var title = payload.title || 'Special Offer!';
    var body = payload.message || 'Get 20% off';
    var cta = payload.cta || 'Close';

    var popup = document.createElement('div');
    popup.className = 'popup';
    popup.setAttribute('data-testid', 'campaign-popup');
    popup.setAttribute('data-campaign-id', campaignId || '');
    popup.setAttribute('data-delivery-id', deliveryId || '');

    var content = document.createElement('div');
    content.className = 'popup__content';

    var eyebrow = document.createElement('p');
    eyebrow.className = 'popup__eyebrow';
    eyebrow.textContent = 'A little something for you';

    var heading = document.createElement('h2');
    heading.className = 'popup__title';
    heading.textContent = title;

    var description = document.createElement('p');
    description.className = 'popup__message';
    description.textContent = body;

    var actions = document.createElement('div');
    actions.className = 'popup__actions';

    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('data-testid', 'popup-close');
    close.textContent = cta;

    var note = document.createElement('span');
    note.textContent = 'Applied automatically';

    actions.appendChild(close);
    actions.appendChild(note);
    content.appendChild(eyebrow);
    content.appendChild(heading);
    content.appendChild(description);
    content.appendChild(actions);
    popup.appendChild(content);
    document.body.appendChild(popup);

    log('sdk', 'Rendered popup for ' + campaignId, { deliveryId: deliveryId });
    track('popup_displayed', { campaignId: campaignId, deliveryId: deliveryId });

    close.addEventListener('click', function () {
      popup.remove();
      log('sdk', 'Popup closed by user');
      track('popup_closed', { campaignId: campaignId, deliveryId: deliveryId });
    });

    document.dispatchEvent(
      new CustomEvent('solitics:popup', { detail: { campaignId: campaignId, deliveryId: deliveryId } })
    );
  }

  /* ------------------------------------------------------------------ */
  /* Event collection                                                    */
  /* ------------------------------------------------------------------ */
  function track(name, properties) {
    if (!state.sessionId) {
      log('sdk', 'track("' + name + '") before init — dropped');
      return Promise.resolve(null);
    }

    log('sdk', 'REST event "' + name + '"', properties || {});

    return postJson('/api/v1/events', {
      sessionId: state.sessionId,
      event: { name: name, properties: properties || {}, timestamp: Date.now() },
    })
      .then(function (ack) {
        log('sdk', 'Ack for "' + name + '"', ack.results && ack.results[0]);
        return ack;
      })
      .catch(function (error) {
        // An unknown session means the backend lost the state this client was
        // built on — a restart, or an operator reset. Swallowing it left the
        // page looking healthy while nothing worked, so re-handshake once and
        // replay the event that discovered the problem.
        if (/Unknown sessionId/i.test(error.message) && !state.rehandshaking) {
          state.rehandshaking = true;
          log('sdk', 'Session gone — re-initializing');

          return handshake()
            .then(function () {
              state.rehandshaking = false;
              log('sdk', 'Re-initialized — replaying "' + name + '"');
              return track(name, properties);
            })
            .catch(function (retryError) {
              state.rehandshaking = false;
              log('sdk', 'Re-init failed: ' + retryError.message);
              return null;
            });
        }

        log('sdk', 'Event failed: ' + error.message);
        return null;
      });
  }

  /* ------------------------------------------------------------------ */
  /* Real-time connection                                                */
  /* ------------------------------------------------------------------ */
  function connect() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = protocol + '//' + window.location.host + '/ws?sessionId=' + encodeURIComponent(state.sessionId);

    return new Promise(function (resolve) {
      var socket = new WebSocket(url);
      state.socket = socket;

      socket.addEventListener('message', function (event) {
        var message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          log('sdk', 'Invalid WebSocket payload');
          return;
        }

        if (message.type === 'connected') {
          state.connected = true;
          log('sdk', 'WebSocket connected');
          document.dispatchEvent(new CustomEvent('solitics:connected'));
          resolve();
          return;
        }

        if (message.type === 'action' && message.action === 'popup') {
          log('sdk', 'WebSocket campaign instruction', {
            campaignId: message.campaignId,
            deliveryId: message.deliveryId,
          });
          renderPopup(message);
        }
      });

      socket.addEventListener('close', function (event) {
        state.connected = false;
        var badge = document.querySelector('[data-testid="sdk-ws"]');
        if (badge) {
          badge.textContent = 'reconnecting';
          badge.classList.remove('is-connected');
        }

        // 4001 is the server telling us its state was reset: the session this
        // socket belonged to no longer exists, so reconnecting with the old id
        // would attach to nothing. Re-handshake instead.
        if (event && event.code === 4001 && !state.rehandshaking) {
          state.rehandshaking = true;
          log('sdk', 'Server reset — re-initializing');
          handshake()
            .then(function () { state.rehandshaking = false; })
            .catch(function () { state.rehandshaking = false; });
          return;
        }

        log('sdk', 'WebSocket closed');
      });

      socket.addEventListener('error', function () {
        log('sdk', 'WebSocket error');
        resolve();
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Initialization                                                      */
  /* ------------------------------------------------------------------ */
  // Extracted from init() so the client can re-establish itself after the
  // backend loses its state, instead of sitting there looking connected.
  function handshake() {
    var params = new URLSearchParams(window.location.search);
    state.userId = getUserId(params);

    return postJson('/api/v1/sdk/init', {
      userId: state.userId,
      testUser: params.get('testUser'),
      testScenario: params.get('testScenario'),
      traits: { source: 'demo-site' },
    }).then(function (response) {
      state.sessionId = response.sessionId;
      log('sdk', 'Init OK', { sessionId: response.sessionId, segments: response.profile.segments });
      document.dispatchEvent(new CustomEvent('solitics:ready', { detail: response }));

      // A new session is a new delivery context: a campaign capped per session
      // is eligible again, so the old dedup keys must not suppress it.
      state.renderedDeliveries.clear();
      state.renderedCampaigns.clear();

      // Connect before the first event so a campaign decided by that event
      // has a live socket to arrive on.
      return connect();
    });
  }

  function init() {
    log('sdk', 'Initializing SDK');

    return handshake()
      .then(function () {
        return track('page_view', { path: window.location.pathname });
      })
      .catch(function (error) {
        log('sdk', 'Init failed: ' + error.message);
      });
  }

  window.Solitics = {
    init: init,
    track: track,
    getState: function () {
      return {
        userId: state.userId,
        sessionId: state.sessionId,
        connected: state.connected,
        renderedCampaigns: Array.from(state.renderedCampaigns),
      };
    },
    getLog: function () {
      return state.log.slice();
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
