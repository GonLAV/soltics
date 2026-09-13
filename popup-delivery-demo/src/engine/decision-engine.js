// Decision Engine — "should this event trigger a campaign right now?"
//
// Runs on every processed event: pulls active campaigns, filters by trigger,
// asks Audience & Rules, then applies frequency capping. Returns a decision
// per campaign so the reason for a *non*-delivery is always inspectable.
const bus = require('../bus');
const { campaignsDb } = require('../db');
const rules = require('./audience-rules');

function withinFrequencyCap(campaign, profile, sessionId) {
  const cap = campaign.frequency || {};
  const delivered = profile.deliveries?.[campaign.id];
  if (!delivered) {
    return { ok: true, reasonCode: 'ELIGIBLE', reason: 'never delivered to this user' };
  }

  if (cap.perUser !== undefined && delivered.total >= cap.perUser) {
    return {
      ok: false,
      reasonCode: 'FREQUENCY_CAP',
      reason: `frequency cap: perUser ${cap.perUser} reached (${delivered.total})`,
    };
  }

  if (cap.perSession !== undefined) {
    const inSession = delivered.bySession?.[sessionId] || 0;
    if (inSession >= cap.perSession) {
      return {
        ok: false,
        reasonCode: 'FREQUENCY_CAP',
        reason: `frequency cap: perSession ${cap.perSession} reached (${inSession})`,
      };
    }
  }

  return { ok: true, reasonCode: 'ELIGIBLE', reason: 'within frequency cap' };
}

function decide({ event, profile, session }) {
  const active = campaignsDb.listActive();
  const context = { event, profile, session };
  const decisions = [];

  for (const campaign of active) {
    // Per-campaign circuit breaker. Evaluation is interpreting operator-
    // supplied data, so a malformed definition must degrade to one bad
    // campaign — not throw out of the loop and take delivery down for every
    // user on the platform. The failure becomes a reason code like any other,
    // which means it is also countable.
    try {
      if (campaign.trigger.event !== event.name) {
        decisions.push({
          campaignId: campaign.id,
          shouldTrigger: false,
          reasonCode: 'TRIGGER_MISMATCH',
          reason: `trigger mismatch: campaign listens for "${campaign.trigger.event}", got "${event.name}"`,
        });
        continue;
      }

      const match = rules.evaluate(campaign, context);
      if (!match.matched) {
        decisions.push({
          campaignId: campaign.id,
          shouldTrigger: false,
          reasonCode: match.reasonCode,
          reason: match.reason,
        });
        continue;
      }

      const cap = withinFrequencyCap(campaign, profile, session.sessionId);
      if (!cap.ok) {
        decisions.push({
          campaignId: campaign.id,
          shouldTrigger: false,
          reasonCode: cap.reasonCode,
          reason: cap.reason,
        });
        continue;
      }

      decisions.push({
        campaignId: campaign.id,
        shouldTrigger: true,
        reasonCode: 'ELIGIBLE',
        reason: match.reason,
        campaign,
      });
    } catch (error) {
      bus.trace('decision', `${campaign.id}: definition is invalid — skipped`, {
        error: error.message,
      });
      decisions.push({
        campaignId: campaign.id,
        shouldTrigger: false,
        reasonCode: 'INVALID_DEFINITION',
        reason: `campaign definition could not be evaluated: ${error.message}`,
      });
    }
  }

  const triggered = decisions.filter((d) => d.shouldTrigger);
  bus.trace(
    'decision',
    triggered.length
      ? `TRIGGER ${triggered.map((d) => d.campaignId).join(', ')}`
      : `No campaign triggered for "${event.name}"`,
    {
      evaluated: decisions.length,
      skipped: decisions.filter((d) => !d.shouldTrigger).map((d) => ({
        campaignId: d.campaignId,
        reason: d.reason,
      })),
    }
  );

  return decisions;
}

module.exports = { decide, withinFrequencyCap };
