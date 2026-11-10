// Claude Code agents, run through the Claude Agent SDK.
//
// A Claude Code floor is a folder on this machine. Its agents are Claude Code sessions in that
// folder: the ones hired in the office (run here by the SDK, with tool approvals and questions
// surfaced in the office) plus recent sessions you ran elsewhere (the CLI, the desktop app, an IDE),
// read from their transcripts under ~/.claude/projects. Messaging one of those resumes it here.
//
// The SDK is an optional dependency and is only loaded once a Claude Code floor exists, so offices
// that only use T3 Code never touch it.

import { randomUUID, createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Store } from "./store.ts";
import type { Activity, ActivityItem, AgentInfo, PendingRequest, ProjectInfo, ThreadDetail } from "../shared/types.ts";

type Json = any;
type Sdk = typeof import("@anthropic-ai/claude-agent-sdk");

export const CLAUDE_PROVIDER = "claude-code";
/** Model aliases offered when hiring onto a Claude Code floor. */
export const CLAUDE_MODELS = ["opus", "sonnet", "haiku"];

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const RECENT_MS = Number(process.env.AGENT_OFFICE_CLAUDE_RECENT_HOURS ?? 24) * 3600_000;
const MAX_DISCOVERED = 12;
/** A transcript written this recently belongs to a session that's running somewhere else. */
const ACTIVE_ELSEWHERE_MS = 20_000;
/** Close an idle SDK session (and its process) this long after its last turn. */
const IDLE_CLOSE_MS = 3 * 60_000;
const LIST_CACHE_MS = 4000;

export interface ClaudeProject {
  id: string;
  path: string;
  title: string;
}

export interface ClaudeAgentMeta {
  projectId: string;
  title?: string;
  model?: string;
  /** Hired in the office (vs. found in the transcripts). */
  hired?: boolean;
  completedAt?: string;
  failed?: boolean;
  error?: string | null;
  visitedAt?: string;
  /** Laid off: hidden from the office. The transcript stays in Claude Code. */
  hidden?: boolean;
  createdAt?: string;
}

export interface ClaudeData {
  projects: ClaudeProject[];
  agents: Record<string, ClaudeAgentMeta>;
}

interface Pending {
  request: PendingRequest;
  toolName: string;
  input: Record<string, unknown>;
  suggestions: Json[] | undefined;
  /** Question id -> question text (AskUserQuestion answers are keyed by the text). */
  questionText: Map<string, string>;
  resolve: (result: Json) => void;
}

interface Live {
  id: string;
  projectId: string;
  cwd: string;
  query: Json;
  input: InputQueue;
  /** Turns sent but not finished yet. */
  turns: number;
  pending: Map<string, Pending>;
  model: string | null;
  lastText: string | null;
  updatedAt: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** The office's special agents: board PMs, floor managers and the intern. */
export interface Roles {
  pm: Set<string>;
  managers: Set<string>;
  intern: string | null;
}

interface Listed {
  id: string;
  projectId: string;
  title: string;
  lastModified: number;
  createdAt: number;
}

/** An async iterable of user messages that stays open so follow-ups join a running session. */
class InputQueue implements AsyncIterable<Json> {
  private items: Json[] = [];
  private waiters: ((r: IteratorResult<Json>) => void)[] = [];
  closed = false;

  push(text: string) {
    const msg = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }

  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<Json> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

export function claudeProjectId(path: string) {
  const norm = process.platform === "win32" ? path.toLowerCase() : path;
  return "claude-" + createHash("sha1").update(norm).digest("hex").slice(0, 12);
}

/** Claude Code's folder name for a project: every non-alphanumeric character becomes "-". */
function transcriptDirName(cwd: string) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function samePath(a: string, b: string) {
  const n = (p: string) => resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

/** Reads the last `bytes` of a file as text (whole lines only). */
function readTail(file: string, bytes: number): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  let text = buf.toString("utf8");
  if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  return text;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: Json) => b?.type === "text")
    .map((b: Json) => b.text)
    .join("\n");
}

const clip = (s: unknown, n = 4000) => String(s ?? "").slice(0, n);

