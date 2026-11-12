import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
process.loadEnvFile(".env");
const options = process.argv.slice(2).filter((x) => x !== "--");
if (options.some((x) => x !== "--keep"))
  throw new Error("Only --keep is supported");
const keep = options.includes("--keep"),
  root = process.cwd(),
  run = promisify(execFile);
const project = "fieldmerge-performance-" + randomUUID().replaceAll("-", "");
const database = "fieldmerge_test_" + randomUUID().replaceAll("-", "");
const docker =
  process.env.DOCKER_EXE ??
  path.join(
    process.env.USERPROFILE,
    "AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe",
  );
mkdirSync("tmp", { recursive: true });
mkdirSync("output/performance/plans", { recursive: true });
const override = path.join(root, "tmp", project + ".json");
writeFileSync(
  override,
  JSON.stringify({
    services: {
      "postgres-test": { ports: ["127.0.0.1::5432"] },
      "mongo-test": { ports: ["127.0.0.1::27017"] },
    },
  }),
);
const compose = [
  "compose",
  "--project-directory",
  root,
  "-p",
  project,
  "-f",
  path.join(root, "compose.yaml"),
  "-f",
  override,
  "--profile",
  "test",
];
async function command(args) {
  return (
    await run(docker, args, { timeout: 240000, maxBuffer: 8 * 1024 * 1024 })
  ).stdout.trim();
}
function port(value) {
  const match = value.match(/^127\.0\.0\.1:(\d+)$/);
  if (!match) throw new Error("Expected loopback-only test port");
  return match[1];
}
const verification = {
  started_at_utc: new Date().toISOString(),
  status: "running",
  project,
  database,
  development_data_modified: false,
  kept_for_inspection: false,
  cleanup_completed: false,
};
function report() {
  writeFileSync(
    "output/performance/verification.json",
    JSON.stringify(verification, null, 2) + "\n",
  );
}
report();
let failure,
  passed = false;
try {
  console.log(
    "Starting disposable measurement services; development data is untouched.",
  );
  await command([
    ...compose,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "180",
    "postgres-test",
    "mongo-test",
  ]);
  const pgPort = port(
      await command([...compose, "port", "postgres-test", "5432"]),
    ),
    mongoPort = port(
      await command([...compose, "port", "mongo-test", "27017"]),
    );
  await command([
    ...compose,
    "exec",
    "-T",
    "postgres-test",
    "createdb",
    "-U",
    "fieldmerge_owner",
    database,
  ]);
  const migrationHashes = {};
  for (const file of readdirSync("database/postgres/migrations")
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const hash = createHash("sha256")
      .update(readFileSync("database/postgres/migrations/" + file))
      .digest("hex");
    migrationHashes[file] = hash;
    await command([
      ...compose,
      "exec",
      "-T",
      "postgres-test",
      "psql",
      "-X",
      "-q",
      "-U",
      "fieldmerge_owner",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "migration_hash=" + hash,
      "-f",
      "/database/postgres/migrations/" + file,
    ]);
  }
  await command([
    ...compose,
    "exec",
    "-T",
    "postgres-test",
    "psql",
    "-X",
    "-q",
    "-U",
    "fieldmerge_owner",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    "/fixtures/seed.sql",
  ]);
  for (const script of ["initialize", "seed"])
    await command([
      ...compose,
      "exec",
      "-T",
      "-e",
      "FM_DB=" + database,
      "mongo-test",
      "mongosh",
      "--quiet",
      "--file",
      "/database/mongodb/" + script + ".js",
    ]);
  const engine = JSON.parse(
    await command([
      "info",
      "--format",
      '{"cpus":{{.NCPU}},"memory_bytes":{{.MemTotal}}}',
    ]),
  );
  const containers = {};
  for (const service of ["postgres-test", "mongo-test"]) {
    const id = await command([...compose, "ps", "-q", service]);
    const [info] = JSON.parse(await command(["inspect", id]));
    if (info.Config.Labels["com.docker.compose.project"] !== project)
      throw new Error("Unexpected container identity");
    containers[service] = {
      image_reference: info.Config.Image,
      image_id: info.Image,
      memory_limit_bytes: info.HostConfig.Memory,
      nano_cpus_limit: info.HostConfig.NanoCpus,
    };
  }
  writeFileSync(
    "output/performance/environment.json",
    JSON.stringify(
      {
        node: process.version,
        pnpm: "See pnpm-lock.yaml",
        host: {
          platform: os.platform(),
          release: os.release(),
          cpu: os.cpus()[0]?.model,
          logical_cpus: os.cpus().length,
          total_memory_bytes: os.totalmem(),
        },
        docker_engine: engine,
        containers,
        migration_checksums: migrationHashes,
      },
      null,
      2,
    ) + "\n",
  );
  const env = {
    ...process.env,
    DOCKER_EXE: docker,
    POSTGRES_PORT: pgPort,
    MONGO_PORT: mongoPort,
    FM_TEST_DATABASE: database,
    FM_PERF_PROJECT: project,
    FM_PERF_OVERRIDE: override,
  };
  const child = spawn(process.execPath, ["scripts/performance/run.mjs"], {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0)
    throw new Error("Database demonstrations or measurement checks failed");
  passed = true;
  verification.status = "passed";
  verification.finished_at_utc = new Date().toISOString();
  const files = [
    "scripts/measure-database.mjs",
    "scripts/performance/run.mjs",
    "database/demonstrations/postgres.sql",
    "database/demonstrations/sandbox-ddl.sql",
    "database/demonstrations/mongodb.mjs",
    "lib/intake.mjs",
    "lib/reports.mjs",
    "lib/drafts.mjs",
    "compose.yaml",
    "pnpm-lock.yaml",
  ];
  writeFileSync(
    "output/performance/source-checksums.json",
    JSON.stringify(
      Object.fromEntries(
        files.map((f) => [
          f,
          createHash("sha256").update(readFileSync(f)).digest("hex"),
        ]),
      ),
      null,
      2,
    ) + "\n",
  );
} catch (e) {
  failure = e;
  verification.status = "failed";
} finally {
  if (keep && passed) {
    verification.kept_for_inspection = true;
    console.log("Kept measurement project for inspection: " + project);
  } else {
    try {
      await command([...compose, "down", "--timeout", "5"]);
      verification.cleanup_completed = true;
      console.log("Disposable measurement services removed.");
    } catch (e) {
      failure ??= e;
      verification.cleanup_error = true;
    }
  }
  report();
}
if (failure) throw failure;
console.log("Evidence saved to output/performance.");
