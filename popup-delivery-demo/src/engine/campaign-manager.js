// Campaign Manager — defines campaigns and keeps them in the Campaigns DB.
//
// A campaign is data, not code: a trigger event, an audience, extra
// conditions, a frequency cap and an action payload. The Decision Engine
// interprets it, so new campaigns need no deploy.
const bus = require('../bus');
const { campaignsDb } = require('../db');

const SEED_CAMPAIGNS = [
  {
    id: 'cmp-20-off',
    name: 'Welcome 20% off',
    status: 'active',
    trigger: { event: 'page_view' },
    audience: { segments: ['high_intent'], match: 'any' },
    conditions: [],
    frequency: { perSession: 1 },
    action: {
      type: 'popup',
      payload: {
        title: 'Special Offer!',
        message: 'Get 20% off',
        cta: 'Close',
      },
    },
  },
  {
    id: 'cmp-free-shipping',
    name: 'Free shipping over $100',
    status: 'active',
    trigger: { event: 'add_to_cart' },
    audience: { segments: ['shoppers'], match: 'any' },
    conditions: [{ field: 'profile.counters.cartValue', op: 'gte', value: 100 }],
    frequency: { perSession: 1 },
    action: {
      type: 'popup',
      payload: {
        title: 'Nice cart!',
        message: 'You unlocked free shipping',
        cta: 'Close',
      },
    },
  },
  {
    id: 'cmp-vip-only',
    name: 'VIP early access (paused)',
    status: 'paused',
    trigger: { event: 'page_view' },
    audience: { segments: ['vip'], match: 'any' },
    conditions: [],
    frequency: { perUser: 1 },
    action: {
      type: 'popup',
      payload: {
        title: 'VIP early access',
        message: 'Shop the drop 24h early',
        cta: 'Close',
      },
    },
  },
];

const campaignManager = {
  seed() {
    for (const campaign of SEED_CAMPAIGNS) {
      campaignsDb.upsert(structuredClone(campaign));
    }
    bus.trace('campaign-manager', `Seeded ${SEED_CAMPAIGNS.length} campaigns`);
  },
  list() {
    return campaignsDb.list();
  },
  get(id) {
    return campaignsDb.get(id);
  },
  define(campaign) {
    if (!campaign.id) throw new Error('campaign.id is required');
    if (!campaign.trigger?.event) throw new Error('campaign.trigger.event is required');
    if (!campaign.action?.type) throw new Error('campaign.action.type is required');

    // Shape checks on the fields the Decision Engine iterates. Without these a
    // typo — `conditions` as an object rather than an array — is stored
    // happily and only fails later, inside evaluation, for every user.
    // Rejecting at the write boundary keeps the blast radius at one request.
    if (campaign.conditions !== undefined && !Array.isArray(campaign.conditions)) {
      throw new Error('campaign.conditions must be an array');
    }
    if (campaign.audience !== undefined) {
      if (typeof campaign.audience !== 'object' || Array.isArray(campaign.audience)) {
        throw new Error('campaign.audience must be an object');
      }
      if (campaign.audience.segments !== undefined && !Array.isArray(campaign.audience.segments)) {
        throw new Error('campaign.audience.segments must be an array');
      }
    }
    if (campaign.frequency !== undefined &&
        (typeof campaign.frequency !== 'object' || Array.isArray(campaign.frequency))) {
      throw new Error('campaign.frequency must be an object');
    }
    if (campaign.status !== undefined && !['active', 'paused'].includes(campaign.status)) {
      throw new Error('campaign.status must be "active" or "paused"');
    }

    const saved = campaignsDb.upsert({
      status: 'active',
      audience: { segments: [], match: 'any' },
      conditions: [],
      frequency: {},
      ...campaign,
    });
    bus.trace('campaign-manager', `Defined campaign ${saved.id}`, { name: saved.name });
    return saved;
  },
  setStatus(id, status) {
    const campaign = campaignsDb.get(id);
    if (!campaign) return null;
    const saved = campaignsDb.upsert({ ...campaign, status });
    bus.trace('campaign-manager', `Campaign ${id} -> ${status}`);
    return saved;
  },
  remove(id) {
    return campaignsDb.remove(id);
  },
  reset() {
    campaignsDb.clear();
    campaignManager.seed();
  },
};

module.exports = { campaignManager, SEED_CAMPAIGNS };