/** One transcript line -> the office's activity items (the monitor and the agent panel). */
function itemsFromEntry(e: Json): ActivityItem[] {
  if (e.isSidechain || e.isMeta) return [];
  const at = e.timestamp ?? null;
  const base = (id: string) => ({ id, title: null, status: null, at });
  const content = e.message?.content;
  if (e.type === "user") {
    if (Array.isArray(content) && content.some((b: Json) => b?.type === "tool_result")) {
      const err = content.find((b: Json) => b?.type === "tool_result" && b.is_error);
      return err ? [{ ...base(`${e.uuid}-err`), type: "error", text: clip(textOf(err.content) || err.content, 600) }] : [];
    }
    const text = textOf(content);
    if (!text.trim() || text.startsWith("<command-") || text.startsWith("<local-command")) return [];
    return [{ ...base(e.uuid), type: "user", text: clip(text) }];
  }
  if (e.type !== "assistant" || !Array.isArray(content)) return [];
  const out: ActivityItem[] = [];
  content.forEach((b: Json, i: number) => {
    const id = `${e.uuid}-${i}`;
    if (b.type === "text" && b.text?.trim()) out.push({ ...base(id), type: "assistant", text: clip(b.text, 8000) });
    else if (b.type === "thinking" && b.thinking?.trim()) out.push({ ...base(id), type: "thinking", text: clip(b.thinking, 1200) });
    else if (b.type === "tool_use") out.push({ ...base(id), ...toolItem(b.name, b.input ?? {}) });
  });
  return out;
}

function toolItem(name: string, input: Json): { type: string; text: string; title: string | null } {
  switch (name) {
    case "Bash":
      return { type: "command", text: clip(input.command, 600), title: input.description ?? null };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { type: "file", text: String(input.file_path ?? input.notebook_path ?? name), title: name };
    case "Read":
      return { type: "search", text: `read ${input.file_path ?? ""}`, title: name };
    case "Grep":
    case "Glob":
      return { type: "search", text: clip(input.pattern ?? name), title: name };
    case "WebSearch":
    case "WebFetch":
      return { type: "web", text: clip(input.query ?? input.url ?? name), title: name };
    case "TodoWrite":
      return {
        type: "todo",
        text: (input.todos ?? []).map((t: Json) => `${t.status === "completed" ? "☑" : t.status === "in_progress" ? "▶" : "☐"} ${t.content ?? ""}`).join("\n"),
        title: null,
      };
    case "ExitPlanMode":
      return { type: "plan", text: clip(input.plan, 4000), title: null };
    case "AskUserQuestion":
      return { type: "question", text: (input.questions ?? []).map((q: Json) => q.question).join("\n"), title: null };
    default:
      return { type: "notice", text: name.startsWith("mcp__") ? name.split("__").slice(1).join(" · ") : name, title: null };
  }
}

function describeTool(name: string, input: Json): string {
  if (name === "Bash") return String(input.command ?? "");
  if (input.file_path) return `${name} ${input.file_path}`;
  if (input.url) return `${name} ${input.url}`;
  const json = JSON.stringify(input);
  return `${name} ${json.length > 600 ? json.slice(0, 600) + "…" : json}`;
}

export class ClaudeBackend {
  private sdk: Sdk | null = null;
  private sdkError: string | null = null;
  private live = new Map<string, Live>();
  private listed = new Map<string, Listed>();
  private listCache = new Map<string, { at: number; list: Listed[] }>();
  private transcriptPaths = new Map<string, string>();
  private lastTextCache = new Map<string, { key: string; text: string | null; model: string | null }>();
  private detailCache = new Map<string, { key: string; items: ActivityItem[] }>();

  private store: Store;
  private onChange: () => void;

  constructor(store: Store, onChange: () => void) {
    this.store = store;
    this.onChange = onChange;
  }

  private get data(): ClaudeData {
    const d = this.store.data as unknown as { claude?: ClaudeData };
    d.claude ??= { projects: [], agents: {} };
    d.claude.projects ??= [];
    d.claude.agents ??= {};
    return d.claude;
  }

  /** Whether the SDK loaded (null until a Claude Code floor exists). */
  get status() {
    return { ok: !this.sdkError, error: this.sdkError };
  }

  private async loadSdk(): Promise<Sdk> {
    if (this.sdk) return this.sdk;
    try {
      this.sdk = await import("@anthropic-ai/claude-agent-sdk");
      this.sdkError = null;
      return this.sdk;
    } catch (error) {
      this.sdkError = `Claude Agent SDK not installed (npm install @anthropic-ai/claude-agent-sdk): ${(error as Error).message}`;
      throw new Error(this.sdkError);
    }
  }

  // ---------------------------------------------------------------- projects

