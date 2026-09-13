// Part 3 — the rewrite. Same four situations, all green.
//
// Every test here is the paired fix for the one above it in submitted.spec.ts,
// so the two can be run back to back and read as a diff.
import { test, expect } from '@playwright/test';

const uniqueUser = (label: string) => `cr-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test.describe('Rewritten test', () => {
  // FIXES 5 + 2 — contract selectors, and web-first assertions that retry.
  // getByTestId is the published contract (data-testid survives restyling);
  // expect(locator) polls until the delivery lands instead of sampling once.
  test('eligible user sees the popup and can close it', async ({ page }) => {
    await page.goto(`/?userId=${uniqueUser('eligible')}`);

    const popup = page.getByTestId('campaign-popup');

    await expect(popup).toBeVisible({ timeout: 10_000 });
    await expect(popup).toContainText('Special Offer');      // FIX 4 — content
    await expect(popup).toHaveCount(1);                       // no double push

    await page.getByTestId('popup-close').click();
    await expect(popup).toBeHidden();                         // FIX 7 — close verified
  });

  // FIX 1 — waits on state, not on a clock.
  // Delivery is deliberately slowed to ~6.5s. The fixed-5s version fails here;
  // this passes, and against an instant delivery it returns immediately rather
  // than burning the full budget.
  test('slow delivery still passes, without a fixed wait', async ({ page }) => {
    const started = Date.now();
    await page.goto(`/?testScenario=slow-delivery&userId=${uniqueUser('slow')}`);

    await expect(page.getByTestId('campaign-popup')).toBeVisible({ timeout: 15_000 });

    // Proves the wait was genuinely state-based: it outlasted the 5s guess.
    expect(Date.now() - started).toBeGreaterThan(5_000);
  });

  // FIX 6 — isolation. A unique userId per run, so no previous run's
  // frequency cap can suppress this delivery.
  test('a fresh user is unaffected by previous runs', async ({ page }) => {
    await page.goto(`/?userId=${uniqueUser('iso-a')}`);
    await expect(page.getByTestId('campaign-popup')).toBeVisible({ timeout: 10_000 });

    await page.goto(`/?userId=${uniqueUser('iso-b')}`);
    await expect(page.getByTestId('campaign-popup')).toBeVisible({ timeout: 10_000 });
  });

  // FIX 7 — the negative case the submitted test never had.
  // Asserts absence with a bounded wait, so "no popup" is a verdict rather
  // than a race that happened to finish first.
  test('non-eligible user gets no popup', async ({ page }) => {
    await page.goto(`/?testUser=non-eligible&userId=${uniqueUser('nonelig')}`);

    await expect(page.getByTestId('campaign-popup')).toHaveCount(0, { timeout: 5_000 });
  });
});
