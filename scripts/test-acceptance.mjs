// All outage/fault tests run on a uniquely named disposable Compose project.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import path from "node:path";
process.loadEnvFile(".env");
const root = process.cwd(),
  run = promisify(execFile),
  project = "fieldmerge-acceptance-" + randomUUID().replaceAll("-", "");
const docker =
  process.env.DOCKER_EXE ??
  path.join(
    process.env.USERPROFILE,
    "AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe",
  );
mkdirSync("tmp", { recursive: true });
mkdirSync("output/acceptance", { recursive: true });
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
const args = [
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
async function compose(tail) {
  return (
    await run(docker, [...args, ...tail], {
      timeout: 240000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
}
function port(output) {
  const match = output.match(/^127\.0\.0\.1:(\d+)$/);
  if (!match) throw new Error("Expected a loopback-only test port");
  return match[1];
}
const report = "output/acceptance/verification.json";
writeFileSync(
  report,
  JSON.stringify(
    {
      started_at_utc: new Date().toISOString(),
      status: "running",
      disposable_project: project,
    },
    null,
    2,
  ) + "\n",
);
let failure,
  testsPassed = false,
  cleanupCompleted = false;
try {
  console.log(
    "Starting disposable acceptance database services (development services are untouched).",
  );
  await compose([
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "180",
    "postgres-test",
    "mongo-test",
  ]);
  const env = {
    ...process.env,
    POSTGRES_PORT: port(await compose(["port", "postgres-test", "5432"])),
    MONGO_PORT: port(await compose(["port", "mongo-test", "27017"])),
    FM_TEST_COMPOSE_PROJECT: project,
    FM_TEST_COMPOSE_OVERRIDE: override,
    FM_TEST_PG_SERVICE: "postgres-test",
    FM_TEST_MONGO_SERVICE: "mongo-test",
  };
  const child = spawn(
    process.execPath,
    ["scripts/test-api.mjs", "--acceptance"],
    { cwd: root, env, stdio: "inherit", windowsHide: true },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error("Acceptance checks failed");
  testsPassed = true;
  const files = [
    "docs/FieldMerge_Requirements.md",
    "tests/acceptance/scenarios.test.mjs",
    "scripts/test-acceptance.mjs",
    "scripts/test-api.mjs",
    "lib/intake.mjs",
    "lib/database.mjs",
    "lib/envelope.mjs",
    "lib/http.mjs",
    ...readdirSync("database/postgres/migrations")
      .sort()
      .map((x) => "database/postgres/migrations/" + x),
  ];
  writeFileSync(
    "output/acceptance/source-checksums.json",
    JSON.stringify(
      Object.fromEntries(
        files.map((file) => [
          file,
          createHash("sha256").update(readFileSync(file)).digest("hex"),
        ]),
      ),
      null,
      2,
    ) + "\n",
  );
} catch (e) {
  failure = e;
} finally {
  // No -v: only this exact unique project's temporary containers/network are removed.
  try {
    await compose(["down", "--timeout", "5"]);
    cleanupCompleted = true;
    console.log("Disposable acceptance services removed.");
  } catch (e) {
    failure ??= e;
    console.error(
      "Temporary service cleanup failed; inspect the recorded test project.",
    );
  }
  if (existsSync(report)) {
    const data = JSON.parse(readFileSync(report, "utf8"));
    data.status = testsPassed ? "passed" : "failed";
    data.disposable_project = project;
    data.development_services_interrupted = false;
    data.cleanup_completed = cleanupCompleted;
    writeFileSync(report, JSON.stringify(data, null, 2) + "\n");
  }
}
if (failure) throw failure;
