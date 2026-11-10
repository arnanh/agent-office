// The office bridge: a tiny HTTP API + server-sent-events stream that the 3D client
// (and agents like the issue-board PM) use. Mounted into Vite in dev, or served by
// server/main.ts in production.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { T3Client, T3_HOME } from "./t3.ts";
import { ClaudeBackend, CLAUDE_PROVIDER } from "./claude.ts";
import { Store, type StoredBoard } from "./store.ts";
import { createManager } from "./manager.ts";
import { bloopName } from "../shared/names.ts";
import * as gitlab from "./gitlab.ts";
import { applyBoardPatch, BoardSettingsError, defaultBoardSettings, slugify, WALL_MAX_COLUMNS } from "../shared/board.ts";
import {
  DESK_COUNT,
  MANAGER_DESK,
  PM_DESK,
  type Activity,
  type ActivityItem,
  type AgentInfo,
  type BoardColumn,
  type BoardSettings,
  type BoardState,
  type Issue,
  type OfficeSnapshot,
  type PendingRequest,
  type ProjectInfo,
  type ThreadDetail,
} from "../shared/types.ts";

type Json = any;
type Next = (err?: unknown) => void;

const RUNNING = new Set(["preparing", "queued", "starting", "running"]);
const POLL_MS = 1500;
const GITLAB_SYNC_MS = 30_000;
/**
 * Messages to the intern start with a line saying which floor the boss is on, so "this project"
 * means something. The office strips it again when showing the conversation.
 */
const FLOOR_CONTEXT = /^\[Office: [^\]\n]*\]\n\n/;

export interface BridgeOptions {
  dataFile: string;
  /** Where agents can reach this bridge, e.g. http://127.0.0.1:5199 */
  publicUrl: () => string;
}

