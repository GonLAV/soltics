// Action Sender — turns a positive decision into a message on the wire.
//
// Owns the delivery bookkeeping: it stamps a deliveryId, hands the message to
// the Real-time Server, records `campaign_delivered` in Analytics and bumps
// the frequency counters on the user profile.
const { randomUUID } = require('crypto');
const bus = require('../bus');
const { profilesDb, analyticsDb } = require('../db');
const realtime = require('../backend/realtime');

function recordDelivery(profile, campaignId, sessionId) {
  const entry = profile.deliveries[campaignId] || { total: 0, bySession: {}, lastAt: null };
  entry.total += 1;
  entry.bySession[sessionId] = (entry.bySession[sessionId] || 0) + 1;
  entry.lastAt = Date.now();
  profile.deliveries[campaignId] = entry;
  profilesDb.save(profile);
  return entry;
}

function send(decision, { profile, session, event }) {
  const campaign = decision.campaign;
  const deliveryId = randomUUID();

  const message = {
    type: 'action',
    action: campaign.action.type,
    deliveryId,
    campaignId: campaign.id,
    campaignName: campaign.name,
    payload: campaign.action.payload,
    reason: decision.reason,
    triggeredBy: event?.name,
  };

  bus.trace('action-sender', `Sending ${campaign.action.type} for ${campaign.id}`, {
    deliveryId,
    sessionId: session.sessionId,
  });

  const result = realtime.sendToSession(session.sessionId, message);

  // Delivery bookkeeping happens once, even for the duplicate-delivery
  // scenario below: the second push is the *same* delivery re-sent, which is
  // exactly what the SDK is expected to de-duplicate.
  recordDelivery(profile, campaign.id, session.sessionId);
  analyticsDb.record('campaign_delivered', {
    campaignId: campaign.id,
    userId: profile.userId,
    sessionId: session.sessionId,
    deliveryId,
    queued: result.queued,
  });

  // Test hook: simulate an at-least-once transport that re-sends the same
  // instruction. The SDK must still render exactly one popup.
  if (session.testScenario === 'duplicate-delivery') {
    setTimeout(() => {
      bus.trace('action-sender', `Re-sending ${deliveryId} (duplicate-delivery scenario)`, {
        sessionId: session.sessionId,
      });
      realtime.sendToSession(session.sessionId, message);
      analyticsDb.record('campaign_delivered_duplicate', {
        campaignId: campaign.id,
        userId: profile.userId,
        sessionId: session.sessionId,
        deliveryId,
      });
    }, 150);
  }

  return { deliveryId, ...result };
}

module.exports = { send };
