// Audience & Rules — evaluates whether a user/event matches a campaign's
// audience definition and its extra conditions.
//
// Kept free of I/O so it is trivially unit-testable: pure functions over a
// context object of { profile, event, session }.
const bus = require('../bus');

const OPERATORS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  in: (a, b) => Array.isArray(b) && b.includes(a),
  contains: (a, b) => Array.isArray(a) && a.includes(b),
  exists: (a) => a !== undefined && a !== null,
};

function resolve(path, context) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), context);
}

function matchesAudience(campaign, profile) {
  const wanted = campaign.audience?.segments || [];
  if (wanted.length === 0) {
    return { matched: true, reasonCode: 'ELIGIBLE', reason: 'audience is everyone' };
  }

  const held = profile.segments || [];
  const overlap = wanted.filter((segment) => held.includes(segment));
  const matched =
    campaign.audience?.match === 'all' ? overlap.length === wanted.length : overlap.length > 0;

  return {
    matched,
    reasonCode: matched ? 'ELIGIBLE' : 'AUDIENCE_MISMATCH',
    reason: matched
      ? `segment match on [${overlap.join(', ')}]`
      : `user segments [${held.join(', ')}] do not match audience [${wanted.join(', ')}]`,
  };
}

function matchesConditions(campaign, context) {
  const conditions = campaign.conditions || [];
  for (const condition of conditions) {
    const actual = resolve(condition.field, context);
    const operator = OPERATORS[condition.op];
    if (!operator) {
      return {
        matched: false,
        reasonCode: 'INVALID_CONDITION',
        reason: `unknown operator "${condition.op}"`,
      };
    }
    if (!operator(actual, condition.value)) {
      return {
        matched: false,
        reasonCode: 'CONDITION_FAILED',
        reason: `condition failed: ${condition.field} (${JSON.stringify(actual)}) ${condition.op} ${JSON.stringify(condition.value)}`,
      };
    }
  }
  return {
    matched: true,
    reasonCode: 'ELIGIBLE',
    reason: `${conditions.length} condition(s) passed`,
  };
}

function evaluate(campaign, context) {
  const audience = matchesAudience(campaign, context.profile);
  if (!audience.matched) {
    bus.trace('rules', `${campaign.id}: audience miss`, { reason: audience.reason });
    return { matched: false, reasonCode: audience.reasonCode, reason: audience.reason };
  }

  const conditions = matchesConditions(campaign, context);
  if (!conditions.matched) {
    bus.trace('rules', `${campaign.id}: condition miss`, { reason: conditions.reason });
    return { matched: false, reasonCode: conditions.reasonCode, reason: conditions.reason };
  }

  bus.trace('rules', `${campaign.id}: audience + conditions OK`, {
    reason: audience.reason,
  });
  return {
    matched: true,
    reasonCode: 'ELIGIBLE',
    reason: `${audience.reason}; ${conditions.reason}`,
  };
}

module.exports = { evaluate, matchesAudience, matchesConditions, resolve, OPERATORS };
