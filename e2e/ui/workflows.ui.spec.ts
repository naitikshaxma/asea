import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DEMO_CASES, DEMO_REPO_PATH } from '../support/api.js';

// Drives the built UI through the real API. The e2e worker has no sandbox or
// reviewer, so a patch task must end blocked with those stages reported as
// not run/unavailable, never as passed.

async function register(page: Page, label: string): Promise<{ email: string; password: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@e2e.asea.invalid`;
  const password = 'e2e-Password-123!';
  await page.goto('/register');
  await page.getByLabel('Name').fill(`UI ${label}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).not.toHaveURL(/\/register$/);
  return { email, password };
}

async function addRepository(page: Page, name: string): Promise<void> {
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Add repository' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Path on the server').fill(DEMO_REPO_PATH);
  await dialog.getByRole('button', { name: 'Add repository' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

test('sign-in errors are shown and a session survives a reload', async ({ page }) => {
  const { email, password } = await register(page, 'ui-auth');
  await page.reload();
  await expect(page).not.toHaveURL(/\/login$/);

  const other = await page.context().browser()!.newContext();
  const fresh = await other.newPage();
  await fresh.goto('/login');
  await fresh.getByLabel('Email').fill(email);
  await fresh.getByLabel('Password').fill(`${password}-wrong`);
  await fresh.getByRole('button', { name: 'Sign in' }).click();
  await expect(fresh.getByRole('alert')).toBeVisible();
  await expect(fresh).toHaveURL(/\/login$/);
  await other.close();
});

test('repository setup, patch task progress and blocked evidence through the real worker', async ({ page }) => {
  await register(page, 'ui-patch');
  await addRepository(page, 'ui-demo-app');

  await page.goto('/tasks/new');
  await page.getByLabel('Title').fill('UI patch proposal');
  await page.getByLabel('Request').fill('Propose a small safe change to the registered demo repository.');
  await page.getByRole('button', { name: 'Create patch task' }).click();
  await expect(page).toHaveURL(/\/tasks\/[^/]+$/);

  // The page polls the API until the worker stores its result
  await expect(page.getByText(/needs attention/i).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Proposed patch', { exact: true })).toBeVisible();
  await expect(page.getByText('ASEA deterministic test proposal')).toBeVisible({ timeout: 30_000 });
  // Each stage is a <div><p>{stage}</p><Badge>{status}</Badge></div> in the patch card
  for (const [stage, status] of [['Tests', /not run/i], ['Security scan', /unavailable/i], ['Independent review', /unavailable/i]] as const) {
    await expect(page.locator(`div:has(> p:text-is("${stage}"))`).first()).toContainText(status);
  }
  await expect(page.getByText('Workflow history')).toBeVisible();

  await page.goto('/approvals');
  await expect(page.getByText('No pending approvals')).toBeVisible();
});

test('verification submission shows the engine verdict and its evidence', async ({ page }) => {
  const demo = DEMO_CASES.find((entry) => entry.case === 'clean') ?? DEMO_CASES[0]!;
  await register(page, 'ui-verify');
  await addRepository(page, 'ui-verify-app');

  await page.goto('/runs/new');
  const head = page.locator('#head');
  await expect(head).toBeEnabled();
  const headValue = await head.locator('option', { hasText: `${demo.branch} ·` }).first().getAttribute('value');
  const baseValue = await page.locator('#base option', { hasText: 'main ·' }).first().getAttribute('value');
  await page.locator('#base').selectOption(baseValue!);
  await head.selectOption(headValue!);
  await page.getByLabel('Title').fill(demo.title);
  await page.getByLabel('Requirement').fill(demo.requirement);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);

  const label = { ALLOW: 'Allow', REVIEW: 'Review', HIGH_RISK: 'High risk', BLOCK: 'Block' }[demo.expectedVerdict];
  await expect(page.getByText(new RegExp(`^${label}$`, 'i')).first()).toBeVisible({ timeout: 120_000 });
});

test('settings show the workspace, its members and the unconfigured GitHub App honestly', async ({ page }) => {
  const { email } = await register(page, 'ui-settings');
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText('Workspace members')).toBeVisible();
  await expect(page.getByText(email).first()).toBeVisible();
  await expect(page.getByText('GitHub App', { exact: true })).toBeVisible();
  await expect(page.getByText('Loading GitHub App configuration…')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText('Could not load GitHub App status')).toBeHidden();
});
