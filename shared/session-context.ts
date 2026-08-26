/**
 * Derive what a Claude Code session is working on from its own transcript.
 *
 * Session resolution (best-effort, returns null when unidentifiable):
 *   1. Parent claude process launched with `--resume <uuid>` → uuid from
 *      /proc/<ppid>/cmdline.
 *   2. Fresh session → the transcript .jsonl whose birth time is within
 *      90s of the claude process start time.
 *
 * The summary is built from the transcript tail: real cwd (more precise
 * than the MCP server's spawn cwd), git branch, and the last user prompt.
 * Linux-only (procfs) — callers treat null as "no context available".
 */

import {
  readdirSync,
  statSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from "node:fs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;
const TAIL_BYTES = 256 * 1024;
const BIRTH_MATCH_WINDOW_MS = 90_000;

export interface SessionContext {
  branch: string | null;
  cwd: string | null;
  lastPrompt: string | null;
}

function parentCmdlineSessionId(ppid: number): string | null {
  try {
    const parts = readFileSync(`/proc/${ppid}/cmdline`, "utf8").split("\0");
    for (let i = 0; i < parts.length - 1; i++) {
      if ((parts[i] === "--resume" || parts[i] === "-r") && UUID_RE.test(parts[i + 1])) {
        return parts[i + 1];
      }
    }
  } catch {
    // process gone or not readable
  }
  return null;
}

function processStartMs(ppid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${ppid}/stat`, "utf8");
    // starttime is field 22; fields 2 (comm) may contain spaces — skip past ")"
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startJiffies = parseInt(afterComm[19], 10);
    const btimeLine = readFileSync("/proc/stat", "utf8")
      .split("\n")
      .find((l) => l.startsWith("btime "));
    if (!btimeLine || !Number.isFinite(startJiffies)) return null;
    const btime = parseInt(btimeLine.slice(6), 10);
    return (btime + startJiffies / 100) * 1000; // CLK_TCK=100 on Linux
  } catch {
    return null;
  }
}

function findTranscript(sessionId: string): string | null {
  try {
    for (const proj of readdirSync(PROJECTS_DIR)) {
      const path = `${PROJECTS_DIR}/${proj}/${sessionId}.jsonl`;
      try {
        statSync(path);
        return path;
      } catch {
        // not in this project dir
      }
    }
  } catch {
    // no projects dir
  }
  return null;
}

function transcriptBornNear(startMs: number): string | null {
  let best: { path: string; delta: number } | null = null;
  try {
    for (const proj of readdirSync(PROJECTS_DIR)) {
      const dir = `${PROJECTS_DIR}/${proj}`;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        try {
          const st = statSync(`${dir}/${name}`);
          if (st.mtimeMs < startMs) continue; // not written since our session began
          const delta = Math.abs(st.birthtimeMs - st.mtimeMs) < 1
            ? Number.POSITIVE_INFINITY // birth time unsupported on this fs
            : Math.abs(st.birthtimeMs - startMs);
          if (delta < BIRTH_MATCH_WINDOW_MS && (!best || delta < best.delta)) {
            best = { path: `${dir}/${name}`, delta };
          }
        } catch {
          // file vanished mid-scan
        }
      }
    }
  } catch {
    return null;
  }
  return best?.path ?? null;
}

function readTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function extractContext(tail: string): SessionContext {
  const ctx: SessionContext = { branch: null, cwd: null, lastPrompt: null };
  const lines = tail.split("\n").filter((l) => l.length > 2);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // first line of the tail is usually truncated
    }
    if (ctx.branch === null && typeof entry.gitBranch === "string") ctx.branch = entry.gitBranch;
    if (ctx.cwd === null && typeof entry.cwd === "string") ctx.cwd = entry.cwd;
    if (ctx.lastPrompt === null && entry.type === "user" && !entry.isSidechain && !entry.isMeta) {
      const content = entry.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? (content.find((b: any) => b?.type === "text")?.text ?? "")
            : "";
      const trimmed = text.trim();
      // skip tool results and injected <system-reminder>/<command-*> wrappers
      if (trimmed && !trimmed.startsWith("<")) {
        ctx.lastPrompt = trimmed.replace(/\s+/g, " ").slice(0, 140);
      }
    }
    if (ctx.branch && ctx.cwd && ctx.lastPrompt) break;
  }
  return ctx;
}

let cachedTranscript: string | null = null;

/** One-line "what is this session doing" summary, or null if unknown. */
export function sessionSummary(ppid: number = process.ppid): string | null {
  if (!cachedTranscript) {
    const sessionId = parentCmdlineSessionId(ppid);
    if (sessionId) cachedTranscript = findTranscript(sessionId);
    if (!cachedTranscript) {
      const startMs = processStartMs(ppid);
      if (startMs) cachedTranscript = transcriptBornNear(startMs);
    }
    if (!cachedTranscript) return null;
  }

  let ctx: SessionContext;
  try {
    ctx = extractContext(readTail(cachedTranscript));
  } catch {
    return null;
  }

  const parts: string[] = [];
  if (ctx.cwd) parts.push(ctx.cwd.split("/").slice(-2).join("/"));
  if (ctx.branch) parts.push(`[${ctx.branch}]`);
  if (ctx.lastPrompt) parts.push(`— "${ctx.lastPrompt}"`);
  return parts.length > 0 ? parts.join(" ") : null;
}
