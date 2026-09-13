// Data Stores — the three databases in the diagram.
//
// In-memory so the demo runs with zero setup. Each store exposes the narrow
// API its consumers actually need, so swapping one for Postgres/Mongo/Redis
// later is a local change.
const { randomUUID } = require('crypto');
const bus = require('../bus');

/* ------------------------------------------------------------------ */
/* Campaigns DB                                                        */
/* ------------------------------------------------------------------ */
const campaigns = new Map();

const campaignsDb = {
  upsert(campaign) {
    const saved = { ...campaign, updatedAt: Date.now() };
    campaigns.set(saved.id, saved);
    bus.trace('campaigns-db', `Saved campaign ${saved.id}`, { status: saved.status });
    return saved;
  },
  get(id) {
    return campaigns.get(id) || null;
  },
  list() {
    return [...campaigns.values()];
  },
  listActive() {
    const active = [...campaigns.values()].filter((c) => c.status === 'active');
    bus.trace('campaigns-db', `Loaded ${active.length} active campaign(s)`, {
      ids: active.map((c) => c.id),
    });
    return active;
  },
  remove(id) {
    return campaigns.delete(id);
  },
  clear() {
    campaigns.clear();
  },
};

/* ------------------------------------------------------------------ */
/* User Profiles DB                                                    */
/* ------------------------------------------------------------------ */
const profiles = new Map();

const profilesDb = {
  get(userId) {
    return profiles.get(userId) || null;
  },
  ensure(userId, seed = {}) {
    let profile = profiles.get(userId);
    if (!profile) {
      profile = {
        userId,
        createdAt: Date.now(),
        traits: {},
        segments: [],
        counters: { events: 0, cartValue: 0, pageViews: 0 },
        deliveries: {}, // campaignId -> { total, bySession, lastAt }
        ...seed,
      };
      profiles.set(userId, profile);
      bus.trace('profiles-db', `Created profile ${userId}`);
    }
    return profile;
  },
  save(profile) {
    profiles.set(profile.userId, profile);
    return profile;
  },
  list() {
    return [...profiles.values()];
  },
  clear() {
    profiles.clear();
  },
};

/* ------------------------------------------------------------------ */
/* Analytics DB                                                        */
/* ------------------------------------------------------------------ */
const analytics = [];
const ANALYTICS_LIMIT = 2000;

const analyticsDb = {
  record(type, payload = {}) {
    const row = { id: randomUUID(), type, at: Date.now(), ...payload };
    analytics.push(row);
    if (analytics.length > ANALYTICS_LIMIT) analytics.shift();
    bus.trace('analytics-db', `Recorded ${type}`, {
      campaignId: payload.campaignId,
      userId: payload.userId,
    });
    return row;
  },
  list(limit = 100) {
    return analytics.slice(-limit).reverse();
  },
  summary() {
    const byType = {};
    const byCampaign = {};
    for (const row of analytics) {
      byType[row.type] = (byType[row.type] || 0) + 1;
      if (row.campaignId) {
        byCampaign[row.campaignId] = byCampaign[row.campaignId] || {};
        byCampaign[row.campaignId][row.type] =
          (byCampaign[row.campaignId][row.type] || 0) + 1;
      }
    }
    return { total: analytics.length, byType, byCampaign };
  },
  clear() {
    analytics.length = 0;
  },
};

module.exports = { campaignsDb, profilesDb, analyticsDb };