export function createBridge(options: BridgeOptions) {
  const t3 = new T3Client();
  const store = new Store(options.dataFile);
  const clients = new Set<ServerResponse>();
  const detailCache = new Map<string, { key: string; detail: ThreadDetail }>();
  const prevActivity = new Map<string, Activity>();
  const deskReservations = new Map<string, number[]>(); // projectId -> desks being hired into

  let snapshot: OfficeSnapshot = {
    connected: false,
    error: null,
    projects: [],
    agents: [],
    issues: store.data.issues,
    pm: store.data.pm,
    managers: store.data.managers,
    staffLog: [],
    boards: {},
    bridgeUrl: options.publicUrl(),
  };
  let lastSent = "";
  let rawThreads = new Map<string, Json>();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** When an intern is being recruited: their new thread stays hidden until we know it's them. */
  let internStarting = 0;
  let polling = false;

  // Each backend keeps its last good state, so one failing doesn't empty the other's floors.
  let t3State = { ok: false, error: null as string | null, projects: [] as ProjectInfo[], agents: [] as AgentInfo[] };
  let claudeState = { ok: true, error: null as string | null, projects: [] as ProjectInfo[], agents: [] as AgentInfo[] };
  let claudeRefresh: ReturnType<typeof setTimeout> | null = null;
  // Claude Code sessions run inside this process and report every step; refresh just their part.
  const claude = new ClaudeBackend(store, () => {
    if (claudeRefresh) return;
    claudeRefresh = setTimeout(async () => {
      claudeRefresh = null;
      await pollClaude();
      compose(false);
    }, 150);
  });
  const isClaudeProject = (projectId: string) => claude.ownsProject(projectId);
  const isClaudeThread = (threadId: string) => claude.owns(threadId);

  function sendTo(threadId: string, text: string) {
    return isClaudeThread(threadId) ? claude.send(threadId, text) : t3.sendMessage(threadId, text);
  }

  /** `officeApi`: the agent drives the office over its HTTP API with curl (PM, manager, intern). */
  function startThread(opts: { projectId: string; message: string; title?: string; model?: string; provider?: string; officeApi?: boolean }) {
    if (isClaudeProject(opts.projectId)) return claude.start(opts).then((threadId) => ({ threadId }));
    return t3.startThread({ projectId: opts.projectId, message: opts.message, title: opts.title, model: opts.model, provider: opts.provider });
  }

  /** Whether a thread is in the office now: a T3 Code thread from the last poll, or a Claude Code session. */
  const inOffice = (id: string) => (isClaudeThread(id) ? claude.present(id) : rawThreads.has(id));

  // The floor managers (server/manager.ts): their API, roster, staff log and finish notices.
  const manager = createManager({
    store,
    startThread,
    sendMessage: sendTo,
    publicUrl: options.publicUrl,
    snapshot: () => snapshot,
    // While T3 Code is unreachable its threads count as present, so nothing is forgotten (main skips that poll).
    present: (id) => inOffice(id) || (!t3State.ok && !isClaudeThread(id)),
    poll: () => void poll(),
    httpError,
  });

  // ---------------------------------------------------------------- polling

  function deriveActivity(t: Json): Activity {
    if (t.pendingRuntimeRequest) return "needs-input";
    const status = String(t.status ?? "idle");
    if (RUNNING.has(status)) return "working";
    if (status === "waiting") return t.blockedOnThreadWait ? "working" : "needs-input";
    const completedAt = t.latestRunCompletedAt ? Date.parse(t.latestRunCompletedAt) : 0;
    const visitedAt = t.lastVisitedAt ? Date.parse(t.lastVisitedAt) : 0;
    const unseen = completedAt > 0 && visitedAt < completedAt && !t.settledAt;
    if (status === "failed") return unseen ? "error" : "idle";
    if (status === "completed" || status === "interrupted" || status === "cancelled") {
      return unseen ? "done" : "idle";
    }
    return "idle";
  }

  /**
   * Laid-off agents are settled (not archived) in T3, so their threads stay in the shell; the
   * office keeps them out until the thread is un-settled (e.g. you pick it back up in T3).
   */
  function isLaidOff(t: Json) {
    const at = store.data.laidOff[t.id];
    if (!at) return false;
    const since = Date.parse(at);
    const unsettled = t.unsettledAt && Date.parse(t.unsettledAt) > since;
    // Grace period so a poll that raced the settle doesn't bring them straight back.
    const stillOpen = !t.settledAt && Date.now() - since > 15_000;
    if (unsettled || stillOpen) {
      delete store.data.laidOff[t.id];
      store.save();
      return false;
    }
    return true;
  }

  /**
   * Lay an agent off: stop it if it's mid-run, settle its thread, and free its desk. A Claude Code
   * session is stopped and hidden from the office instead (its transcript stays in Claude Code).
   */
  async function layOff(threadId: string, opts: { by?: string; reason?: string | null } = {}) {
    const by = opts.by ?? "api";
    manager.checkFire(threadId, by);
    if (isClaudeThread(threadId)) {
      await claude.archive(threadId);
    } else {
      const raw = rawThreads.get(threadId);
      store.data.laidOff[threadId] = new Date().toISOString();
      try {
        if (raw && RUNNING.has(String(raw.status))) await t3.stop(threadId).catch(() => {});
        await t3.settle(threadId);
      } catch (error) {
        delete store.data.laidOff[threadId];
        throw error;
      }
    }
    manager.onFired(threadId, by, opts.reason ?? null);
    delete store.data.desks[threadId];
    for (const [pid, tid] of Object.entries(store.data.pm)) if (tid === threadId) delete store.data.pm[pid];
    if (store.data.intern === threadId) store.data.intern = null;
    store.save();
  }

  function assignDesks(agents: AgentInfo[]) {
    const desks = store.data.desks;
    const present = new Set(agents.map((a) => a.id));
    let changed = false;
    for (const id of Object.keys(desks)) {
      if (!present.has(id)) {
        delete desks[id];
        changed = true;
      }
    }
    const byProject = new Map<string, AgentInfo[]>();
    for (const a of agents) {
      const list = byProject.get(a.projectId) ?? [];
      list.push(a);
      byProject.set(a.projectId, list);
    }
    for (const [projectId, list] of byProject) {
      const taken = new Set<number>();
      const reserved = new Set(deskReservations.get(projectId) ?? []);
      for (const a of list) {
        const seat = desks[a.id];
        if (a.isIntern) {
          // The intern follows the boss around instead of sitting at a desk.
          if (seat) {
            delete desks[a.id];
            changed = true;
          }
          continue;
        }
        if (a.isPm) {
          a.desk = PM_DESK;
          continue;
        }
        if (a.isManager) {
          a.desk = MANAGER_DESK;
          continue;
        }
        if (seat && seat.projectId === projectId && seat.desk >= 0 && seat.desk < DESK_COUNT && !taken.has(seat.desk)) {
          a.desk = seat.desk;
          taken.add(seat.desk);
        }
      }
      const newcomers = list
        .filter((a) => a.desk === null && !a.isPm && !a.isManager && !a.isIntern)
        .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
      for (const a of newcomers) {
        let desk = -1;
        for (let i = 0; i < DESK_COUNT; i++) {
          if (!taken.has(i) && !reserved.has(i)) {
            desk = i;
            break;
          }
        }
        if (desk < 0) continue;
        a.desk = desk;
        taken.add(desk);
        desks[a.id] = { projectId, desk };
        changed = true;
      }
    }
    if (changed) store.save();
  }

  function updateIssuesFromActivity(agents: AgentInfo[]) {
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const issue of store.data.issues) {
      if (!issue.assignee) continue;
      const { flow } = settingsOf(issue.projectId);
      if (issue.status !== flow.onAssign || flow.onAssign === flow.onFinish) continue;
      const agent = byId.get(issue.assignee);
      if (!agent) continue;
      const before = prevActivity.get(agent.id);
      if (before === "working" && (agent.activity === "done" || agent.activity === "idle")) {
        moveIssue(issue, flow.onFinish).catch((error) => console.warn(`[board] couldn't move ${issue.id}: ${(error as Error).message}`));
      }
    }
    for (const a of agents) prevActivity.set(a.id, a.activity);
  }

  async function pollT3() {
    try {
      const shell = await t3.shell();
      const projects: ProjectInfo[] = (shell.projects ?? [])
        .filter((p: Json) => !p.archivedAt && !p.deletedAt)
        .map((p: Json) => ({ id: p.id, title: p.title, workspaceRoot: p.workspaceRoot }));
      const projectIds = new Set(projects.map((p) => p.id));
      const pmIds = new Set(Object.values(store.data.pm));
      const managerIds = new Set(Object.values(store.data.managers));
      rawThreads = new Map();
      const agents: AgentInfo[] = [];
      for (const t of shell.threads ?? []) {
        if (t.archivedAt || t.deletedAt) continue;
        if (isLaidOff(t)) continue;
        if (internStarting && t.title === "Intern" && t.id !== store.data.intern && Date.parse(t.createdAt) >= internStarting - 5000) continue;
        if (!projectIds.has(t.projectId)) continue;
        if (t.lineage?.relationshipToParent === "subagent") continue;
        rawThreads.set(t.id, t);
        agents.push({
          id: t.id,
          projectId: t.projectId,
          title: t.title,
          status: t.status,
          activity: deriveActivity(t),
          pendingKind: t.pendingRuntimeRequest?.kind ?? null,
          lastMessage: t.latestVisibleMessage?.text?.slice(0, 600) ?? null,
          lastMessageRole: t.latestVisibleMessage?.role ?? null,
          model: t.modelSelection?.model ?? null,
          provider: t.providerInstanceId ?? null,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          link: t3.threadLink(t.id),
          lastError: t.lastError ?? null,
          desk: null,
          isPm: pmIds.has(t.id),
          isManager: managerIds.has(t.id),
          isIntern: t.id === store.data.intern,
        });
      }
      // Laid-off threads that were archived since don't need remembering.
      for (const t of shell.archivedThreads ?? []) {
        if (store.data.laidOff[t.id]) {
          delete store.data.laidOff[t.id];
          store.save();
        }
      }
      // Forget PMs whose threads are gone.
      for (const [pid, tid] of Object.entries(store.data.pm)) {
        if (isClaudeProject(pid)) continue;
        if (!rawThreads.has(tid)) {
          delete store.data.pm[pid];
          store.save();
        }
      }
      // Forget the intern if their thread is gone.
      if (store.data.intern && !isClaudeThread(store.data.intern) && !rawThreads.has(store.data.intern)) {
        store.data.intern = null;
        store.save();
      }
      t3State = { ok: true, error: null, projects, agents };
    } catch (error) {
      t3State = { ...t3State, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function pollClaude() {
    try {
      const agents = (
        await claude.agents({
          pm: new Set(Object.values(store.data.pm)),
          managers: new Set(Object.values(store.data.managers)),
          intern: store.data.intern,
        })
      ).filter((a) => !(internStarting && a.title === "Intern" && a.id !== store.data.intern));
      for (const [pid, tid] of Object.entries(store.data.pm)) {
        if (isClaudeProject(pid) && !claude.present(tid)) {
          delete store.data.pm[pid];
          store.save();
        }
      }
      // Forget the intern if they were a Claude Code session that's gone.
      if (store.data.intern && isClaudeThread(store.data.intern) && !claude.present(store.data.intern)) {
        store.data.intern = null;
        store.save();
      }
      claudeState = { ok: true, error: null, projects: claude.projects(), agents };
    } catch (error) {
      claudeState = { ...claudeState, ok: false, error: error instanceof Error ? error.message : String(error), projects: claude.projects() };
    }
  }

  /**
   * Merges both backends into the snapshot the office sees. `full` is false for a Claude-only
   * refresh: T3's part is from the last poll then, so the managers' bookkeeping waits for a full one.
   */
  function compose(full = true) {
    const agents = [...t3State.agents, ...claudeState.agents];
    for (const a of agents) a.desk = null;
    assignDesks(agents);
    updateIssuesFromActivity(agents);
    if (full) manager.onPoll(agents);
    const claudeFloors = claudeState.projects.length;
    snapshot = {
      // With no Claude Code floors this is exactly T3 Code's connection state, as before.
      connected: t3State.ok || claudeFloors > 0,
      error: t3State.ok ? null : t3State.error,
      projects: [...t3State.projects, ...claudeState.projects],
      agents,
      issues: store.data.issues,
      pm: store.data.pm,
      managers: store.data.managers,
      staffLog: snapshot.staffLog,
      boards: snapshot.boards,
      bridgeUrl: options.publicUrl(),
      backends: {
        t3: { ok: t3State.ok, error: t3State.error },
        claude: { ok: claudeState.ok && claude.status.ok, error: claudeState.error ?? claude.status.error, floors: claudeFloors },
      },
    };
    broadcast();
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await Promise.all([pollT3(), pollClaude()]);
    } finally {
      polling = false;
    }
    compose();
  }

  function schedule() {
    pollTimer = setTimeout(async () => {
      await poll();
      schedule();
    }, POLL_MS);
  }

  function broadcast(force = false) {
    snapshot.issues = store.data.issues;
    snapshot.pm = store.data.pm;
    snapshot.managers = store.data.managers;
    snapshot.staffLog = store.data.staffLog.slice(-100);
    snapshot.boards = boardsSnapshot();
    const body = JSON.stringify(snapshot);
    if (!force && body === lastSent) return;
    lastSent = body;
    for (const res of clients) res.write(`event: snapshot\ndata: ${body}\n\n`);
  }

  // ---------------------------------------------------------------- details

  function itemText(item: Json): ActivityItem | null {
    const base = {
      id: String(item.id),
      title: item.title ?? null,
      status: item.status ?? null,
      at: item.startedAt ?? item.updatedAt ?? null,
    };
    const clip = (s: unknown, n = 4000) => String(s ?? "").slice(0, n);
    switch (item.type) {
      case "user_message":
        return { ...base, type: "user", text: clip(String(item.text ?? "").replace(FLOOR_CONTEXT, "")) };
      case "assistant_message":
        return { ...base, type: "assistant", text: clip(item.text, 8000) };
      case "reasoning":
        return { ...base, type: "thinking", text: clip(item.text, 1200) };
      case "command_execution":
        if (item.input === "Preparing workspace") return null;
        return { ...base, type: "command", text: clip(item.input, 600) };
      case "file_change":
        return {
          ...base,
          type: "file",
          text: `${item.fileName}${item.additions != null ? `  +${item.additions}` : ""}${item.deletions != null ? ` -${item.deletions}` : ""}`,
        };
      case "file_search":
        return { ...base, type: "search", text: clip(item.pattern ?? item.title ?? "search") };
      case "web_search":
        return { ...base, type: "web", text: clip((item.patterns ?? []).join(", ") || item.title || "web search") };
      case "todo_list":
        return {
          ...base,
          type: "todo",
          text: (item.steps ?? [])
            .map((s: Json) => `${s.status === "completed" ? "☑" : s.status === "in_progress" ? "▶" : "☐"} ${s.step ?? s.text ?? s.title ?? ""}`)
            .join("\n"),
        };
      case "proposed_plan":
        return { ...base, type: "plan", text: clip(item.markdown, 4000) };
      case "user_input_request":
        return { ...base, type: "question", text: (item.questions ?? []).map((q: Json) => q.question).join("\n") };
      case "approval_request":
        return { ...base, type: "approval", text: clip(item.prompt ?? item.reason ?? item.requestKind) };
      case "error":
        return { ...base, type: "error", text: clip(item.message ?? item.text ?? item.title ?? "Error") };
      case "system_notice":
        return { ...base, type: "notice", text: clip(item.text ?? item.message ?? item.title ?? "") };
      default:
        return null;
    }
  }

  async function getDetail(threadId: string): Promise<ThreadDetail> {
    if (isClaudeThread(threadId)) {
      const d = await claude.detail(threadId);
      return { ...d, items: d.items.map((i) => (i.type === "user" ? { ...i, text: i.text.replace(FLOOR_CONTEXT, "") } : i)) };
    }
    const raw = rawThreads.get(threadId);
    const key = raw ? `${raw.updatedAt}|${raw.itemCount}|${raw.pendingRuntimeRequest?.id ?? ""}` : "";
    const cached = detailCache.get(threadId);
    if (cached && key && cached.key === key) return cached.detail;
    const snap = await t3.threadSnapshot(threadId);
    const projection = snap.projection ?? {};
    const visible: Json[] = projection.visibleTurnItems ?? [];
    const turnItems: Json[] = visible.length
      ? [...visible].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((v) => v.item ?? v)
      : [...(projection.turnItems ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    const items = turnItems.slice(-80).map(itemText).filter((x): x is ActivityItem => x !== null);
    let pending: PendingRequest | null = null;
    const pendingReq = (projection.runtimeRequests ?? []).find((r: Json) => r.status === "pending");
    if (pendingReq) {
      const match = turnItems.find((i) => i.requestId === pendingReq.id);
      pending = {
        requestId: pendingReq.id,
        kind: pendingReq.kind,
        prompt: match?.prompt ?? null,
        reason: match?.reason ?? null,
        questions: (match?.questions ?? []).map((q: Json) => ({
          id: q.id,
          header: q.header,
          question: q.question,
          multiSelect: Boolean(q.multiSelect),
          options: q.options ?? [],
        })),
        options: (match?.options ?? []).map((o: Json) => ({ decision: o.decision, label: o.label })),
      };
    }
    const detail: ThreadDetail = { id: threadId, items, pending };
    detailCache.set(threadId, { key, detail });
    return detail;
  }

  // ---------------------------------------------------------------- board settings + GitLab

  const syncStatus = new Map<string, BoardState["sync"]>();
  const labelCache = new Map<string, BoardState["labels"]>();
  /** Bumped whenever a board's link changes, so a sync that started before it is thrown away. */
  const linkGeneration = new Map<string, number>();
  const defaults = defaultBoardSettings();

  function storedBoard(projectId: string): StoredBoard | undefined {
    return store.data.boards[projectId];
  }

  function settingsOf(projectId: string): BoardSettings {
    return storedBoard(projectId)?.settings ?? defaults;
  }

  function tokenOf(projectId: string): string | null {
    return storedBoard(projectId)?.gitlabToken || process.env.GITLAB_TOKEN || null;
  }

  function gitlabActive(projectId: string): boolean {
    const g = settingsOf(projectId).gitlab;
    return g.enabled && Boolean(g.project);
  }

  function targetOf(projectId: string) {
    return gitlab.targetOf(settingsOf(projectId).gitlab, tokenOf(projectId));
  }

  function statusOf(projectId: string): BoardState["sync"] {
    let st = syncStatus.get(projectId);
    if (!st) syncStatus.set(projectId, (st = { at: null, error: null, count: 0, busy: false }));
    return st;
  }

  function boardState(projectId: string): BoardState {
    const settings = settingsOf(projectId);
    return {
      ...settings,
      gitlab: { ...settings.gitlab, hasToken: Boolean(tokenOf(projectId)) },
      labels: labelCache.get(projectId) ?? [],
      sync: { ...statusOf(projectId) },
    };
  }

  function boardsSnapshot(): Record<string, BoardState> {
    const ids = new Set([...snapshot.projects.map((p) => p.id), ...Object.keys(store.data.boards)]);
    return Object.fromEntries([...ids].map((id) => [id, boardState(id)]));
  }

  function column(projectId: string, id: string): BoardColumn {
    const columns = settingsOf(projectId).columns;
    const col = columns.find((c) => c.id === id);
    if (!col) throw httpError(400, `Unknown column "${id}". Columns: ${columns.map((c) => c.id).join(", ")}`);
    return col;
  }

  function gitlabIssueId(g: gitlab.GitlabIssue) {
    return `gl-${g.project_id}-${g.iid}`;
  }

  function fromGitlab(projectId: string, g: gitlab.GitlabIssue, prev: Issue | undefined): Issue {
    const labels = Array.isArray(g.labels) ? g.labels.map(String) : [];
    return {
      id: gitlabIssueId(g),
      projectId,
      title: String(g.title ?? "").slice(0, 200),
      body: String(g.description ?? "").slice(0, 8000),
      status: gitlab.columnForIssue({ state: g.state, labels }, settingsOf(projectId).columns)?.id ?? "",
      labels,
      assignee: prev?.assignee ?? null,
      createdBy: prev?.createdBy ?? (g.author?.username ? `@${g.author.username}` : "gitlab"),
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      source: "gitlab",
      external: { iid: g.iid, url: g.web_url, state: g.state === "closed" ? "closed" : "opened", projectId: g.project_id },
    };
  }

  /** Puts one GitLab issue on the board, updating the existing ticket object in place. */
  function upsertGitlab(projectId: string, g: gitlab.GitlabIssue): Issue {
    const existing = store.data.issues.find((i) => i.id === gitlabIssueId(g));
    const next = fromGitlab(projectId, g, existing);
    if (existing) Object.assign(existing, next);
    else store.data.issues.push(next);
    store.save();
    broadcast();
    return existing ?? next;
  }

  function dropGitlabIssues(projectId: string) {
    const before = store.data.issues.length;
    store.data.issues = store.data.issues.filter((i) => !(i.projectId === projectId && i.source === "gitlab"));
    if (store.data.issues.length !== before) store.save();
  }

  /** Re-sorts tickets into columns after the columns change. */
  function restatus(projectId: string) {
    const columns = settingsOf(projectId).columns;
    const ids = new Set(columns.map((c) => c.id));
    for (const issue of store.data.issues) {
      if (issue.projectId !== projectId) continue;
      if (issue.source === "gitlab" && issue.external) {
        issue.status = gitlab.columnForIssue({ state: issue.external.state, labels: issue.labels }, columns)?.id ?? "";
      } else if (!ids.has(issue.status)) {
        // Its column was removed: park it in the first column rather than losing it.
        issue.status = columns[0].id;
      }
    }
    store.save();
  }

  async function syncGitlab(projectId: string): Promise<void> {
    const st = statusOf(projectId);
    if (!gitlabActive(projectId)) {
      dropGitlabIssues(projectId);
      Object.assign(st, { error: null, count: 0 });
      broadcast();
      return;
    }
    if (st.busy) return;
    const generation = linkGeneration.get(projectId) ?? 0;
    st.busy = true;
    broadcast();
    try {
      const target = targetOf(projectId);
      const wantClosed = settingsOf(projectId).columns.some((c) => c.gitlabState === "closed");
      const [list, labels] = await Promise.all([
        gitlab.listIssues(target, { closed: wantClosed }),
        gitlab.listLabels(target).catch(() => labelCache.get(projectId) ?? []),
      ]);
      if ((linkGeneration.get(projectId) ?? 0) !== generation) return; // the link changed meanwhile
      labelCache.set(projectId, labels);
      const prev = new Map(store.data.issues.filter((i) => i.projectId === projectId && i.source === "gitlab").map((i) => [i.id, i]));
      const mapped = [...list]
        .sort((a: any, b: any) => (a.relative_position ?? Infinity) - (b.relative_position ?? Infinity) || a.iid - b.iid)
        .map((g) => fromGitlab(projectId, g, prev.get(gitlabIssueId(g))));
      store.data.issues = [...store.data.issues.filter((i) => !(i.projectId === projectId && i.source === "gitlab")), ...mapped];
      store.save();
      Object.assign(st, { at: new Date().toISOString(), error: null, count: mapped.length });
    } catch (error) {
      st.error = (error as Error).message;
    } finally {
      st.busy = false;
      broadcast();
    }
  }

  function syncAllGitlab() {
    for (const projectId of Object.keys(store.data.boards)) {
      if (gitlabActive(projectId)) void syncGitlab(projectId);
    }
  }

  function saveSettings(projectId: string, settings: BoardSettings, token?: string | null) {
    const prev = storedBoard(projectId);
    const linkChanged =
      JSON.stringify(prev?.settings.gitlab ?? defaults.gitlab) !== JSON.stringify(settings.gitlab) || token !== undefined;
    store.data.boards[projectId] = { settings, gitlabToken: token !== undefined ? token : (prev?.gitlabToken ?? null) };
    store.save();
    restatus(projectId);
    if (linkChanged) {
      linkGeneration.set(projectId, (linkGeneration.get(projectId) ?? 0) + 1);
      labelCache.delete(projectId);
      statusOf(projectId).busy = false;
      dropGitlabIssues(projectId);
      void syncGitlab(projectId);
    }
    broadcast();
  }

  async function updateSettings(projectId: string, patch: Json): Promise<BoardState> {
    if (!snapshot.projects.some((p) => p.id === projectId) && !storedBoard(projectId)) throw httpError(404, "Unknown project");
    let token: string | null | undefined;
    if (patch?.gitlab && typeof patch.gitlab === "object" && "token" in patch.gitlab) {
      const t = patch.gitlab.token;
      token = typeof t === "string" && t.trim() ? t.trim() : null;
      patch = { ...patch, gitlab: { ...patch.gitlab } };
      delete patch.gitlab.token;
    }
    let next: BoardSettings;
    try {
      next = applyBoardPatch(settingsOf(projectId), patch);
    } catch (error) {
      if (error instanceof BoardSettingsError) throw httpError(400, error.message);
      throw error;
    }
    saveSettings(projectId, next, token);
    return boardState(projectId);
  }

  /** Replaces the columns with the lists of the linked GitLab issue board. */
  async function importColumns(projectId: string): Promise<BoardState> {
    const settings = settingsOf(projectId);
    if (!settings.gitlab.project) throw httpError(400, "Link a GitLab project first (gitlab.url or gitlab.project)");
    if (!settings.gitlab.boardId) throw httpError(400, "Set gitlab.boardId (or paste the board's URL) to import its columns");
    const cols = await gitlab.boardColumns(targetOf(projectId), settings.gitlab.boardId);
    if (!cols.length) throw httpError(400, "That GitLab board has no lists to import");
    const columns = cols.map((c) => ({ ...c, id: slugify(c.title) }));
    const ids = [...new Set(columns.map((c) => c.id))];
    // Keep the wall on the board's working lists when there are more than four.
    const wall = ids.length > WALL_MAX_COLUMNS && columns[0].gitlabState === "opened" ? ids.slice(1, WALL_MAX_COLUMNS + 1) : ids.slice(0, WALL_MAX_COLUMNS);
    return updateSettings(projectId, { columns, wall: { columns: wall }, view: { columns: ids } });
  }

  // ---------------------------------------------------------------- issues + PM

  function findIssue(id: string): Issue {
    const issue = store.data.issues.find((i) => i.id === id);
    if (!issue) throw httpError(404, "No such issue");
    return issue;
  }

  function gitlabTicket(issue: Issue) {
    if (issue.source !== "gitlab" || !issue.external) return null;
    if (!gitlabActive(issue.projectId)) throw httpError(409, "This ticket comes from GitLab, but the board's GitLab link is off");
    return { iid: issue.external.iid, target: targetOf(issue.projectId) };
  }

  /** Moves a ticket to a column, in GitLab too when it's a GitLab ticket. */
  async function moveIssue(issue: Issue, columnId: string): Promise<Issue> {
    const to = column(issue.projectId, columnId);
    const gl = gitlabTicket(issue);
    if (gl) {
      const edit = gitlab.moveEdit({ state: issue.external!.state, labels: issue.labels }, to, settingsOf(issue.projectId).columns);
      if (!Object.keys(edit).length) return issue;
      return upsertGitlab(issue.projectId, await gitlab.updateIssue(gl.target, gl.iid, edit));
    }
    issue.status = to.id;
    issue.updatedAt = new Date().toISOString();
    store.save();
    broadcast();
    return issue;
  }

  function readLabels(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw httpError(400, "labels must be an array of strings");
    return [...new Set(value.map((l) => String(l).trim()).filter(Boolean))].slice(0, 30);
  }

  async function createIssue(body: Json): Promise<Issue> {
    const projectId = String(body.projectId);
    const settings = settingsOf(projectId);
    const col = body.status ? column(projectId, String(body.status)) : settings.columns[0];
    const title = String(body.title).slice(0, 200);
    const text = String(body.body ?? "").slice(0, 8000);
    const labels = readLabels(body.labels) ?? [];
    const createdBy = String(body.createdBy ?? "agent").slice(0, 60);
    if (gitlabActive(projectId) && body.local !== true) {
      const target = targetOf(projectId);
      const withColumn = col.gitlabLabel ? [...new Set([...labels, col.gitlabLabel])] : labels;
      let g = await gitlab.createIssue(target, { title, description: text, labels: withColumn });
      if (col.gitlabState === "closed") g = await gitlab.updateIssue(target, g.iid, { state_event: "close" });
      const issue = upsertGitlab(projectId, g);
      issue.createdBy = createdBy;
      store.save();
      return issue;
    }
    const now = new Date().toISOString();
    const issue: Issue = {
      id: randomUUID(),
      projectId,
      title,
      body: text,
      status: col.id,
      labels,
      assignee: null,
      createdBy,
      createdAt: now,
      updatedAt: now,
      source: "local",
      external: null,
    };
    store.data.issues.push(issue);
    store.save();
    broadcast();
    return issue;
  }

  async function patchIssue(issue: Issue, body: Json): Promise<Issue> {
    const labels = readLabels(body.labels);
    const title = typeof body.title === "string" ? body.title.slice(0, 200) : undefined;
    const text = typeof body.body === "string" ? body.body.slice(0, 8000) : undefined;
    const to = body.status !== undefined && body.status !== issue.status ? column(issue.projectId, String(body.status)) : null;
    if (body.assignee !== undefined) issue.assignee = body.assignee || null;
    const gl = gitlabTicket(issue);
    if (gl) {
      const edit: Parameters<typeof gitlab.updateIssue>[2] = {};
      if (title !== undefined) edit.title = title;
      if (text !== undefined) edit.description = text;
      const columns = settingsOf(issue.projectId).columns;
      const state = issue.external!.state;
      if (labels) {
        // Explicit tags keep the ticket's column label unless it's moving.
        const colLabels = new Set(columns.map((c) => c.gitlabLabel?.toLowerCase()).filter(Boolean));
        const keep = to ? [] : issue.labels.filter((l) => colLabels.has(l.toLowerCase()));
        edit.labels = [...new Set([...labels.filter((l) => !colLabels.has(l.toLowerCase())), ...keep])];
        if (to) {
          if (!to.gitlabLabel && !to.gitlabState) throw httpError(400, `Column "${to.title}" isn't linked to GitLab`);
          if (to.gitlabLabel) edit.labels.push(to.gitlabLabel);
          if (to.gitlabState === "closed" && state !== "closed") edit.state_event = "close";
          if (to.gitlabState !== "closed" && state === "closed") edit.state_event = "reopen";
        }
      } else if (to) {
        Object.assign(edit, gitlab.moveEdit({ state, labels: issue.labels }, to, columns));
      }
      if (Object.keys(edit).length) return upsertGitlab(issue.projectId, await gitlab.updateIssue(gl.target, gl.iid, edit));
      store.save();
      broadcast();
      return issue;
    }
    if (labels) issue.labels = labels;
    if (title !== undefined) issue.title = title;
    if (text !== undefined) issue.body = text;
    if (to) issue.status = to.id;
    issue.updatedAt = new Date().toISOString();
    store.save();
    broadcast();
    return issue;
  }

  /** Marks a ticket as taken by an agent and moves it to the "assigned" column. */
  async function startWork(issue: Issue, threadId: string): Promise<{ issue: Issue; warning?: string }> {
    issue.assignee = threadId;
    issue.updatedAt = new Date().toISOString();
    store.save();
    try {
      return { issue: await moveIssue(issue, settingsOf(issue.projectId).flow.onAssign) };
    } catch (error) {
      broadcast();
      return { issue, warning: `Assigned, but couldn't move the ticket: ${(error as Error).message}` };
    }
  }

  function ticketMessage(issue: Issue) {
    const base = options.publicUrl();
    const finish = settingsOf(issue.projectId).flow.onFinish;
    return [
      `You've been assigned ticket ${issue.external ? `#${issue.external.iid} (GitLab: ${issue.external.url})` : `#${issue.id.slice(0, 6)}`} from the office issue board.`,
      ``,
      `# ${issue.title}`,
      issue.body ? `\n${issue.body}\n` : "",
      `When you finish, move the ticket on: curl -s -X PATCH ${base}/api/issues/${encodeURIComponent(issue.id)} -H 'content-type: application/json' -d '{"status":"${finish}"}'`,
    ].join("\n");
  }

  function boardGuide(projectId: string) {
    const base = options.publicUrl();
    const s = settingsOf(projectId);
    const cols = s.columns.map((c) => `${c.id} ("${c.title}")`).join(", ");
    return `Board API for project ${projectId} (JSON over HTTP, use curl):
- List tickets:     curl -s '${base}/api/issues?projectId=${projectId}'
- Create a ticket:  curl -s -X POST ${base}/api/issues -H 'content-type: application/json' -d '{"projectId":"${projectId}","title":"...","body":"...","labels":["optional tag"],"status":"<optional column id>"}'
- Update a ticket:  curl -s -X PATCH ${base}/api/issues/<id> -H 'content-type: application/json' -d '{"status":"<column id>","title":"...","body":"...","labels":["..."]}'
- Delete a ticket:  curl -s -X DELETE ${base}/api/issues/<id>   (GitLab tickets get closed in GitLab, not deleted)
- List agents on this floor (id, title, activity): curl -s '${base}/api/agents?projectId=${projectId}'
- Assign a ticket to an existing agent (sends them the ticket): curl -s -X POST ${base}/api/issues/<id>/assign -H 'content-type: application/json' -d '{"threadId":"<agent id>"}'
- Hire a new agent for a ticket (they take a free desk and start on it): curl -s -X POST ${base}/api/issues/<id>/hire

Board settings (columns, what the wall board and the board view show, the GitLab link):
- Read:   curl -s '${base}/api/board/settings?projectId=${projectId}'
- Change: curl -s -X PATCH ${base}/api/board/settings -H 'content-type: application/json' -d '{"projectId":"${projectId}", ...only the fields to change}'
  Fields:
  - "columns": the full list of columns, in order: [{"id","title","color":"#rrggbb","gitlabLabel":"<label>"|null,"gitlabState":"opened"|"closed"|null}]. A ticket's status is its column id. With GitLab linked, a column holds the issues with its label (gitlabLabel), or all open issues not in another column ("opened"), or closed issues ("closed").
  - "wall": {"columns":[up to ${WALL_MAX_COLUMNS} column ids], "tags":"all"|"none"|["tag", ...]}: the big board on the office wall.
  - "view": {"columns":[column ids], "tags":"all"|"none"|["tag", ...]}: the board you open with B. "tags" picks which tags show on cards.
  - "flow": {"onAssign":"<column id>","onFinish":"<column id>"}: where tickets move when assigned, and when their agent finishes.
  - "gitlab": {"url":"https://gitlab.com/group/project/-/boards/<id>"} (or "baseUrl", "project", "boardId"), "enabled":true|false, "token":"<access token with api scope>" (write-only; "" clears it).
- Sync GitLab now:                      curl -s -X POST ${base}/api/board/sync -H 'content-type: application/json' -d '{"projectId":"${projectId}"}'
- Copy the GitLab board's lists as columns: curl -s -X POST ${base}/api/board/import -H 'content-type: application/json' -d '{"projectId":"${projectId}"}'

Current columns: ${cols}. Wall shows: ${s.wall.columns.join(", ")}. Board view shows: ${s.view.columns.join(", ")}. GitLab: ${s.gitlab.enabled ? `linked to ${s.gitlab.baseUrl}/${s.gitlab.project}` : "not linked"}.`;
  }

  function pmBrief(project: ProjectInfo) {
    const base = options.publicUrl();
    const agentsAre = project.backend === "claude" ? "Claude Code sessions" : "T3 Code threads";
    return `You are the Issue Board Manager for the "${project.title}" floor of Agent Office, a 3D office where coding agents (${agentsAre}) work at desks. Project folder: ${project.workspaceRoot}. Project id: ${project.id}.

Your job is to run the floor's issue board: turn the boss's requests into clear tickets, keep the board tidy, and get tickets done by assigning them to agents. Don't write the project code yourself. Delegate it. You also own the board's settings: its columns, which columns and tags the wall board and the board view show, and its link to a GitLab issue board. Change them when the boss asks.

${boardGuide(project.id)}

The full, current API guide is always at: curl -s '${base}/api/board/guide?projectId=${project.id}'

Prefer assigning to idle agents whose title fits the work; hire a new agent when nobody fits. Don't assign tickets to the floor manager (isManager in the agent list): they staff the floor and don't write code, though they may ask you for tickets. Keep replies short and say what you changed on the board. Start by checking the board and the agents, then say hi to the boss in one or two sentences and wait for instructions.`;
  }

  // ---------------------------------------------------------------- the intern

  /**
   * The intern's thread has to live in some T3 project. T3's own "No project" scratch space fits
   * best (they aren't tied to any project), then a project at your home folder, then any project.
   * With no T3 Code projects (or no T3 Code), they're a Claude Code session on the boss's floor.
   */
  function internHome(floorId?: string): ProjectInfo | undefined {
    const scratch = join(T3_HOME, "scratch");
    const ps = snapshot.projects.filter((p) => p.backend !== "claude");
    const t3Home = ps.find((p) => p.workspaceRoot === scratch) ?? ps.find((p) => p.title === "No project") ?? ps.find((p) => p.workspaceRoot === homedir()) ?? ps[0];
    if (t3Home) return t3Home;
    const cs = snapshot.projects.filter((p) => p.backend === "claude");
    return cs.find((p) => p.id === floorId) ?? cs[0];
  }

  /** What the office's agents are, for briefs that span every floor. */
  function agentKinds() {
    const claudeFloors = snapshot.projects.some((p) => p.backend === "claude");
    const t3Floors = snapshot.projects.some((p) => p.backend !== "claude");
    if (!claudeFloors) return { agents: "T3 Code threads", floors: "T3 Code projects" };
    if (!t3Floors) return { agents: "Claude Code sessions", floors: "Claude Code folders" };
    return { agents: "T3 Code threads and Claude Code sessions", floors: "T3 Code projects and Claude Code folders" };
  }

  function floorContext(projectId: unknown): string {
    const p = snapshot.projects.find((x) => x.id === projectId);
    return p ? `[Office: the boss is on the "${p.title}" floor (project folder: ${p.workspaceRoot}, project id: ${p.id})]\n\n` : "";
  }

  function internBrief(firstAsk?: string) {
    const base = options.publicUrl();
    const floors = snapshot.projects.map((p) => `- "${p.title}": ${p.workspaceRoot} (project id ${p.id})`).join("\n");
    const kinds = agentKinds();
    return `You are the boss's intern in Agent Office, a 3D office where coding agents (${kinds.agents}) work at desks, one floor per project. Unlike everyone else you have no desk and no project of your own: you follow the boss around from floor to floor and help with whatever they ask.

What the boss will ask you:
- How something works in one of their projects. Read the code (use the absolute paths below) and explain it plainly, citing file paths. Don't change a project's files unless the boss explicitly asks you to. For bigger feature work, suggest hiring an agent on that floor.
- General questions and errands: explanations, research, looking things up, quick scripts, drafts, anything an eager assistant could do.
- What's going on in the office: who's working on what, and what's on each floor's issue board.

Where the boss is: each message from the boss starts with a line like [Office: the boss is on the "<floor>" floor (project folder: <path>, ...)]. When they say "this project", "here" or "this code", they mean that floor's project. If there's no such line, they're talking to you from somewhere else.

The floors (${kinds.floors}) right now:
${floors}
The list can change. Current list: curl -s '${base}/api/projects'

Office API (JSON over HTTP, use curl):
- Agents and what they're on (id, title, activity, projectId): curl -s '${base}/api/agents'   (add ?projectId=<id> for one floor)
- What an agent has been doing (their recent messages and tool calls): curl -s '${base}/api/threads/<agent id>'
- A floor's issue board: curl -s '${base}/api/issues?projectId=<id>'   Full board API: curl -s '${base}/api/board/guide?projectId=<id>'
- Only when the boss asks you to:
  - Pass a message to an agent: curl -s -X POST ${base}/api/threads/<agent id>/send -H 'content-type: application/json' -d '{"text":"..."}'
  - Hire an agent on a floor: curl -s -X POST ${base}/api/hire -H 'content-type: application/json' -d '{"projectId":"<id>","message":"<their task>","title":"<short job title>"}'

How to work: you're an intern, so be eager, quick, and honest about what you don't know. The boss reads your replies in a small chat panel while walking around, so keep them short: lead with the answer, then the detail that matters. Ask before doing anything destructive or that other people would see.

${firstAsk ? `The boss's first request:\n\n${firstAsk}` : "Say hi to the boss in one short sentence, then wait for instructions."}`;
  }

  /** Recruits the intern (there's only ever one). `floorId` is where the boss is right now. */
  async function recruitIntern(opts: { message?: string; model?: string; provider?: string; floorId?: string }) {
    const existing = store.data.intern;
    if (existing && inOffice(existing)) return existing;
    const home = internHome(opts.floorId);
    if (!home) throw httpError(409, "There are no T3 Code projects yet. Add one first.");
    const firstAsk = opts.message?.trim() ? floorContext(opts.floorId) + opts.message.trim() : undefined;
    // Models belong to a backend: drop one picked for the other.
    const fits = (home.backend === "claude") === (opts.provider === CLAUDE_PROVIDER);
    internStarting = Date.now();
    try {
      const { threadId } = await startThread({
        projectId: home.id,
        message: internBrief(firstAsk),
        title: "Intern",
        model: fits ? opts.model : undefined,
        provider: fits ? opts.provider : undefined,
        officeApi: true,
      });
      store.data.intern = threadId;
      store.save();
      return threadId;
    } finally {
      internStarting = 0;
      void poll();
    }
  }

  async function hire(projectId: string, opts: { message: string; title?: string; model?: string; provider?: string; desk?: number; by?: string }) {
    const by = opts.by ?? "api";
    const desk = typeof opts.desk === "number" && opts.desk >= 0 && opts.desk < DESK_COUNT ? opts.desk : undefined;
    if (desk !== undefined) {
      deskReservations.set(projectId, [...(deskReservations.get(projectId) ?? []), desk]);
    }
    try {
      const { threadId } = await startThread({
        projectId,
        message: manager.hireMessage(projectId, opts.message, by),
        title: opts.title,
        model: opts.model,
        provider: opts.provider,
      });
      if (desk !== undefined) {
        for (const [id, seat] of Object.entries(store.data.desks)) {
          if (seat.projectId === projectId && seat.desk === desk && id !== threadId) delete store.data.desks[id];
        }
        store.data.desks[threadId] = { projectId, desk };
        store.save();
      }
      manager.onHired(projectId, threadId, opts.title || opts.message.trim().split("\n")[0].slice(0, 80), by);
      return threadId;
    } finally {
      if (desk !== undefined) {
        const list = (deskReservations.get(projectId) ?? []).filter((d) => d !== desk);
        deskReservations.set(projectId, list);
      }
      void poll();
    }
  }

  // ---------------------------------------------------------------- routing

  async function route(method: string, path: string, query: URLSearchParams, body: Json): Promise<Json> {
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
    const [, a, b, c] = parts;
    const managed = await manager.route(method, parts, query, body);
    if (managed !== undefined) return managed;

    if (method === "GET" && a === "state") return snapshot;
    if (method === "GET" && a === "projects") return snapshot.projects;
    if (method === "GET" && a === "agents") {
      const pid = query.get("projectId");
      return snapshot.agents
        .filter((x) => !pid || x.projectId === pid)
        .map(({ id, title, activity, status, projectId, desk, isPm, isManager, isIntern }) => ({ id, title, activity, status, projectId, desk, isPm, isManager, isIntern }));
    }
    if (method === "GET" && a === "threads" && b && !c) return getDetail(b);

    if (method === "POST" && a === "hire") {
      if (!body.projectId || !body.message) throw httpError(400, "projectId and message are required");
      const threadId = await hire(body.projectId, { ...body, by: typeof body.by === "string" ? body.by.slice(0, 40) : undefined });
      return { threadId, name: bloopName(threadId) };
    }

    if (method === "POST" && a === "threads" && b && isClaudeThread(b)) {
      switch (c) {
        case "send":
          if (!body.text?.trim()) throw httpError(400, "text is required");
          await claude.send(b, (b === store.data.intern ? floorContext(body.floorId) : "") + body.text);
          break;
        case "archive":
          await claude.archive(b);
          break;
        case "layoff":
          await layOff(b, { by: typeof body.by === "string" ? body.by : undefined, reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : null });
          break;
        case "stop":
          await claude.stop(b);
          break;
        case "settle":
        case "visit":
          claude.visit(b);
          break;
        case "respond":
          if (!body.requestId) throw httpError(400, "requestId is required");
          claude.respond(b, body.requestId, body);
          break;
        default:
          throw httpError(404, "Unknown thread action");
      }
      void poll();
      return { ok: true };
    }

    if (method === "POST" && a === "threads" && b) {
      switch (c) {
        case "send":
          if (!body.text?.trim()) throw httpError(400, "text is required");
          // The intern follows the boss, so tell them which floor the boss is on.
          await t3.sendMessage(b, (b === store.data.intern ? floorContext(body.floorId) : "") + body.text);
          break;
        case "archive":
          await t3.archive(b);
          break;
        case "layoff":
          await layOff(b, { by: typeof body.by === "string" ? body.by : undefined, reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : null });
          break;
        case "stop":
          await t3.stop(b);
          break;
        case "settle":
          await t3.settle(b);
          break;
        case "visit":
          await t3.visit(b);
          break;
        case "respond":
          await t3.respond(b, body.requestId, body);
          break;
        default:
          throw httpError(404, "Unknown thread action");
      }
      detailCache.delete(b);
      void poll();
      return { ok: true };
    }

    if (method === "POST" && a === "meeting") {
      const ids: string[] = body.threadIds ?? [];
      if (!ids.length || !body.text?.trim()) throw httpError(400, "threadIds and text are required");
      const roster = ids
        .map((id) => snapshot.agents.find((x) => x.id === id))
        .filter(Boolean)
        .map((x) => `"${x!.title}"`)
        .join(", ");
      const message = `[Office meeting. Attendees: you and ${ids.length - 1} other agent(s): ${roster}. The boss says:]\n\n${body.text}\n\n(Reply briefly and directly, as in a meeting.)`;
      const results = await Promise.allSettled(ids.map((id) => sendTo(id, message)));
      void poll();
      return { sent: results.filter((r) => r.status === "fulfilled").length };
    }

    if (method === "POST" && a === "projects") {
      if (!body.path) throw httpError(400, "path is required");
      if (body.backend === "claude") {
        let project: ProjectInfo;
        try {
          project = await claude.addProject(String(body.path));
        } catch (error) {
          throw httpError(400, (error as Error).message);
        }
        void poll();
        return { ok: true, project };
      }
      await t3.addProject(body.path);
      void poll();
      return { ok: true };
    }

    if (method === "POST" && a === "intern" && !b) {
      const threadId = await recruitIntern({
        message: typeof body.message === "string" ? body.message : undefined,
        model: body.model || undefined,
        provider: body.provider || undefined,
        floorId: typeof body.floorId === "string" ? body.floorId : undefined,
      });
      return { threadId };
    }

    if (method === "POST" && a === "pm") {
      const projectId = body.projectId;
      const project = snapshot.projects.find((p) => p.id === projectId);
      if (!project) throw httpError(404, "Unknown project");
      const existing = store.data.pm[projectId];
      if (existing && inOffice(existing)) return { threadId: existing };
      const { threadId } = await startThread({
        projectId,
        message: pmBrief(project),
        title: `Issue Board PM · ${project.title}`,
        officeApi: true,
      });
      store.data.pm[projectId] = threadId;
      store.save();
      void poll();
      return { threadId };
    }

    if (a === "board") {
      const projectId = String(query.get("projectId") ?? body.projectId ?? "");
      if (!projectId) throw httpError(400, "projectId is required");
      if (method === "GET" && b === "settings") return boardState(projectId);
      if (method === "GET" && b === "guide") return boardGuide(projectId);
      if (method === "PATCH" && b === "settings") {
        const { projectId: _ignored, ...patch } = body;
        return updateSettings(projectId, patch);
      }
      if (method === "POST" && b === "sync") {
        if (!gitlabActive(projectId)) throw httpError(400, "This board isn't linked to GitLab");
        await syncGitlab(projectId);
        return boardState(projectId);
      }
      if (method === "POST" && b === "import") return importColumns(projectId);
    }

    if (a === "issues") {
      if (method === "GET" && !b) {
        const pid = query.get("projectId");
        return store.data.issues.filter((i) => !pid || i.projectId === pid);
      }
      if (method === "POST" && !b) {
        if (!body.projectId || !body.title) throw httpError(400, "projectId and title are required");
        return createIssue(body);
      }
      if (b) {
        const issue = findIssue(b);
        if (method === "PATCH" && !c) return patchIssue(issue, body);
        if (method === "DELETE" && !c) {
          const gl = gitlabTicket(issue);
          if (gl) {
            // Deleting GitLab issues needs owner rights and can't be undone, so close it instead.
            const g = await gitlab.updateIssue(gl.target, gl.iid, { state_event: "close" });
            const showsClosed = settingsOf(issue.projectId).columns.some((col) => col.gitlabState === "closed");
            if (showsClosed) upsertGitlab(issue.projectId, g);
            else {
              store.data.issues = store.data.issues.filter((i) => i.id !== issue.id);
              store.save();
              broadcast();
            }
            return { ok: true, closedInGitlab: true };
          }
          store.data.issues = store.data.issues.filter((i) => i.id !== issue.id);
          store.save();
          broadcast();
          return { ok: true };
        }
        if (method === "POST" && c === "assign") {
          if (!body.threadId) throw httpError(400, "threadId is required");
          await sendTo(body.threadId, ticketMessage(issue));
          const { issue: updated, warning } = await startWork(issue, body.threadId);
          return warning ? { ...updated, warning } : updated;
        }
        if (method === "POST" && c === "hire") {
          const threadId = await hire(issue.projectId, {
            message: ticketMessage(issue),
            title: issue.title,
            desk: typeof body.desk === "number" ? body.desk : undefined,
            by: "issue board",
          });
          const { issue: updated, warning } = await startWork(issue, threadId);
          return { issue: updated, threadId, warning };
        }
      }
    }
    throw httpError(404, `No route for ${method} ${path}`);
  }

  async function middleware(req: IncomingMessage, res: ServerResponse, next: Next) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return next();
    // Agents here run with full access, so only this machine's own pages and local
    // tools (curl) may drive them: reject DNS-rebound hosts and cross-site origins.
    if (!isLocalRequest(req)) {
      res.statusCode = 403;
      return res.end("Forbidden");
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      clients.add(res);
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }
    try {
      const body = req.method === "GET" ? {} : await readJson(req);
      const result = await route(req.method ?? "GET", url.pathname, url.searchParams, body);
      if (typeof result === "string") {
        res.setHeader("content-type", "text/plain; charset=utf-8");
        return res.end(result + "\n");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }

  void poll().then(() => {
    schedule();
    syncAllGitlab();
  });
  const gitlabTimer = setInterval(syncAllGitlab, GITLAB_SYNC_MS);

  return {
    middleware,
    close() {
      if (pollTimer) clearTimeout(pollTimer);
      if (claudeRefresh) clearTimeout(claudeRefresh);
      clearInterval(gitlabTimer);
      claude.close();
      for (const res of clients) res.end();
      store.flush();
    },
  };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

function isLocalRequest(req: IncomingMessage): boolean {
  const host = hostnameOf(req.headers.host ?? "");
  if (!host || !LOCAL_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    const originHost = hostnameOf(origin);
    if (!originHost || !LOCAL_HOSTS.has(originHost)) return false;
  } else if (origin === "null") {
    return false;
  }
  return true;
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function readJson(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(httpError(413, "Body too large"));
    });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(httpError(400, "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