  projects(): ProjectInfo[] {
    return this.data.projects.map((p) => ({ id: p.id, title: p.title, workspaceRoot: p.path, backend: "claude" as const }));
  }

  ownsProject(projectId: string) {
    return this.data.projects.some((p) => p.id === projectId);
  }

  owns(threadId: string) {
    return this.live.has(threadId) || this.listed.has(threadId) || Boolean(this.data.agents[threadId]);
  }

  async addProject(path: string): Promise<ProjectInfo> {
    const full = resolve(path.trim().replace(/^~(?=$|[\\/])/, homedir()));
    if (!existsSync(full) || !statSync(full).isDirectory()) throw new Error(`No such folder: ${full}`);
    await this.loadSdk();
    let p = this.data.projects.find((x) => samePath(x.path, full));
    if (!p) {
      p = { id: claudeProjectId(full), path: full, title: basename(full) || full };
      this.data.projects.push(p);
      this.store.save();
    }
    return { id: p.id, title: p.title, workspaceRoot: p.path, backend: "claude" };
  }

  private project(projectId: string): ClaudeProject {
    const p = this.data.projects.find((x) => x.id === projectId);
    if (!p) throw new Error("Unknown Claude Code floor");
    return p;
  }

  // ---------------------------------------------------------------- agents

  private async listProject(p: ClaudeProject): Promise<Listed[]> {
    const cached = this.listCache.get(p.id);
    if (cached && Date.now() - cached.at < LIST_CACHE_MS) return cached.list;
    const sdk = await this.loadSdk();
    const sessions = await sdk.listSessions({ dir: p.path, limit: 60 });
    const agents = this.data.agents;
    const now = Date.now();
    const list: Listed[] = [];
    let discovered = 0;
    for (const s of [...sessions].sort((a, b) => b.lastModified - a.lastModified)) {
      const meta = agents[s.sessionId];
      if (meta?.hidden) continue;
      if (s.cwd && !samePath(s.cwd, p.path)) continue; // a worktree of this folder: not this floor
      const recent = now - s.lastModified < RECENT_MS;
      if (!meta?.hired && !this.live.has(s.sessionId)) {
        if (!recent || discovered >= MAX_DISCOVERED) continue;
        discovered++;
      }
      list.push({
        id: s.sessionId,
        projectId: p.id,
        title: meta?.title || s.customTitle || s.summary || s.firstPrompt || "Claude Code session",
        lastModified: s.lastModified,
        createdAt: s.createdAt ?? s.lastModified,
      });
    }
    this.listCache.set(p.id, { at: now, list });
    return list;
  }

  /** Whether a session is in the office now (running here, or listed on its floor, and not laid off). */
  present(id: string) {
    return (this.live.has(id) || this.listed.has(id)) && !this.data.agents[id]?.hidden;
  }

  async agents(roles: Roles): Promise<AgentInfo[]> {
    if (!this.data.projects.length) return [];
    const out: AgentInfo[] = [];
    const seen = new Set<string>();
    this.listed.clear();
    for (const p of this.data.projects) {
      const list = await this.listProject(p);
      for (const l of list) {
        this.listed.set(l.id, l);
        seen.add(l.id);
        out.push(this.agentInfo(l.id, p, l, roles));
      }
    }
    // Just hired: running, but its transcript isn't on disk yet.
    for (const [id, live] of this.live) {
      if (seen.has(id) || this.data.agents[id]?.hidden) continue;
      const p = this.data.projects.find((x) => x.id === live.projectId);
      if (p) out.push(this.agentInfo(id, p, null, roles));
    }
    return out;
  }

  private agentInfo(id: string, p: ClaudeProject, l: Listed | null, roles: Roles): AgentInfo {
    const meta = this.data.agents[id];
    const live = this.live.get(id);
    const tail = this.tailInfo(id, p);
    const updated = live?.updatedAt ?? (l ? new Date(l.lastModified).toISOString() : new Date().toISOString());
    const pending = live ? [...live.pending.values()][0] : undefined;
    return {
      id,
      projectId: p.id,
      title: meta?.title || l?.title || "Claude Code",
      status: live && live.turns > 0 ? "running" : meta?.failed ? "failed" : meta?.completedAt ? "completed" : "idle",
      activity: this.activity(id, l),
      pendingKind: pending ? pending.request.kind : null,
      lastMessage: (live?.lastText ?? tail.text)?.slice(0, 600) ?? null,
      lastMessageRole: "assistant",
      model: live?.model ?? tail.model ?? meta?.model ?? null,
      provider: CLAUDE_PROVIDER,
      createdAt: meta?.createdAt ?? (l ? new Date(l.createdAt).toISOString() : updated),
      updatedAt: updated,
      link: null,
      lastError: meta?.failed ? (meta.error ?? "Failed") : null,
      desk: null,
      isPm: roles.pm.has(id),
      isManager: roles.managers.has(id),
      isIntern: id === roles.intern,
      backend: "claude",
    };
  }

