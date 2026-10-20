import { spawn } from "node:child_process";

export function run(cmd, args, { cwd, input, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: input != null ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    if (input != null) {
      child.stdin.end(input);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const err = new Error(
        `${cmd} ${args.join(" ")} failed (${code}): ${stderr || stdout}`,
      );
      err.code = code;
      err.stderr = stderr;
      if (!quiet) reject(err);
      else reject(err);
    });
  });
}

export async function which(bin) {
  try {
    await run("sh", ["-c", `command -v ${bin}`], { quiet: true });
    return true;
  } catch {
    return false;
  }
}
