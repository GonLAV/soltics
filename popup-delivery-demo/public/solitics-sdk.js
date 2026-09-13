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
      log('sdk', 'Ignored duplicate delivery ' + deliveryId);
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

    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'popup__dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

    var heading = document.createElement('p');
    heading.className = 'popup__title';
    heading.textContent = title;

    var message2 = document.createElement('p');
    message2.className = 'popup__message';
    message2.textContent = body;
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
    close.className = 'btn btn--block';
    close.setAttribute('data-testid', 'popup-close');
    close.textContent = cta;

    popup.innerHTML =
      '<div class="popup__accent"></div>' +
      '<div class="popup__frame">' +
      '<div class="popup__icon">' +
      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z"/></svg>' +
      '</div>' +
      '<div class="popup__body">' +
      '<p class="popup__eyebrow">Just for you</p>' +
      '</div>' +
      '</div>' +
      '<div class="popup__actions"></div>';

    popup.insertBefore(dismiss, popup.firstChild);
    popup.querySelector('.popup__body').appendChild(heading);
    popup.querySelector('.popup__body').appendChild(message2);
    popup.querySelector('.popup__actions').appendChild(close);
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

    function dismissPopup() {
      if (popup.dataset.closing) return;
      popup.dataset.closing = 'true';
      popup.classList.add('popup--closing');
      log('sdk', 'Popup closed by user');
      track('popup_closed', { campaignId: campaignId, deliveryId: deliveryId });
      setTimeout(function () {
        popup.remove();
      }, 220);
    }

    close.addEventListener('click', dismissPopup);
    dismiss.addEventListener('click', dismissPopup);

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

      socket.addEventListener('close', function () {
        state.connected = false;
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
  function init() {
    var params = new URLSearchParams(window.location.search);
    state.userId = getUserId(params);

    log('sdk', 'Initializing SDK', { userId: state.userId });

    return postJson('/api/v1/sdk/init', {
      userId: state.userId,
      testUser: params.get('testUser'),
      testScenario: params.get('testScenario'),
      traits: { source: 'demo-site' },
    })
      .then(function (response) {
        state.sessionId = response.sessionId;
        log('sdk', 'Init OK', { sessionId: response.sessionId, segments: response.profile.segments });
        document.dispatchEvent(new CustomEvent('solitics:ready', { detail: response }));

        // Connect before the first event so a campaign decided by that event
        // has a live socket to arrive on.
        return connect();
      })
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
