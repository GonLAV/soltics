// Part 3 — the test as submitted, run verbatim against this app.
//
// This suite is EXPECTED TO FAIL. It is not part of the delivery suite; it
// exists so the code review can be demonstrated rather than asserted. Each
// failure below is one of the prioritised issues, reproduced on demand.
//
// Run it from Demo controls → "Part 3 — Code review", or:
//   npx playwright test --config=playwright.code-review.config.ts
import { test, expect } from '@playwright/test';

test.describe('Submitted test (expected to fail)', () => {
  // ISSUE 5 — fragile selectors.
  // #popup and .close are structural guesses. The popup is delivered and
  // working; the test still fails, because it is coupled to markup that was
  // never part of any contract.
  test('Popup appears — fragile selector (#popup)', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(5000);
    const popup = page.locator('#popup');
    expect(await popup.isVisible()).toBeTruthy();
    await popup.locator('.close').click();
  });

  // ISSUE 1 — fixed wait against a variable-latency path.
  // Same test with the selector problem removed, so the timing problem is
  // isolated. Delivery here takes ~6.5s; the 5s guess expires first and the
  // test reports a broken feature that is merely slower than the guess.
  test('Popup appears — fixed 5s wait under load', async ({ page }) => {
    await page.goto('/?testScenario=slow-delivery');
    await page.waitForTimeout(5000);
    const popup = page.getByTestId('campaign-popup');
    expect(await popup.isVisible()).toBeTruthy();
  });

  // ISSUE 4 — no content assertion.
  // Visibility only. A campaign shipping the wrong copy passes this test, so
  // it cannot detect the failure a customer would actually complain about.
  // Deliberately green: a passing test that proves nothing is the point.
  test('Popup appears — passes without checking the copy', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(5000);
    const popup = page.getByTestId('campaign-popup');
    expect(await popup.isVisible()).toBeTruthy();
    // No assertion on title, body or CTA. Ships broken copy undetected.
  });

  // ISSUE 6 — no isolation.
  // A shared identity with no unique user id. The first run consumes the
  // per-session cap; re-running inside the same storage state finds nothing.
  test('Popup appears — no isolation across runs', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('campaign-popup').waitFor({ timeout: 10_000 });

    // Same page, same session — exactly what a re-run against a shared user
    // looks like to the engine.
    await page.reload();
    await page.waitForTimeout(5000);
    const popup = page.locator('#popup');
    expect(await popup.isVisible()).toBeTruthy();
  });
});
