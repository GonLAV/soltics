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
  if (!delivered) return { ok: true, reason: 'never delivered to this user' };

  if (cap.perUser !== undefined && delivered.total >= cap.perUser) {
    return {
      ok: false,
      reason: `frequency cap: perUser ${cap.perUser} reached (${delivered.total})`,
    };
  }

  if (cap.perSession !== undefined) {
    const inSession = delivered.bySession?.[sessionId] || 0;
    if (inSession >= cap.perSession) {
      return {
        ok: false,
        reason: `frequency cap: perSession ${cap.perSession} reached (${inSession})`,
      };
    }
  }

  return { ok: true, reason: 'within frequency cap' };
}

function decide({ event, profile, session }) {
  const active = campaignsDb.listActive();
  const context = { event, profile, session };
  const decisions = [];

  for (const campaign of active) {
    if (campaign.trigger.event !== event.name) {
      decisions.push({
        campaignId: campaign.id,
        shouldTrigger: false,
        reason: `trigger mismatch: campaign listens for "${campaign.trigger.event}", got "${event.name}"`,
      });
      continue;
    }

    const match = rules.evaluate(campaign, context);
    if (!match.matched) {
      decisions.push({ campaignId: campaign.id, shouldTrigger: false, reason: match.reason });
      continue;
    }

    const cap = withinFrequencyCap(campaign, profile, session.sessionId);
    if (!cap.ok) {
      decisions.push({ campaignId: campaign.id, shouldTrigger: false, reason: cap.reason });
      continue;
    }

    decisions.push({
      campaignId: campaign.id,
      shouldTrigger: true,
      reason: match.reason,
      campaign,
    });
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
