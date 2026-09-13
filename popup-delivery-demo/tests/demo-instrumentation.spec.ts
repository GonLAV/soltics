// Mock-only tests.
//
// These assert against the demo page's instrumentation (the SDK state panel,
// the shop buttons, window.Solitics) and the demo backend's test hooks. They
// are deliberately NOT portable — the portable contract lives in
// popup-delivery.spec.ts.

import { test, expect } from '@playwright/test';

test.describe('SDK handshake', () => {
  test('the SDK registers, opens a socket and reports its segments', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('sdk-ws')).toHaveText('open', { timeout: 10_000 });
    await expect(page.getByTestId('sdk-user')).not.toHaveText('—');
    await expect(page.getByTestId('sdk-session')).not.toHaveText('—');
    await expect(page.getByTestId('sdk-segments')).toContainText('high_intent');
  });

  test('a non-eligible user is missing the targeted segment', async ({ page }) => {
    await page.goto('/?testUser=non-eligible');

    await expect(page.getByTestId('sdk-ws')).toHaveText('open', { timeout: 10_000 });
    await expect(page.getByTestId('sdk-segments')).not.toContainText('high_intent');
    await expect(page.getByTestId('campaign-popup')).toHaveCount(0);
  });
});

test.describe('Server-side duplicate delivery', () => {
  test('the Action Sender re-sending an instruction yields one popup', async ({ page }) => {
    await page.goto('/?testScenario=duplicate-delivery');

    const popup = page.getByTestId('campaign-popup');
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await expect(popup).toHaveAttribute('data-campaign-id', 'cmp-20-off');

    // The re-send lands ~150ms later.
    await page.waitForTimeout(600);
    await expect(page.getByTestId('campaign-popup')).toHaveCount(1);

    // Prove the duplicate really arrived, so this cannot pass trivially if the
    // scenario hook stops working.
    const log = await page.evaluate(() => (window as any).Solitics.getLog());
    const ignored = log.filter((entry: any) =>
      /Ignored duplicate|already occupied/.test(entry.message)
    );
    expect(ignored.length).toBeGreaterThan(0);
  });
});

test.describe('Behavioural targeting', () => {
  test('crossing the cart-value threshold triggers the free-shipping campaign', async ({ page }) => {
    await page.goto('/');

    // Clear the welcome popup so the popup slot is free for the next campaign.
    await expect(page.getByTestId('campaign-popup')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('popup-close').click();

    // $40 — below the $100 condition, so no campaign should fire.
    await page.getByTestId('add-to-cart-tee-01').click();
    await expect(page.getByTestId('cart-total')).toHaveText('$40');
    await expect(page.getByTestId('campaign-popup')).toHaveCount(0);

    // $40 + $75 = $115 — condition satisfied.
    await page.getByTestId('add-to-cart-hd-02').click();

    const popup = page.getByTestId('campaign-popup');
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await expect(popup).toHaveAttribute('data-campaign-id', 'cmp-free-shipping');
    await expect(popup).toContainText('free shipping');
  });

  test('SDK reports popup_displayed back to the backend', async ({ page, request }) => {
    await page.goto('/');

    await expect(page.getByTestId('campaign-popup')).toBeVisible({ timeout: 10_000 });
    const userId = await page.getByTestId('sdk-user').textContent();

    await page.getByTestId('popup-close').click();
    await expect(page.getByTestId('campaign-popup')).toBeHidden();

    await expect
      .poll(
        async () => {
          const response = await request.get('/api/v1/analytics?limit=200');
          const { events } = await response.json();
          return events
            .filter((event: any) => event.userId === userId)
            .map((event: any) => event.name || event.type);
        },
        { timeout: 5_000 }
      )
      .toEqual(expect.arrayContaining(['popup_displayed', 'popup_closed']));
  });
});

test.describe('Quality command center', () => {
  test('an audience isolation probe returns explainable decision evidence', async ({ page }) => {
    await page.goto('/dashboard.html');

    await page.locator('[data-scenario="audience"]').click();

    await expect(page.locator('[data-scenario-state="audience"]')).toHaveText('Passed');
    await expect(page.locator('[data-probe-title]')).toHaveText('Audience isolation passed');
    await expect(page.locator('[data-probe-detail]')).toContainText('do not match audience');
    await expect(page.locator('[data-decision-total]')).not.toHaveText('0');
  });

  test('the cart drawer reflects item state and shipping qualification', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('campaign-popup')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('popup-close').click();

    await page.getByTestId('add-to-cart-tee-01').click();
    await page.getByTestId('add-to-cart-hd-02').click();
    await page.locator('[data-cart-open]').click();

    await expect(page.locator('[data-cart-drawer]')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('.drawer-item')).toHaveCount(2);
    await expect(page.locator('[data-cart-subtotal]')).toHaveText('$115');
    await expect(page.locator('[data-drawer-shipping]')).toContainText('unlocked');
  });
});

test.describe('Dashboard review regressions', () => {
  test.beforeEach(async ({ request }) => {
    const response = await request.post('/api/v1/admin/reset');
    expect(response.ok()).toBeTruthy();
  });

  test('the dashboard keeps one row when backlog and live inspector frames repeat the same trace', async ({ page, request }) => {
    const initResponse = await request.post('/api/v1/sdk/init', {
      data: { userId: `trace-${Date.now()}` },
    });
    expect(initResponse.ok()).toBeTruthy();

    const { sessionId } = await initResponse.json();
    const eventResponse = await request.post('/api/v1/events', {
      data: { sessionId, event: { name: 'page_view' } },
    });
    expect(eventResponse.status()).toBe(202);

    let backlogCount = 0;
    await page.routeWebSocket(/\/ws\/inspector(\?|$)/, (ws) => {
      const server = ws.connectToServer();

      server.onMessage((message) => {
        ws.send(message);

        const text = typeof message === 'string' ? message : message.toString();
        const payload = JSON.parse(text);
        if (!backlogCount && payload.type === 'backlog' && payload.entries.length) {
          backlogCount = payload.entries.length;
          ws.send(JSON.stringify({
            type: 'trace',
            entry: payload.entries[payload.entries.length - 1],
          }));
        }
      });

      ws.onMessage((message) => server.send(message));
    });

    await page.goto('/dashboard.html');

    await expect.poll(() => backlogCount).toBeGreaterThan(0);
    await expect(page.locator('.activity-row')).toHaveCount(Math.min(backlogCount, 12));
  });

  test('campaign controls recover after a failed status update', async ({ page }) => {
    await page.route('**/api/v1/campaigns/*/status', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'status update failed' }),
      });
    });

    await page.goto('/dashboard.html');

    const toggle = page.locator('[data-campaign-row="cmp-20-off"] .campaign-action');
    await expect(toggle).toHaveText('Pause');

    await toggle.click();

    await expect(toggle).toBeEnabled();
    await expect(page.getByRole('main')).toHaveCount(1);
  });
});
