import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const daemon = spawn("node", ["daemon/index.js"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

const web = spawn("npm", ["run", "dev", "--prefix", "web"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
  shell: true,
});

function shut() {
  daemon.kill("SIGTERM");
  web.kill("SIGTERM");
  process.exit(0);
}
process.on("SIGINT", shut);
process.on("SIGTERM", shut);

daemon.on("exit", (code) => {
  if (code) process.exit(code);
});
