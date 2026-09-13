// Event Ingestion & Processing.
//
// The spine of the flow: validate and normalise the raw SDK event, persist it
// to Analytics, fold it into the user profile, ask the Campaign Engine for a
// decision and hand any positive decision to the Action Sender.
const { randomUUID } = require('crypto');
const bus = require('../bus');
const { analyticsDb } = require('../db');
const profiles = require('./profiles');
const decisionEngine = require('../engine/decision-engine');
const actionSender = require('../engine/action-sender');

const FEEDBACK_EVENTS = new Set(['popup_displayed', 'popup_closed', 'popup_clicked']);

function normalize(raw, session) {
  if (!raw || typeof raw.name !== 'string' || raw.name.trim() === '') {
    const error = new Error('event.name is required');
    error.statusCode = 400;
    throw error;
  }

  return {
    eventId: randomUUID(),
    name: raw.name.trim(),
    properties: raw.properties && typeof raw.properties === 'object' ? raw.properties : {},
    receivedAt: Date.now(),
    clientAt: Number(raw.timestamp) || null,
    userId: session.userId,
    sessionId: session.sessionId,
  };
}

function ingest(raw, session) {
  const event = normalize(raw, session);
  session.eventCount += 1;

  bus.trace('ingestion', `Ingested "${event.name}"`, {
    eventId: event.eventId,
    properties: event.properties,
  });

  analyticsDb.record('event', {
    name: event.name,
    eventId: event.eventId,
    userId: event.userId,
    sessionId: event.sessionId,
    campaignId: event.properties.campaignId,
    properties: event.properties,
  });

  const profile = profiles.applyEvent(session.userId, event);

  // Feedback events (the popup was shown / closed) close the analytics loop
  // but must not re-enter the Decision Engine — otherwise showing a popup
  // could trigger another popup.
  if (FEEDBACK_EVENTS.has(event.name)) {
    bus.trace('ingestion', `"${event.name}" is a feedback event — not re-evaluated`);
    return { event, decisions: [], delivered: [] };
  }

  const decisions = decisionEngine.decide({ event, profile, session });
  const delivered = [];

  for (const decision of decisions) {
    analyticsDb.record('campaign_decision', {
      campaignId: decision.campaignId,
      userId: profile.userId,
      sessionId: session.sessionId,
      eventId: event.eventId,
      eventName: event.name,
      shouldTrigger: decision.shouldTrigger,
      reasonCode: decision.reasonCode,
      reason: decision.reason,
    });
  }

  for (const decision of decisions.filter((d) => d.shouldTrigger)) {
    const result = actionSender.send(decision, { profile, session, event });
    delivered.push({ campaignId: decision.campaignId, ...result });
  }

  return { event, decisions, delivered };
}

module.exports = { ingest, normalize };
