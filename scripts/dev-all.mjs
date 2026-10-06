// Starts the Next.js dev server and the background worker together (Ctrl+C stops both).
import { spawn, spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";
const procs = [
  ["web", spawn(npm, ["run", "dev"], { stdio: "inherit", shell: isWindows })],
  ["worker", spawn(npm, ["run", "worker"], { stdio: "inherit", shell: isWindows })],
];

/** On Windows the npm shell must be stopped together with its children, or they keep running. */
function stop(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (isWindows) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGINT");
}

let exiting = false;
const stopAll = (code = 0) => {
  if (exiting) return;
  exiting = true;
  for (const [, p] of procs) stop(p);
  setTimeout(() => process.exit(code), 1500);
};
for (const [name, p] of procs) {
  p.on("exit", (code) => {
    if (!exiting) console.log(`[dev:all] ${name} exited with code ${code}; stopping the other process.`);
    stopAll(code ?? 0);
  });
}
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
