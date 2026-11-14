import { spawn } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Spawn a process and collect its output.
 * Rejects on non-zero exit, spawn error, or timeout (process is killed).
 */
export function run(
  cmd,
  args,
  { cwd, input, timeoutMs = DEFAULT_TIMEOUT_MS, env, maxOutput = 4 * 1024 * 1024 } = {},
) {
  return new Promise((resolve, reject) => {
    if (process.env.VIDEOGEN_DEBUG) {
      process.stderr.write(`[videogen] ${cmd} ${args.map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
    }
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: input != null ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(val);
    };

    const append = (cur, chunk) => {
      if (cur.length >= maxOutput) return cur;
      return cur + chunk.toString();
    };

    child.stdout.on("data", (d) => {
      stdout = append(stdout, d);
    });
    child.stderr.on("data", (d) => {
      stderr = append(stderr, d);
    });
    if (input != null) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const err = new Error(`${cmd} timed out after ${timeoutMs}ms`);
        err.code = "ETIMEDOUT";
        err.stderr = stderr;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish(reject, err);
      }, timeoutMs);
    }

    child.on("error", (err) => {
      if (err?.code === "ENOENT") {
        err.message = `${cmd}: command not found`;
      }
      finish(reject, err);
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(resolve, { stdout, stderr });
        return;
      }
      const tail = (stderr || stdout).trim().split("\n").slice(-12).join("\n");
      const err = new Error(
        `${path.basename(cmd)} ${args.slice(0, 6).join(" ")}${args.length > 6 ? " …" : ""} failed (${
          code ?? signal
        }): ${tail}`,
      );
      err.code = code;
      err.signal = signal;
      err.stderr = stderr;
      err.stdout = stdout;
      finish(reject, err);
    });
  });
}

const EXTRA_DIRS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/local/bin",
  "/snap/bin",
  "/usr/bin",
  "/bin",
  process.env.HOME ? path.join(process.env.HOME, ".local", "bin") : null,
  process.env.HOME ? path.join(process.env.HOME, "bin") : null,
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "ffmpeg", "bin") : null,
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "eSpeak NG") : null,
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links")
    : null,
].filter(Boolean);

const IS_WIN = process.platform === "win32";
const WIN_EXTS = IS_WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];

async function isExecutableFile(p) {
  try {
    const st = await stat(p);
    if (!st.isFile()) return false;
    if (IS_WIN) return true;
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const whichCache = new Map();

/**
 * Resolve an executable to an absolute path without spawning a shell.
 * Honors absolute paths, PATH, and a set of well-known install dirs.
 * Returns null when not found.
 */
export async function whichPath(bin, { extraDirs = [] } = {}) {
  if (!bin) return null;
  const key = `${bin}|${extraDirs.join(":")}`;
  if (whichCache.has(key)) return whichCache.get(key);

  let found = null;
  if (path.isAbsolute(bin) || bin.includes(path.sep)) {
    found = (await isExecutableFile(bin)) ? path.resolve(bin) : null;
  } else {
    const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    const dirs = [...extraDirs, ...pathDirs, ...EXTRA_DIRS];
    const seen = new Set();
    outer: for (const dir of dirs) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      for (const ext of WIN_EXTS) {
        const candidate = path.join(dir, bin + (bin.toLowerCase().endsWith(ext.toLowerCase()) ? "" : ext));
        if (await isExecutableFile(candidate)) {
          found = candidate;
          break outer;
        }
      }
    }
  }
  whichCache.set(key, found);
  return found;
}

/** Boolean convenience wrapper kept for backwards compatibility. */
export async function which(bin) {
  return (await whichPath(bin)) !== null;
}

export function clearWhichCache() {
  whichCache.clear();
}
