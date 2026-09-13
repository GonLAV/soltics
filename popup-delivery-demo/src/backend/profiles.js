// User Profile & Segmentation.
//
// Maintains the durable view of a user: traits sent at identify time,
// behavioural counters accumulated from events, and the segments derived from
// both. Segments are recomputed after every event so the Decision Engine
// always reads a fresh view.
const bus = require('../bus');
const { profilesDb } = require('../db');

// Derived segments. Pure function of traits + counters, so segmentation is
// reproducible and testable in isolation.
function computeSegments(profile) {
  const segments = ['visitors'];

  // The "non-eligible" test user is modelled as a real trait, not a special
  // case in the delivery path.
  if (profile.traits.eligible !== false) segments.push('high_intent');
  if (profile.counters.cartValue > 0) segments.push('shoppers');
  if (profile.traits.tier === 'vip') segments.push('vip');
  if (profile.counters.pageViews >= 3) segments.push('engaged');

  return segments;
}

function identify(userId, traits = {}) {
  const profile = profilesDb.ensure(userId);
  profile.traits = { ...profile.traits, ...traits };
  profile.segments = computeSegments(profile);
  profilesDb.save(profile);

  bus.trace('profile', `Identified ${userId}`, {
    traits: profile.traits,
    segments: profile.segments,
  });
  return profile;
}

// Fold one event into the profile's counters, then re-derive segments.
function applyEvent(userId, event) {
  const profile = profilesDb.ensure(userId);
  profile.counters.events += 1;

  if (event.name === 'page_view') {
    profile.counters.pageViews += 1;
  }

  if (event.name === 'add_to_cart') {
    const value = Number(event.properties?.price) || 0;
    profile.counters.cartValue += value;
  }

  if (event.name === 'purchase') {
    profile.counters.cartValue = 0;
  }

  const before = profile.segments.join(',');
  profile.segments = computeSegments(profile);
  profilesDb.save(profile);

  const changed = before !== profile.segments.join(',');
  bus.trace(
    'profile',
    changed
      ? `Segments updated: [${profile.segments.join(', ')}]`
      : `Profile updated (segments unchanged)`,
    { userId, counters: profile.counters }
  );

  return profile;
}

module.exports = { identify, applyEvent, computeSegments };
