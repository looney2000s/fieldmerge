import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import pg from "pg";
import { MongoClient } from "mongodb";
assert(/^fieldmerge_test_[a-f0-9]+$/.test(process.env.FM_TEST_DATABASE));
const base = process.env.API_BASE,
  accounts = JSON.parse(
    readFileSync("tmp/database-fixtures/demo-accounts.json", "utf8"),
  );
const admin = new pg.Client({
  host: "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? 15432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.FM_TEST_DATABASE,
});
const mongo = new MongoClient(
  `mongodb://${encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME)}:${encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD)}@127.0.0.1:${process.env.MONGO_PORT ?? 27018}/?authSource=admin`,
);
const tree = "30000000-0000-4000-8000-000000000001",
  tree2 = "30000000-0000-4000-8000-000000000002";
const browser = await chromium.launch({ headless: true }),
  surveyor = await browser.newContext({
    baseURL: base,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  }),
  reviewer = await browser.newContext({
    baseURL: base,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
const s = await surveyor.newPage(),
  r = await reviewer.newPage(),
  errors = [],
  checks = [],
  a11y = [];
for (const page of [s, r]) page.on("pageerror", (e) => errors.push(e.message));
mkdirSync("output/browser", { recursive: true });
async function passed(name) {
  checks.push(name);
  console.log("PASS " + name);
}
async function accessible(page, name) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  a11y.push({
    page: name,
    violations: result.violations.map((x) => ({
      id: x.id,
      impact: x.impact,
      nodes: x.nodes.map((n) => n.target),
    })),
  });
  if (result.violations.length)
    console.log(
      "Accessibility findings on " +
        name +
        ": " +
        JSON.stringify(a11y.at(-1).violations),
    );
}
async function ready(page, heading) {
  await expect(
    page.getByRole("heading", { name: heading, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".spinner")).toHaveCount(0);
}
async function login(page, account) {
  await page.goto("/login");
  await ready(page, "Sign in to FieldMerge");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await ready(page, "Records");
  await expect(
    page.getByRole("link", { name: "DEMO-1", exact: true }),
  ).toBeVisible();
}
async function json(context, url, body) {
  const response = await context.request.post(url, {
    headers: { Origin: base },
    data: body,
  });
  assert.equal(response.status(), 200, "Fixture mutation " + url);
  return response.json();
}
async function draft(record, version = 1) {
  await s.goto("/drafts/new?record_id=" + record + "&version=" + version);
  await ready(s, "Create a draft");
  await s.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(
    s.getByRole("heading", { name: "Proposed fields", exact: true }),
  ).toBeVisible();
  return s.url().split("/").at(-1);
}
async function field(name, value) {
  await s
    .getByLabel(name + " action", { exact: true })
    .selectOption(value === null ? "clear" : "set");
  if (value !== null) {
    const input = s.getByLabel(name + " value", { exact: true });
    if (["Health", "Guard damage"].includes(name))
      await input.selectOption(String(value));
    else await input.fill(String(value));
  }
}
async function save() {
  await s
    .getByLabel("Observed at (your local time)", { exact: true })
    .fill("2026-06-01T10:00:00");
  await s.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    s.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeDisabled();
  await expect(s.getByText("Saved revision", { exact: true })).toBeVisible();
}
async function finalize() {
  await s.getByRole("button", { name: "Finalize draft", exact: true }).click();
  await expect(
    s.getByRole("heading", { name: "Per-field outcomes", exact: true }),
  ).toBeVisible();
  return s.url().split("/").at(-1);
}
async function screenshot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "output/browser/" + name + ".png",
    fullPage: true,
  });
}
async function downloaded(page, button) {
  const wait = page.waitForEvent("download");
  await button.click();
  const download = await wait;
  assert.equal(await download.failure(), null);
  return readFileSync(await download.path(), "utf8");
}
try {
  await admin.connect();
  await mongo.connect();
  await s.goto("/records");
  await expect(s).toHaveURL(/\/login$/);
  await accessible(s, "login");
  await screenshot(s, "login");
  await login(s, accounts[0]);
  await s.getByLabel("Record ID", { exact: true }).fill("DEMO-1");
  await s.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(s.locator("tbody tr")).toHaveCount(1);
  await accessible(s, "records");
  await screenshot(s, "records");
  await s.getByRole("link", { name: "DEMO-1", exact: true }).click();
  await ready(s, "DEMO-1");
  const snapshot = JSON.parse(
    await downloaded(
      s,
      s.getByRole("button", { name: "Download snapshot", exact: true }),
    ),
  );
  assert.equal(snapshot.record.version_no, 1);
  assert.equal(snapshot.record.record_id, tree);
  await passed(
    "Authentication, literal filters, accepted snapshot and exact base download",
  );
  const draftA = await draft(tree);
  await field("Trunk diameter", "32");
  await save();
  const draftB = await draft(tree);
  await field("Trunk diameter", "36");
  await field("Health", "Fair");
  await s.getByRole("button", { name: "Add observation", exact: true }).click();
  await s
    .getByLabel("Observation note", { exact: true })
    .fill("Synthetic guard damage observed near the north side.");
  await s.getByLabel("Category", { exact: true }).selectOption("guard");
  await s.getByRole("button", { name: "Add observation", exact: true }).click();
  await s
    .getByLabel("Observation note", { exact: true })
    .nth(1)
    .fill("Synthetic root inspection: surface roots visible.");
  await s.getByLabel("Category", { exact: true }).nth(1).selectOption("root");
  await save();
  await accessible(s, "draft editor");
  await screenshot(s, "draft");
  const originalFile = await downloaded(
    s,
    s.getByRole("button", { name: "Download upload file", exact: true }),
  );
  assert.equal(JSON.parse(originalFile)[0].base_version_no, 1);
  assert.equal(JSON.parse(originalFile)[0].observations.length, 2);
  await s.goto("/drafts/" + draftA);
  await ready(s, "DEMO-1");
  await finalize();
  await expect(s.locator(".heading-actions .status")).toHaveText("applied");
  await s.goto("/drafts/" + draftB);
  await ready(s, "DEMO-1");
  const conflict = await finalize();
  await expect(s.locator(".heading-actions .status")).toHaveText(
    "partially applied",
  );
  await expect(
    s.getByText("Synthetic root inspection: surface roots visible.", {
      exact: true,
    }),
  ).toBeVisible();
  const snapshot3 = (
    await admin.query(
      "SELECT * FROM fieldmerge.accepted_versions WHERE record_id=$1 ORDER BY version_no DESC LIMIT 1",
      [tree],
    )
  ).rows[0];
  assert.equal(snapshot3.version_no, 3);
  assert.equal(snapshot3.diameter_cm, "32");
  assert.equal(snapshot3.health, "Fair");
  assert.equal(
    (
      await mongo
        .db(process.env.MONGODB_DATABASE)
        .collection("submission_documents")
        .findOne({ _id: conflict })
    ).payload.observations.length,
    2,
  );
  await accessible(s, "submission outcome");
  await passed(
    "Two stale-base drafts: compatible field publishes, conflicting field waits, repeated evidence survives in MongoDB",
  );
  await draft(tree2);
  await field("Trunk diameter", "0");
  await field("Guard damage", false);
  await field("Health", null);
  await save();
  await finalize();
  const zero = (
    await admin.query(
      "SELECT * FROM fieldmerge.accepted_versions WHERE record_id=$1 ORDER BY version_no DESC LIMIT 1",
      [tree2],
    )
  ).rows[0];
  assert.equal(zero.diameter_cm, "0");
  assert.equal(zero.guard_damage, false);
  assert.equal(zero.health, null);
  await passed(
    "Explicit zero, false and unknown survive browser form, API and SQL publication",
  );
  await login(r, accounts[1]);
  await r.getByRole("link", { name: "Review queue", exact: true }).click();
  await ready(r, "Review queue");
  await r
    .getByRole("button", { name: /Compare DEMO-1 Trunk diameter/ })
    .click();
  await expect(
    r.getByRole("heading", { name: "DEMO-1 · Trunk diameter", exact: true }),
  ).toBeVisible();
  for (const text of ["30 cm", "32 cm", "36 cm"])
    await expect(r.locator(".comparison-grid")).toContainText(text);
  await json(surveyor, "/api/submissions", {
    client_submission_id: randomUUID(),
    record_id: tree,
    base_version_no: 3,
    form_version: "tree-v2",
    observed_at: "2026-06-01T00:00:00Z",
    patch: { guard_damage: false },
  });
  await r
    .getByLabel("Decision reason", { exact: true })
    .fill("Synthetic review before a concurrent accepted change.");
  await r.getByRole("button", { name: "Record decision", exact: true }).click();
  await expect(
    r.getByText("Refresh and reconsider before deciding.", { exact: true }),
  ).toBeVisible();
  assert.equal(
    (await admin.query("SELECT count(*) FROM fieldmerge.review_decisions"))
      .rows[0].count,
    "0",
  );
  await expect(
    r.getByRole("button", { name: "Retry exact decision", exact: true }),
  ).toBeDisabled();
  await r
    .getByRole("button", { name: "Refresh comparison", exact: true })
    .click();
  await expect(r.locator(".comparison-grid")).toContainText("v4");
  await expect(r.getByLabel("Decision reason", { exact: true })).toHaveValue(
    "",
  );
  await passed(
    "Concurrent accepted change rejects stale review; manual refresh requires a fresh reason",
  );
  await r
    .getByLabel("Decision reason", { exact: true })
    .fill(
      "Synthetic evidence supports the proposed diameter after refreshed comparison.",
    );
  await accessible(r, "review comparison");
  await screenshot(r, "review");
  let lost = true;
  const decisions = [];
  const intercept = async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    decisions.push(route.request().postData());
    if (lost) {
      lost = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort("failed");
    } else await route.continue();
  };
  await r.route("**/api/reviews/*", intercept);
  await r.getByRole("button", { name: "Record decision", exact: true }).click();
  await expect(
    r.getByText("The last response is unconfirmed.", { exact: false }),
  ).toBeVisible();
  await r.reload();
  await ready(r, "Review queue");
  await r
    .getByRole("button", {
      name: "Resume DEMO-1 · Trunk diameter",
      exact: true,
    })
    .click();
  await r
    .getByRole("button", { name: "Retry exact decision", exact: true })
    .click();
  await expect(r.getByText("Decision recorded", { exact: true })).toBeVisible();
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0], decisions[1]);
  assert.equal(
    (await admin.query("SELECT count(*) FROM fieldmerge.review_decisions"))
      .rows[0].count,
    "1",
  );
  assert.equal(
    (
      await admin.query(
        "SELECT max(version_no) AS n FROM fieldmerge.accepted_versions WHERE record_id=$1",
        [tree],
      )
    ).rows[0].n,
    5,
  );
  await r.unroute("**/api/reviews/*", intercept);
  await passed(
    "Lost review response, page reload, exact-intent retry: one decision and one accepted version",
  );
  await s.goto("/batches");
  await ready(s, "Batch uploads");
  const good = JSON.parse(originalFile)[0],
    bad = {
      ...good,
      client_submission_id: randomUUID(),
      patch: { diameter_cm: -1 },
    };
  await s.locator("#batch-file").setInputFiles({
    name: "synthetic-mixed.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify([good, bad])),
  });
  await s.getByRole("button", { name: "Upload batch", exact: true }).click();
  await expect(
    s.getByRole("heading", { name: "Upload results", exact: true }),
  ).toBeVisible();
  await expect(
    s.getByRole("cell", { name: "Upload error", exact: true }),
  ).toBeVisible();
  const inspect = s.getByRole("link", {
      name: "Inspect durable batch outcome",
      exact: true,
    }),
    href = await inspect.getAttribute("href");
  await s.getByRole("button", { name: "Retry same file", exact: true }).click();
  await expect(inspect).toHaveAttribute("href", href);
  await accessible(s, "batch upload");
  await screenshot(s, "batch");
  await inspect.click();
  await expect(
    s.getByRole("cell", { name: /Enter a diameter from 0 to 999999.99/ }),
  ).toBeVisible();
  await passed(
    "Mixed batch independently reports errors; unchanged file retry retains durable batch identity",
  );
  await s.goto("/records/" + tree);
  await ready(s, "DEMO-1");
  await expect(s.locator(".provenance-list")).toContainText(
    "Synthetic evidence supports the proposed diameter",
  );
  await s.getByRole("button", { name: "View v1", exact: true }).click();
  await expect(s.locator(".value-grid")).toContainText("30 cm");
  await expect(s.getByText("Version 1", { exact: true })).toBeVisible();
  await passed(
    "Historical snapshots and reviewer-linked field provenance remain inspectable",
  );
  await r.goto("/reports");
  await ready(r, "Reports & exports");
  await expect(
    r.getByRole("heading", { name: "Source evidence aggregates", exact: true }),
  ).toBeVisible();
  await r.locator(".source-details summary").click();
  await accessible(r, "reports");
  await screenshot(r, "reports");
  const exported = JSON.parse(
    await downloaded(
      r,
      r.getByRole("button", { name: "Download JSON", exact: true }),
    ),
  );
  const exportRows = Array.isArray(exported) ? exported : exported.records;
  const exportedZero = exportRows.find((x) => x.record_id === tree2);
  assert.equal(Number(exportedZero.diameter_cm), 0);
  assert.equal(exportedZero.guard_damage, false);
  assert.equal(exportedZero.health, null);
  const csv = await downloaded(
    r,
    r.getByRole("button", { name: "Download CSV", exact: true }),
  );
  assert(csv.includes("DEMO-2"));
  await passed(
    "Reviewer SQL/Mongo summaries render and downloaded exports retain false, zero and null",
  );
  await r.goto("/recovery");
  await ready(r, "Recovery");
  await expect(
    r.getByRole("link", { name: "Inspect", exact: true }).first(),
  ).toBeVisible();
  await r.getByRole("link", { name: "Inspect", exact: true }).first().click();
  await expect(
    r.getByRole("heading", { name: "Operational event history", exact: true }),
  ).toBeVisible();
  await accessible(r, "recovery job");
  await passed(
    "Recovery status and event history render without worker credentials",
  );
  await s.goto("/reports");
  await ready(s, "Access restricted");
  assert.equal(
    (await surveyor.request.get("/api/reports/summary")).status(),
    403,
  );
  await r.goto("/drafts");
  await ready(r, "Access restricted");
  assert.equal((await reviewer.request.get("/api/drafts")).status(), 403);
  await passed(
    "Both interface role gates and API role enforcement deny wrong-role operations",
  );
  const deleting = await draft(tree2, 2);
  await s.getByRole("button", { name: "Delete draft", exact: true }).click();
  await ready(s, "My drafts");
  assert.equal(
    await mongo
      .db(process.env.MONGODB_DATABASE)
      .collection("draft_documents")
      .countDocuments({ _id: deleting }),
    0,
  );
  await passed("Editable draft deletion removes only the owner draft");
  const finalizing = await draft("30000000-0000-4000-8000-000000000003");
  await field("Trunk diameter", "21.25");
  await save();
  let dropFinalize = true;
  const finalRequests = [];
  const finalizeRoute = async (route) => {
    finalRequests.push(route.request().postData());
    if (dropFinalize) {
      dropFinalize = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort("failed");
    } else await route.continue();
  };
  await s.route("**/api/drafts/" + finalizing + "/finalize", finalizeRoute);
  await s.getByRole("button", { name: "Finalize draft", exact: true }).click();
  await expect(
    s.getByRole("button", { name: "Retry finalization", exact: true }),
  ).toBeEnabled();
  await s
    .getByRole("button", { name: "Retry finalization", exact: true })
    .click();
  await expect(
    s.getByRole("heading", { name: "Per-field outcomes", exact: true }),
  ).toBeVisible();
  assert.equal(finalRequests.length, 2);
  assert.equal(finalRequests[0], finalRequests[1]);
  assert.equal(
    (
      await admin.query(
        "SELECT count(*) FROM fieldmerge.accepted_versions WHERE record_id=$1",
        ["30000000-0000-4000-8000-000000000003"],
      )
    ).rows[0].count,
    "2",
  );
  await s.unroute("**/api/drafts/" + finalizing + "/finalize", finalizeRoute);
  await passed(
    "Lost finalization response retries the sealed revision without duplicate publication",
  );
  await s.goto("/records");
  await ready(s, "Records");
  await s.keyboard.press("Tab");
  await expect(
    s.getByRole("link", { name: "Skip to content", exact: true }),
  ).toBeFocused();
  await s.keyboard.press("Enter");
  await expect(s.locator("#main-content")).toBeFocused();
  await passed("Keyboard skip link moves focus directly to main content");
  await s.setViewportSize({ width: 390, height: 844 });
  await s.goto("/records");
  await ready(s, "Records");
  assert(
    await s.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    JSON.stringify(
      await s.evaluate(() =>
        Array.from(document.querySelectorAll("body *"))
          .filter(
            (e) =>
              e.getBoundingClientRect().right > innerWidth + 1 &&
              getComputedStyle(e).position !== "absolute",
          )
          .map((e) => ({
            tag: e.tagName,
            class: e.className,
            width: e.getBoundingClientRect().width,
            right: e.getBoundingClientRect().right,
            overflow: getComputedStyle(e).overflow,
          }))
          .slice(0, 30),
      ),
    ),
  );
  await s.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(
    s.getByRole("link", { name: "My drafts", exact: true }),
  ).toBeVisible();
  await s.getByRole("link", { name: "My drafts", exact: true }).click();
  await ready(s, "My drafts");
  await accessible(s, "mobile drafts");
  await screenshot(s, "mobile");
  await passed(
    "Mobile layout contains table overflow and navigation works at 390px",
  );
  await s.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(s).toHaveURL(/\/login$/);
  assert.equal((await surveyor.request.get("/api/records")).status(), 401);
  await passed("Sign out revokes the server session");
  assert.deepEqual(errors, [], "Browser runtime errors");
  assert.deepEqual(
    a11y.filter((x) => x.violations.length),
    [],
    "Accessibility findings must be fixed",
  );
  writeFileSync(
    "output/browser/checks.json",
    JSON.stringify(
      { checks, accessibility: a11y, browser_errors: errors },
      null,
      2,
    ),
  );
} catch (e) {
  await s
    .screenshot({ path: "tmp/browser-surveyor-failure.png", fullPage: true })
    .catch(() => {});
  await r
    .screenshot({ path: "tmp/browser-reviewer-failure.png", fullPage: true })
    .catch(() => {});
  writeFileSync(
    "tmp/browser-failure.json",
    JSON.stringify(
      { checks, accessibility: a11y, browser_errors: errors },
      null,
      2,
    ),
  );
  throw e;
} finally {
  await browser.close();
  await admin.end();
  await mongo.close();
}
