import { expect, test } from './fixtures';

test('chart display tools, focused view and Escape operate without affecting data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?demo=smc');
  const price = await page.locator('.price-stat strong').textContent();
  await page.getByRole('button', { name: '对数', exact: true }).click();
  await expect(page.getByRole('button', { name: '对数', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '磁吸', exact: true }).click();
  await expect(page.getByRole('button', { name: '磁吸', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '专注图表', exact: true }).click();
  await expect(page.locator('.workspace-grid')).toHaveClass(/chart-expanded/);
  await expect(page.locator('.analysis-panel')).toBeHidden();
  await expect(page.locator('.chart-host canvas').first()).toBeVisible();
  await page.getByRole('button', { name: '退出专注图表', exact: true }).press('Escape');
  await expect(page.getByRole('button', { name: '专注图表', exact: true })).toBeVisible();
  await expect(page.locator('.analysis-panel')).toBeVisible();
  await expect(page.locator('.price-stat strong')).toHaveText(price!);
  expect(errors).toEqual([]);
});
