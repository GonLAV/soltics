// Portable contract tests — these are the ones that can point at a real platform.
//
// They depend on nothing but:
//   - data-testid="campaign-popup"  on the delivered popup
//   - data-testid="popup-close"     on its close control
//   - the campaign copy in POPUP_TEXT
//   - a way to address an out-of-audience user (SCENARIOS.nonEligible)
//
// No demo-only page furniture, no knowledge of the backend's REST shape.
// Run against another environment with:
//   BASE_URL=https://staging.example.com npm run test:contract

import { test, expect } from '@playwright/test';
import { SCENARIOS, POPUP_TEXT, DELIVERY_TIMEOUT, NO_DELIVERY_TIMEOUT } from './contract';

test.describe('Popup delivery (platform contract)', () => {
  test('eligible user sees popup with correct content and can close it', async ({ page }) => {
    await page.goto(SCENARIOS.eligible);

    const popup = page.getByTestId('campaign-popup');

    await expect(popup).toBeVisible({ timeout: DELIVERY_TIMEOUT });
    await expect(popup).toContainText(POPUP_TEXT);
    await expect(page.getByTestId('campaign-popup')).toHaveCount(1);

    await page.getByTestId('popup-close').click();

    await expect(popup).toBeHidden();
  });

  test('non-eligible user does not see a popup', async ({ page }) => {
    await page.goto(SCENARIOS.nonEligible);

    await expect(page.getByTestId('campaign-popup')).toHaveCount(0, {
      timeout: NO_DELIVERY_TIMEOUT,
    });
  });

  // This one needs no cooperation from the backend at all: the duplicate is
  // injected in the browser by intercepting the WebSocket, forwarding it to the
  // real server and re-sending every campaign frame a second time. That makes
  // the de-duplication requirement testable against any environment.
  test('a duplicated campaign instruction renders only one popup', async ({ page }) => {
    let duplicated = 0;

    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      const server = ws.connectToServer();

      server.onMessage((message) => {
        ws.send(message);

        const text = typeof message === 'string' ? message : message.toString();
        // Re-send anything that looks like a campaign instruction.
        if (text.includes('"action"') || text.includes('"campaign"')) {
          duplicated += 1;
          ws.send(message);
        }
      });

      ws.onMessage((message) => server.send(message));
    });

    await page.goto(SCENARIOS.eligible);

    const popup = page.getByTestId('campaign-popup');
    await expect(popup).toBeVisible({ timeout: DELIVERY_TIMEOUT });

    // Wait on the duplicate actually being sent, not on a guess at how long
    // that takes: the interceptor increments `duplicated` the moment it
    // re-sends, which is the observable this assertion depends on.
    await expect
      .poll(() => duplicated, {
        message: 'no campaign frame was intercepted to duplicate',
        timeout: DELIVERY_TIMEOUT,
      })
      .toBeGreaterThan(0);

    await expect(page.getByTestId('campaign-popup')).toHaveCount(1);
  });
});
