import { spawnSync } from "node:child_process";

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const args = ["playwright", "install"];

if (process.platform === "linux") {
  args.push("--with-deps");
}

args.push("chromium");

const result = spawnSync(command, args, {
  stdio: "inherit",
  shell: false
});

if (typeof result.status === "number" && result.status !== 0) {
  process.exit(result.status);
}

if (result.error) {
  throw result.error;
}
