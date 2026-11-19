import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { configureBackend } from "./configure-backend.mjs";
const run = promisify(execFile),
  root = process.cwd();
const browserMode = process.argv.includes("--browser");
const acceptanceMode = process.argv.includes("--acceptance");
const securityMode = process.argv.includes("--security");
if (
  [browserMode, acceptanceMode, securityMode].filter(Boolean).length > 1 ||
  process.argv
    .slice(2)
    .some((x) => !["--browser", "--acceptance", "--security"].includes(x))
)
  throw new Error("Unknown test argument");
const docker =
  process.env.DOCKER_EXE ??
  path.join(
    process.env.USERPROFILE ?? "C:/Users/abdullah",
    "AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe",
  );
const name = "fieldmerge_test_" + randomUUID().replaceAll("-", "");
const composeArgs = [
  "compose",
  "--project-directory",
  root,
  "-f",
  path.join(root, "compose.yaml"),
];
if (acceptanceMode) {
  if (
    !/^fieldmerge-acceptance-[a-f0-9]{32}$/.test(
      process.env.FM_TEST_COMPOSE_PROJECT ?? "",
    )
  )
    throw new Error("Acceptance requires a disposable project");
  const override = path.resolve(process.env.FM_TEST_COMPOSE_OVERRIDE ?? "");
  if (path.dirname(override) !== path.join(root, "tmp"))
    throw new Error("Unexpected test override path");
  composeArgs.push("-p", process.env.FM_TEST_COMPOSE_PROJECT, "-f", override);
}
const args = [...composeArgs, "exec", "-T"];
const pgService = acceptanceMode ? "postgres-test" : "postgres",
  mongoService = acceptanceMode ? "mongo-test" : "mongo";
async function command(tail) {
  return (await run(docker, [...args, ...tail], { maxBuffer: 4 * 1024 * 1024 }))
    .stdout;
}
const admin = new pg.Client({
  host: "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? 15432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: "fieldmerge",
});
let server;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  for (const file of readdirSync("database/postgres/migrations")
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256")
      .update(readFileSync("database/postgres/migrations/" + file))
      .digest("hex");
    await command([
      pgService,
      "psql",
      "-X",
      "-U",
      "fieldmerge_owner",
      "-d",
      name,
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "migration_hash=" + hash,
      "-f",
      "/database/postgres/migrations/" + file,
    ]);
  }
  await command([
    pgService,
    "psql",
    "-X",
    "-U",
    "fieldmerge_owner",
    "-d",
    name,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    "/fixtures/seed.sql",
  ]);
  for (const script of ["initialize", "seed"])
    await command([
      "-e",
      "FM_DB=" + name,
      mongoService,
      "mongosh",
      "--quiet",
      "--file",
      `/database/mongodb/${script}.js`,
    ]);
  const config = await configureBackend({
    pgDatabase: name,
    mongoDatabase: name,
    save: false,
  });
  const env = {
    ...process.env,
    ...config,
    APP_ORIGIN: "http://127.0.0.1:3100",
    API_BASE: "http://127.0.0.1:3100",
    FM_TEST_DATABASE: name,
    NEXT_TELEMETRY_DISABLED: "1",
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, "tmp/playwright-browsers"),
    SECURITY_LOG_DIR: path.join(root, "tmp/security-events", name),
  };
  const log = [];
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3100",
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  server.stdout.on("data", (x) => log.push(x.toString()));
  server.stderr.on("data", (x) => log.push(x.toString()));
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null)
      throw new Error("API server exited: " + log.join("").slice(-2000));
    try {
      ready = (await fetch(env.API_BASE + "/api/auth/me")).status === 401;
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error("API server not ready");
  console.log("Testing production Next.js server against isolated databases.");
  const child = spawn(
    process.execPath,
    securityMode
      ? ["tests/security/run.mjs"]
      : acceptanceMode
        ? [
            "--test",
            "--test-concurrency=1",
            "tests/acceptance/scenarios.test.mjs",
          ]
        : browserMode
          ? ["tests/browser/workflow.mjs"]
          : [
              "--test",
              "--test-concurrency=1",
              "tests/api/integration.test.mjs",
              "tests/api/recovery.test.mjs",
              "tests/api/queries-batches.test.mjs",
            ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const output = [];
  child.stdout.on("data", (x) => {
    process.stdout.write(x);
    output.push(x.toString());
  });
  child.stderr.on("data", (x) => {
    process.stderr.write(x);
    output.push(x.toString());
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 0)
    throw new Error(
      securityMode
        ? "Security boundary checks failed"
        : acceptanceMode
          ? "Acceptance scenario checks failed"
          : browserMode
            ? "Browser workflow checks failed"
            : "API integration checks failed",
    );
  const destination = securityMode
    ? "output/security"
    : acceptanceMode
      ? "output/acceptance"
      : browserMode
        ? "output/browser"
        : "output/api";
  mkdirSync(destination, { recursive: true });
  if (securityMode) {
    const files = [
      "scripts/test-api.mjs",
      "tests/security/run.mjs",
      "tests/security/transport.test.mjs",
      "tests/security/browser.mjs",
      "tests/api/security-events.test.mjs",
      "lib/security-events.mjs",
      "lib/http.mjs",
      "lib/auth.mjs",
      "lib/envelope.mjs",
      "database/mongodb/model.js",
      "app/api/operations/security-events/route.js",
      ...readdirSync("database/postgres/migrations")
        .sort()
        .map((x) => "database/postgres/migrations/" + x),
    ];
    writeFileSync(
      destination + "/source-checksums.json",
      JSON.stringify(Object.fromEntries(files.map((file) => [
        file, createHash("sha256").update(readFileSync(file)).digest("hex"),
      ])), null, 2) + "\n",
    );
  }
  writeFileSync(
    destination + "/verification.json",
    JSON.stringify(
      {
        verified_at_utc: new Date().toISOString(),
        test_database: name,
        production_server: true,
        ...(acceptanceMode
          ? {
              requirements: "docs/FieldMerge_Requirements.md",
              scenario_report: "output/acceptance/scenarios.json",
            }
          : {}),
        output: output.join(""),
        remaining:
          "Recorded verification results for this run; see output/pdf/FieldMerge_Project_Report.pdf for the implemented scope and limitations.",
      },
      null,
      2,
    ),
  );
  console.log(
    "Verification passed; evidence saved to " +
      destination +
      "/verification.json.",
  );
} finally {
  if (server) {
    server.kill();
    await new Promise((r) => {
      if (server.exitCode !== null) return r();
      server.once("exit", r);
      setTimeout(r, 3000).unref();
    });
  }
  await admin.end();
}
