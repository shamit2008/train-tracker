/* The train page, ordered for passengers (Phase 1 of docs/implementation-plan.md). */
import { test, expect } from '@playwright/test';
import { openSite, openSheet, addRunningTrip } from './helpers.mjs';

test('status and stops come first; speed and charts wait under More details', async ({ page }) => {
  await openSite(page);
  await openSheet(page);
  await page.locator('#list .row').first().click();
  const more = page.locator('#detail details.d-more');
  await expect(more).not.toHaveAttribute('open', '');
  await expect(more.locator('.facts')).toBeHidden();
  // the stop list sits before More details in the page
  const order = await page.locator('#detail .detail > *').evaluateAll((els) => els.map((e) => e.className.split(' ')[0]));
  expect(order.indexOf('tt')).toBeLessThan(order.indexOf('d-more'));
  // it opens (phones have a "Details" jump button for it), and stays open when the page refreshes
  const phone = page.viewportSize().width < 560;
  await (phone ? page.locator('[data-jump=".d-more"]') : more.locator('summary')).click();
  await expect(more.locator('.facts')).toBeVisible();
  await page.locator(phone ? '#mapLive' : '#refresh').click();
  await expect(page.locator('#detail details.d-more .facts')).toBeVisible();
});

test('a train in your trips says when it reaches your stop', async ({ page }) => {
  await openSite(page);
  await addRunningTrip(page);
  await page.locator('#tab-home').click();
  await page.locator('[data-hero="track"]').click();
  await expect(page.locator('#detail .d-yours')).toContainText('Your stop:');
});