  private activity(id: string, l: Listed | null): Activity {
    const live = this.live.get(id);
    if (live?.pending.size) return "needs-input";
    if (live && live.turns > 0) return "working";
    const meta = this.data.agents[id];
    if (!live && l && this.runningElsewhere(l)) return "working";
    if (meta?.completedAt) {
      const unseen = !meta.visitedAt || Date.parse(meta.visitedAt) < Date.parse(meta.completedAt);
      if (unseen) return meta.failed ? "error" : "done";
    }
    return "idle";
  }

  /** Its transcript is still being written, and not by the office's last run of it. */
  private runningElsewhere(l: Listed) {
    if (Date.now() - l.lastModified > ACTIVE_ELSEWHERE_MS) return false;
    const done = this.data.agents[l.id]?.completedAt;
    return !done || l.lastModified > Date.parse(done) + 3000;
  }

  // ---------------------------------------------------------------- transcripts

  private transcript(id: string, p: ClaudeProject): string | null {
    const known = this.transcriptPaths.get(id);
    if (known && existsSync(known)) return known;
    const root = join(CONFIG_DIR, "projects");
    const direct = join(root, transcriptDirName(p.path), `${id}.jsonl`);
    let found: string | null = existsSync(direct) ? direct : null;
    if (!found) {
      try {
        for (const dir of readdirSync(root)) {
          const f = join(root, dir, `${id}.jsonl`);
          if (existsSync(f)) {
            found = f;
            break;
          }
        }
      } catch {
        /* no transcripts yet */
      }
    }
    if (found) this.transcriptPaths.set(id, found);
    return found;
  }

