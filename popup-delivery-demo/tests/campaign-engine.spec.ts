// API-level tests: drive the backend directly, with no browser.
//
// These run much faster than the UI tests and pin down the engine's decision
// *reasons*, not just the end result — so a campaign that stops firing tells
// you which rule rejected it.
//
// Every test uses a unique userId so the suite is safe to run in parallel
// against one shared server.

import { test, expect, type APIRequestContext } from '@playwright/test';

let counter = 0;
const uniqueUser = (label: string) => `test-${label}-${Date.now()}-${counter++}`;

async function initSession(
  request: APIRequestContext,
  body: Record<string, unknown>
): Promise<{ sessionId: string; userId: string; profile: any }> {
  const response = await request.post('/api/v1/sdk/init', { data: body });
  expect(response.status()).toBe(200);
  return response.json();
}

async function sendEvent(
  request: APIRequestContext,
  sessionId: string,
  name: string,
  properties: Record<string, unknown> = {}
) {
  const response = await request.post('/api/v1/events', {
    data: { sessionId, event: { name, properties } },
  });
  expect(response.status()).toBe(202);
  const body = await response.json();
  return body.results[0];
}

const reasonFor = (result: any, campaignId: string) =>
  result.decisions.find((d: any) => d.campaignId === campaignId);

