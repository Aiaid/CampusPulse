import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

// Controlled cosmetic-filter regression, not a bundled blocker subscription.
// Safari's observed .ad-sidebar rule and the generic .ad-main rule can hide
// the entire workspace. Include adjacent generic tokens to exercise panels,
// forms and dialogs throughout the existing real-API browser smoke flows.
const cosmeticCSS = `
  .ad-sidebar, .ad-main, .ad-panel, .ad-header, .ad-page-header,
  .ad-nav-item, .ad-stats, .ad-metric, .ad-account-summary,
  .ad-auth, .ad-login-card, .ad-dialog, .ad-table-scroll, .ad-three-values {
    display: none !important;
  }
`;

export async function installAdminCosmeticFilter(context) {
  // Install for each document, including the management smoke's reload. This
  // changes only test CSS; all page data and authentication use the real Worker.
  await context.addInitScript(css => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.dataset.adminCosmeticFilterFixture = 'true';
      style.textContent = css;
      document.head.append(style);
    }, { once: true });
  }, cosmeticCSS);
}

export async function assertAdminViewVisible(page, title, panelTitle) {
  const fixtureActive = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'ad-sidebar';
    document.body.append(probe);
    const hidden = getComputedStyle(probe).display === 'none';
    probe.remove();
    return hidden;
  });
  assert.ok(fixtureActive, 'Controlled cosmetic-filter CSS must actively hide its matching probe');

  const main = page.getByRole('main');
  const navigation = page.getByRole('navigation', { name: '管理导航' });
  const sidebar = page.locator('aside').filter({ has: navigation });
  const heading = main.getByRole('heading', { name: title, exact: true });
  const panelHeading = main.getByRole('heading', { name: panelTitle, exact: true });
  const panel = main.locator('section').filter({ has: page.getByRole('heading', { name: panelTitle, exact: true }) });
  for (const element of [main, navigation, sidebar, heading, panelHeading, panel]) {
    await expect(element).toBeVisible();
    assert.notEqual(await element.evaluate(el => getComputedStyle(el).display), 'none', 'Admin content must survive generic cosmetic filters');
  }
  await expect(navigation.getByRole('button', { name: title, exact: true })).toHaveAttribute('aria-current', 'page');

  const [mainBox, sidebarBox, navBox, panelBox] = await Promise.all([main.boundingBox(), sidebar.boundingBox(), navigation.boundingBox(), panel.boundingBox()]);
  const { width } = page.viewportSize();
  assert.ok(mainBox && mainBox.width >= Math.min(700, width - 2) && mainBox.height > 250, 'Admin main must retain usable geometry');
  assert.ok(panelBox && panelBox.width >= 240 && panelBox.height >= 100, 'Admin panel must retain readable geometry');
  assert.ok(sidebarBox && navBox && navBox.width >= 160 && navBox.height >= 40, 'Admin navigation must retain usable geometry');
  if (width > 800) {
    assert.ok(sidebarBox.width >= 160 && sidebarBox.height >= 500 && mainBox.x >= sidebarBox.x + sidebarBox.width - 1, 'Desktop sidebar must remain beside the main workspace');
  } else {
    assert.ok(sidebarBox.width >= width - 2 && mainBox.y >= sidebarBox.y + sidebarBox.height - 1, 'Phone navigation must remain above the main workspace');
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Filtered administrator layout must fit the viewport');
}