  private entries(file: string, bytes: number): Json[] {
    const out: Json[] = [];
    for (const line of readTail(file, bytes).split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* partial line */
      }
    }
    return out;
  }

  /** Last assistant text and model, from the end of the transcript. */
  private tailInfo(id: string, p: ClaudeProject): { text: string | null; model: string | null } {
    const file = this.transcript(id, p);
    if (!file) return { text: null, model: null };
    const st = statSync(file);
    const key = `${st.size}|${st.mtimeMs}`;
    const hit = this.lastTextCache.get(id);
    if (hit?.key === key) return hit;
    let text: string | null = null;
    let model: string | null = null;
    const list = this.entries(file, 96 * 1024);
    for (let i = list.length - 1; i >= 0 && (text === null || model === null); i--) {
      const e = list[i];
      if (e.type !== "assistant" || e.isSidechain) continue;
      model ??= e.message?.model && e.message.model !== "<synthetic>" ? e.message.model : null;
      const t = textOf(e.message?.content);
      if (text === null && t.trim()) text = t;
    }
    const info = { key, text, model };
    this.lastTextCache.set(id, info);
    return info;
  }

  async detail(id: string): Promise<ThreadDetail> {
    const meta = this.data.agents[id];
    const projectId = this.live.get(id)?.projectId ?? this.listed.get(id)?.projectId ?? meta?.projectId;
    const p = projectId ? this.data.projects.find((x) => x.id === projectId) : undefined;
    let items: ActivityItem[] = [];
    const file = p ? this.transcript(id, p) : null;
    if (file) {
      const st = statSync(file);
      const key = `${st.size}|${st.mtimeMs}`;
      const hit = this.detailCache.get(id);
      if (hit?.key === key) items = hit.items;
      else {
        // Screenshots make some lines huge, so read generously.
        items = this.entries(file, 4 * 1024 * 1024).flatMap(itemsFromEntry).slice(-80);
        this.detailCache.set(id, { key, items });
      }
    }
    const pending = this.live.get(id)?.pending.values().next().value as Pending | undefined;
    return { id, items, pending: pending?.request ?? null };
  }

  // ---------------------------------------------------------------- running sessions

  private async run(id: string, p: ClaudeProject, opts: { resume: boolean; model?: string; allowedTools?: string[] }): Promise<Live> {
    const sdk = await this.loadSdk();
    const input = new InputQueue();
    const live: Live = {
      id,
      projectId: p.id,
      cwd: p.path,
      query: null,
      input,
      turns: 0,
      pending: new Map(),
      model: opts.model ?? null,
      lastText: null,
      updatedAt: new Date().toISOString(),
      idleTimer: null,
    };
    const options: Json = {
      cwd: p.path,
      // Same behaviour as running `claude` in that folder: the user's settings, CLAUDE.md, permission rules.
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: process.env.AGENT_OFFICE_CLAUDE_PERMISSION_MODE ?? "default",
      canUseTool: (toolName: string, toolInput: Record<string, unknown>, o: Json) => this.askUser(live, toolName, toolInput, o),
    };
    if (opts.resume) options.resume = id;
    else options.sessionId = id;
    if (opts.model) options.model = opts.model;
    if (opts.allowedTools) options.allowedTools = opts.allowedTools;
    if (process.env.CLAUDE_CODE_PATH) options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
    live.query = sdk.query({ prompt: input, options });
    this.live.set(id, live);
    void this.consume(live);
    return live;
  }

  private async consume(live: Live) {
    const meta = () => (this.data.agents[live.id] ??= { projectId: live.projectId });
    try {
      for await (const m of live.query as AsyncIterable<Json>) {
        live.updatedAt = new Date().toISOString();
        if (m.type === "system" && m.subtype === "init") {
          live.model = m.model ?? live.model;
        } else if (m.type === "assistant" && !m.parent_tool_use_id) {
          const t = textOf(m.message?.content);
          if (t.trim()) live.lastText = t;
          if (m.message?.model && m.message.model !== "<synthetic>") live.model = m.message.model;
        } else if (m.type === "result") {
          live.turns = Math.max(0, live.turns - 1);
          const md = meta();
          md.completedAt = new Date().toISOString();
          md.failed = m.subtype !== "success" || Boolean(m.is_error);
          md.error = md.failed ? (m.errors?.join("; ") || m.result || m.subtype) : null;
          if (live.model) md.model = live.model;
          this.store.save();
          if (live.turns === 0) this.scheduleClose(live);
        }
        this.listCache.delete(live.projectId);
        this.onChange();
      }
    } catch (error) {
      const md = meta();
      md.completedAt = new Date().toISOString();
      md.failed = true;
      md.error = (error as Error).message;
      this.store.save();
    } finally {
      if (live.idleTimer) clearTimeout(live.idleTimer);
      for (const p of live.pending.values()) p.resolve({ behavior: "deny", message: "The session ended." });
      if (this.live.get(live.id) === live) this.live.delete(live.id);
      this.listCache.delete(live.projectId);
      this.onChange();
    }
  }

  private scheduleClose(live: Live) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => {
      if (live.turns === 0 && !live.pending.size) live.input.close();
    }, IDLE_CLOSE_MS);
  }

  /** A tool approval or a question: park it until someone answers in the office. */
  private askUser(live: Live, toolName: string, input: Record<string, unknown>, o: Json): Promise<Json> {
    return new Promise((resolveResult) => {
      const requestId = String(o?.toolUseID ?? randomUUID());
      const questionText = new Map<string, string>();
      let request: PendingRequest;
      if (toolName === "AskUserQuestion") {
        const qs: Json[] = Array.isArray(input.questions) ? (input.questions as Json[]) : [];
        request = {
          requestId,
          kind: "question",
          prompt: null,
          reason: null,
          questions: qs.map((q, i) => {
            const qid = `q${i}`;
            questionText.set(qid, String(q.question ?? ""));
            return {
              id: qid,
              header: String(q.header ?? ""),
              question: String(q.question ?? ""),
              multiSelect: Boolean(q.multiSelect),
              options: (q.options ?? []).map((opt: Json) => ({ label: String(opt.label ?? ""), description: String(opt.description ?? "") })),
            };
          }),
          options: [],
        };
      } else {
        const always = Array.isArray(o?.suggestions) && o.suggestions.length > 0 && !o?.suppressAlwaysAllowRule;
        request = {
          requestId,
          kind: o?.displayName ?? toolName,
          prompt: o?.title ? `${o.title}\n\n${describeTool(toolName, input)}` : describeTool(toolName, input),
          reason: o?.description ?? o?.decisionReason ?? null,
          questions: [],
          options: [
            { decision: "accept", label: "Allow" },
            ...(always ? [{ decision: "acceptForSession", label: "Allow for this session" }] : []),
            { decision: "decline", label: "Deny" },
          ],
        };
      }
      const done = (result: Json) => {
        if (!live.pending.delete(requestId)) return;
        live.updatedAt = new Date().toISOString();
        resolveResult(result);
        this.onChange();
      };
      live.pending.set(requestId, { request, toolName, input, suggestions: o?.suggestions, questionText, resolve: done });
      o?.signal?.addEventListener?.("abort", () => done({ behavior: "deny", message: "Cancelled." }));
      this.onChange();
    });
  }

  // ---------------------------------------------------------------- actions

  /** `officeApi`: the agent drives the office over its HTTP API with curl (board PM, floor manager, intern). */
  async start(opts: { projectId: string; message: string; title?: string; model?: string; officeApi?: boolean }): Promise<string> {
    const p = this.project(opts.projectId);
    const id = randomUUID();
    const title = opts.title?.trim() || opts.message.trim().split("\n")[0].slice(0, 80);
    this.data.agents[id] = { projectId: p.id, title, model: opts.model, hired: true, createdAt: new Date().toISOString() };
    this.store.save();
    const live = await this.run(id, p, { resume: false, model: opts.model, allowedTools: opts.officeApi ? ["Bash(curl:*)"] : undefined });
    live.turns++;
    live.input.push(opts.message);
    this.onChange();
    return id;
  }

  async send(id: string, text: string) {
    let live = this.live.get(id);
    if (live?.pending.size) {
      // Replying in chat answers whatever they were waiting on.
      for (const p of [...live.pending.values()]) p.resolve({ behavior: "deny", message: `The user replied in chat instead: ${text}` });
      return;
    }
    if (live?.input.closed) live = undefined; // winding down after being idle: resume afresh
    if (!live) {
      const l = this.listed.get(id);
      if (l && this.runningElsewhere(l) && !this.data.agents[id]?.hired) {
        throw new Error("This session is running in another Claude Code window right now. Message it there, or try again when it's done.");
      }
      const projectId = l?.projectId ?? this.data.agents[id]?.projectId;
      if (!projectId) throw new Error("Unknown Claude Code session");
      live = await this.run(id, this.project(projectId), { resume: true });
    }
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.turns++;
    live.input.push(text);
    this.onChange();
  }

  async stop(id: string) {
    const live = this.live.get(id);
    if (!live) return;
    for (const p of [...live.pending.values()]) p.resolve({ behavior: "deny", message: "Stopped from Agent Office.", interrupt: true });
    try {
      await live.query.interrupt();
    } catch {
      /* already idle */
    }
    live.turns = 0;
    this.scheduleClose(live);
    this.onChange();
  }

  async archive(id: string) {
    const live = this.live.get(id);
    if (live) {
      await this.stop(id);
      live.input.close();
      try {
        live.query.close?.();
      } catch {
        /* closed */
      }
    }
    const meta = (this.data.agents[id] ??= { projectId: this.listed.get(id)?.projectId ?? live?.projectId ?? "" });
    meta.hidden = true;
    this.store.save();
    this.listCache.clear();
  }

  visit(id: string) {
    const meta = (this.data.agents[id] ??= { projectId: this.listed.get(id)?.projectId ?? "" });
    meta.visitedAt = new Date().toISOString();
    this.store.save();
  }

  respond(id: string, requestId: string, body: { decision?: string; answers?: Record<string, string | string[]> }) {
    const live = this.live.get(id);
    const p = live?.pending.get(requestId);
    if (!p) throw new Error("That request was already answered or has expired");
    if (p.request.questions.length) {
      const answers: Record<string, string> = {};
      for (const [qid, value] of Object.entries(body.answers ?? {})) {
        const q = p.questionText.get(qid) ?? qid;
        answers[q] = Array.isArray(value) ? value.join(", ") : String(value);
      }
      p.resolve({ behavior: "allow", updatedInput: { ...p.input, answers } });
      return;
    }
    if (body.decision === "accept") p.resolve({ behavior: "allow", updatedInput: p.input });
    else if (body.decision === "acceptForSession") p.resolve({ behavior: "allow", updatedInput: p.input, updatedPermissions: p.suggestions ?? [] });
    else p.resolve({ behavior: "deny", message: "The user declined this in Agent Office." });
  }

  close() {
    for (const live of this.live.values()) {
      live.input.close();
      try {
        live.query?.close?.();
      } catch {
        /* closed */
      }
    }
  }
}
