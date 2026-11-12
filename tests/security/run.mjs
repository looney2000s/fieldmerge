import { spawn } from "node:child_process";
for (const args of [
  ["--test", "--test-concurrency=1", "tests/security/transport.test.mjs"],
  ["tests/security/browser.mjs"],
]) {
  const child = spawn(process.execPath, args, {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error("Security verification failed");
}