test.describe('API layer', () => {
  test('health endpoint reports the running system', async ({ request }) => {
    const response = await request.get('/api/v1/health');
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.campaigns).toBeGreaterThanOrEqual(3);
    expect(body.realtime).toHaveProperty('liveConnections');
  });

  test('init requires a userId', async ({ request }) => {
    const response = await request.post('/api/v1/sdk/init', { data: {} });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain('userId');
  });

  test('events from an unknown session are rejected', async ({ request }) => {
    const response = await request.post('/api/v1/events', {
      data: { sessionId: 'does-not-exist', event: { name: 'page_view' } },
    });
    expect(response.status()).toBe(404);
  });

  test('an event without a name is rejected', async ({ request }) => {
    const { sessionId } = await initSession(request, { userId: uniqueUser('noname') });
    const response = await request.post('/api/v1/events', {
      data: { sessionId, event: { properties: {} } },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain('event.name');
  });
});

test.describe('Segmentation', () => {
  test('a default user lands in the high_intent segment', async ({ request }) => {
    const { profile } = await initSession(request, { userId: uniqueUser('seg') });
    expect(profile.segments).toContain('visitors');
    expect(profile.segments).toContain('high_intent');
  });

  test('the non-eligible trait removes the high_intent segment', async ({ request }) => {
    const { profile } = await initSession(request, {
      userId: uniqueUser('seg-non'),
      testUser: 'non-eligible',
    });
    expect(profile.traits.eligible).toBe(false);
    expect(profile.segments).not.toContain('high_intent');
  });

  test('cart activity adds the shoppers segment', async ({ request }) => {
    const userId = uniqueUser('seg-shop');
    const { sessionId } = await initSession(request, { userId });

    await sendEvent(request, sessionId, 'add_to_cart', { sku: 'tee-01', price: 40 });

    const profile = (await (await request.get(`/api/v1/profiles/${userId}`)).json()).profile;
    expect(profile.segments).toContain('shoppers');
    expect(profile.counters.cartValue).toBe(40);
  });
});

test.describe('Decision engine', () => {
  test('an eligible page_view triggers the welcome campaign', async ({ request }) => {
    const { sessionId } = await initSession(request, { userId: uniqueUser('elig') });
    const result = await sendEvent(request, sessionId, 'page_view');

    expect(result.delivered.map((d: any) => d.campaignId)).toContain('cmp-20-off');
    expect(reasonFor(result, 'cmp-20-off').shouldTrigger).toBe(true);
  });

  test('a non-eligible user is declined for an audience reason', async ({ request }) => {
    const { sessionId } = await initSession(request, {
      userId: uniqueUser('non'),
      testUser: 'non-eligible',
    });
    const result = await sendEvent(request, sessionId, 'page_view');

    expect(result.delivered).toHaveLength(0);
    expect(reasonFor(result, 'cmp-20-off').reason).toContain('do not match audience');
  });

  test('the per-session frequency cap blocks a second delivery', async ({ request }) => {
    const { sessionId } = await initSession(request, { userId: uniqueUser('cap') });

    const first = await sendEvent(request, sessionId, 'page_view');
    expect(first.delivered.map((d: any) => d.campaignId)).toContain('cmp-20-off');

    const second = await sendEvent(request, sessionId, 'page_view');
    expect(second.delivered).toHaveLength(0);
    expect(reasonFor(second, 'cmp-20-off').reason).toContain('frequency cap');
  });

  test('a new session for the same user is eligible again', async ({ request }) => {
    const userId = uniqueUser('cap-session');

    const first = await initSession(request, { userId });
    const firstResult = await sendEvent(request, first.sessionId, 'page_view');
    expect(firstResult.delivered).toHaveLength(1);

    const second = await initSession(request, { userId });
    const secondResult = await sendEvent(request, second.sessionId, 'page_view');
    expect(secondResult.delivered.map((d: any) => d.campaignId)).toContain('cmp-20-off');
  });

  test('conditions gate the free-shipping campaign on cart value', async ({ request }) => {
    const { sessionId } = await initSession(request, { userId: uniqueUser('cond') });

    const below = await sendEvent(request, sessionId, 'add_to_cart', { price: 40 });
    expect(below.delivered).toHaveLength(0);
    expect(reasonFor(below, 'cmp-free-shipping').reason).toContain('condition failed');

    const above = await sendEvent(request, sessionId, 'add_to_cart', { price: 75 });
    expect(above.delivered.map((d: any) => d.campaignId)).toContain('cmp-free-shipping');
  });

  test('a paused campaign is never evaluated', async ({ request }) => {
    const { sessionId } = await initSession(request, {
      userId: uniqueUser('vip'),
      testUser: 'vip',
    });
    const result = await sendEvent(request, sessionId, 'page_view');

    // cmp-vip-only is seeded as paused, so it is absent from the decision list.
    expect(result.decisions.map((d: any) => d.campaignId)).not.toContain('cmp-vip-only');
  });

  test('feedback events do not re-enter the engine', async ({ request }) => {
    const { sessionId } = await initSession(request, { userId: uniqueUser('feedback') });
    await sendEvent(request, sessionId, 'page_view');

    const feedback = await sendEvent(request, sessionId, 'popup_displayed', {
      campaignId: 'cmp-20-off',
    });
    expect(feedback.decisions).toHaveLength(0);
    expect(feedback.delivered).toHaveLength(0);
  });
});

test.describe('Campaign manager', () => {
  test('a campaign defined at runtime starts delivering immediately', async ({ request }) => {
    const campaignId = `cmp-runtime-${Date.now()}`;

    const created = await request.post('/api/v1/campaigns', {
      data: {
        id: campaignId,
        name: 'Runtime campaign',
        trigger: { event: 'newsletter_view' },
        audience: { segments: [] },
        frequency: { perSession: 1 },
        action: {
          type: 'popup',
          payload: { title: 'Subscribe', message: 'and save 10%', cta: 'Close' },
        },
      },
    });
    expect(created.status()).toBe(201);

    const { sessionId } = await initSession(request, { userId: uniqueUser('runtime') });
    const result = await sendEvent(request, sessionId, 'newsletter_view');

    expect(result.delivered.map((d: any) => d.campaignId)).toContain(campaignId);

    await request.delete(`/api/v1/campaigns/${campaignId}`);
  });

  test('pausing a campaign stops delivery', async ({ request }) => {
    const campaignId = `cmp-pausable-${Date.now()}`;

    await request.post('/api/v1/campaigns', {
      data: {
        id: campaignId,
        name: 'Pausable campaign',
        trigger: { event: 'pausable_trigger' },
        audience: { segments: [] },
        action: { type: 'popup', payload: { title: 'Hi', message: 'there', cta: 'Close' } },
      },
    });

    const before = await initSession(request, { userId: uniqueUser('pause-a') });
    const delivered = await sendEvent(request, before.sessionId, 'pausable_trigger');
    expect(delivered.delivered).toHaveLength(1);

    const paused = await request.patch(`/api/v1/campaigns/${campaignId}/status`, {
      data: { status: 'paused' },
    });
    expect(paused.status()).toBe(200);

    const after = await initSession(request, { userId: uniqueUser('pause-b') });
    const blocked = await sendEvent(request, after.sessionId, 'pausable_trigger');
    expect(blocked.delivered).toHaveLength(0);

    await request.delete(`/api/v1/campaigns/${campaignId}`);
  });

  test('an invalid campaign definition is rejected', async ({ request }) => {
    const response = await request.post('/api/v1/campaigns', {
      data: { name: 'missing everything' },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain('campaign.id');
  });
});
