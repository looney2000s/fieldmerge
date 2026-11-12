import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
assert(
  /^fieldmerge_test_[a-f0-9]{32}$/.test(process.env.FM_TEST_DATABASE ?? ""),
);
const base = process.env.API_BASE,
  accounts = JSON.parse(
    readFileSync("tmp/database-fixtures/demo-accounts.json", "utf8"),
  );
const browser = await chromium.launch({ headless: true }),
  contexts = [],
  checks = [],
  errors = [];
async function signIn(account) {
  const c = await browser.newContext({
    baseURL: base,
    viewport: { width: 1440, height: 1000 },
  });
  contexts.push(c);
  const p = await c.newPage();
  p.on("pageerror", (e) => errors.push(e.name));
  await p.goto("/login");
  await p.getByLabel("Email address").fill(account.email);
  await p.getByLabel("Password", { exact: true }).fill(account.password);
  await p.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    p.getByRole("heading", { name: "Records", exact: true }),
  ).toBeVisible();
  return { context: c, page: p };
}
try {
  const { context: s, page } = await signIn(accounts[0]);
  const cookie = (await s.cookies()).find(
    (x) => x.name === "fieldmerge_session",
  );
  assert(cookie?.httpOnly);
  assert.equal(cookie.sameSite, "Strict");
  assert.equal(
    await page.evaluate(() => document.cookie.includes("fieldmerge_session")),
    false,
  );
  checks.push(
    "Session cookie is HttpOnly/SameSite Strict and absent from document.cookie",
  );
  const record = "30000000-0000-4000-8000-000000000003",
    species = '<svg onload="window.__fm_xss=1">',
    note =
      '<img src=x onerror="window.__fm_xss=1"></pre><script>window.__fm_xss=1</script>';
  const p = {
    client_submission_id: randomUUID(),
    record_id: record,
    base_version_no: 1,
    form_version: "tree-v2",
    observed_at: "2026-06-01T00:00:00Z",
    patch: { species },
    observations: [
      { category: "other", note, observed_at: "2026-06-01T00:00:00Z" },
    ],
    client_metadata: { markup: note },
  };
  const response = await page.request.post("/api/submissions", {
    headers: { Origin: base },
    data: p,
  });
  assert.equal(response.status(), 200);
  const submitted = await response.json();
  for (const role of ["surveyor", "reviewer"]) {
    const target = role === "surveyor" ? { page } : await signIn(accounts[1]);
    const q = target.page;
    await q.goto("/submissions/" + submitted.submission_id);
    await expect(
      q.getByRole("heading", { name: "Original source evidence", exact: true }),
    ).toBeVisible();
    await expect(q.getByText(note, { exact: true })).toBeVisible();
    await q
      .getByText("Original envelope and metadata", { exact: true })
      .click();
    const canonicalSource = JSON.parse(await q.locator("pre").textContent());
    assert.equal(canonicalSource.observations[0].note, note);
    assert.equal(canonicalSource.client_metadata.markup, note);
    assert.equal(await q.evaluate(() => window.__fm_xss), undefined);
    assert.equal(
      await q.locator("main [onerror], main [onload], main img").count(),
      0,
    );
    checks.push(role + " source evidence renders stored markup as text");
  }
  await page.goto("/records/" + record);
  await expect(page.getByText(species, { exact: true }).first()).toBeVisible();
  assert.equal(await page.locator("main svg[onload]").count(), 0);
  assert.equal(await page.evaluate(() => window.__fm_xss), undefined);
  checks.push("Accepted species markup remains escaped in record details");
  mkdirSync("output/security", { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "output/security/escaped-record.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  assert.equal((await s.request.get("/api/records")).status(), 401);
  checks.push("Signing out revokes protected reads");
  assert.deepEqual(errors, []);
  writeFileSync(
    "output/security/browser.json",
    JSON.stringify(
      {
        verified_at_utc: new Date().toISOString(),
        checks,
        runtime_errors: errors,
      },
      null,
      2,
    ) + "\n",
  );
  for (const c of checks) console.log("PASS " + c);
} catch (error) {
  // Playwright assertion snapshots can contain password-input values. Never emit them.
  console.error(JSON.stringify({
    event: "security_browser_check_failed",
    completed_checks: checks.length,
    error_type: error instanceof assert.AssertionError ? "assertion" : "browser_check",
  }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
