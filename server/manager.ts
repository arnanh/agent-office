// The floor manager: one agent per floor (project) who staffs the floor instead of writing code.
// They hire agents with clear briefs, hand them work, check on them, and fire the ones that
// are no longer needed. This module holds their brief, their API guide, the roster and the
// hiring/firing log, and the "office update" notices that tell them when their agents finish.
//
// The bridge (bridge.ts) owns polling, hiring and laying off; it calls in here through a few hooks.

import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import { bloopName } from "../shared/names.ts";
import { DESK_COUNT, MANAGER_DESK, PM_DESK, type AgentInfo, type OfficeSnapshot, type ProjectInfo, type StaffLogEntry } from "../shared/types.ts";

type Json = any;

const STAFF_LOG_MAX = 300;
/** Finish notices that land within this window go to the manager as one message. */
const NOTICE_BATCH_MS = 4000;

export interface ManagerDeps {
  store: Store;
  /** Starts a thread on the floor's backend (a T3 Code thread, or a Claude Code session on a Claude Code floor). */
  startThread: (opts: { projectId: string; message: string; title?: string; officeApi?: boolean }) => Promise<{ threadId: string }>;
  /** Messages a thread on whichever backend it runs on. */
  sendMessage: (threadId: string, text: string) => Promise<unknown>;
  publicUrl: () => string;
  snapshot: () => OfficeSnapshot;
  /** Whether the thread is currently in the office (not archived or laid off). */
  present: (threadId: string) => boolean;
  poll: () => void;
  httpError: (status: number, message: string) => Error;
}

/** "Pip", "PM Pip" or "Manager Pip". */
export function displayName(a: Pick<AgentInfo, "id" | "isPm" | "isManager">) {
  const name = bloopName(a.id);
  return a.isManager ? `Manager ${name}` : a.isPm ? `PM ${name}` : name;
}

export function createManager(deps: ManagerDeps) {
  const { store, httpError } = deps;
  const base = () => deps.publicUrl();
  const lastActivity = new Map<string, AgentInfo["activity"]>();
  const pendingNotices = new Map<string, { agents: AgentInfo[]; timer: ReturnType<typeof setTimeout> }>();

  const managerOf = (projectId: string) => store.data.managers[projectId] ?? null;
  const isManager = (threadId: string) => Object.values(store.data.managers).includes(threadId);
  const project = (projectId: string): ProjectInfo => {
    const p = deps.snapshot().projects.find((x) => x.id === projectId);
    if (!p) throw httpError(404, "Unknown project");
    return p;
  };
  const floorAgents = (projectId: string) => deps.snapshot().agents.filter((a) => a.projectId === projectId && !a.isIntern);

  // ---------------------------------------------------------------- staff log

  function record(entry: Omit<StaffLogEntry, "id" | "at" | "name"> & { name?: string }) {
    store.data.staffLog.push({ id: randomUUID(), at: new Date().toISOString(), name: entry.name ?? bloopName(entry.threadId), ...entry });
    if (store.data.staffLog.length > STAFF_LOG_MAX) store.data.staffLog.splice(0, store.data.staffLog.length - STAFF_LOG_MAX);
    store.save();
  }

  /** Called by the bridge after any hire, from anywhere (the office, the PM, the manager). */
  function onHired(projectId: string, threadId: string, title: string | undefined, by: string) {
    record({ projectId, action: "hire", threadId, title: title || "(untitled)", by, reason: null });
    // The manager hears back when the agents they hire finish.
    if (by === "manager") watchFor(projectId, threadId);
  }

  /** Called by the bridge just before laying an agent off, while their info is still around. */
  function onFired(threadId: string, by: string, reason: string | null) {
    const a = deps.snapshot().agents.find((x) => x.id === threadId);
    if (a) record({ projectId: a.projectId, action: "fire", threadId, name: displayName(a), title: a.title, by, reason });
    delete store.data.managerWatch[threadId];
    for (const [pid, tid] of Object.entries(store.data.managers)) if (tid === threadId) delete store.data.managers[pid];
    store.save();
  }

  /** Who may fire whom. The manager can't fire themselves, the boss's intern, or anyone off their floor. */
  function checkFire(threadId: string, by: string) {
    if (by !== "manager") return;
    const a = deps.snapshot().agents.find((x) => x.id === threadId);
    if (!a) throw httpError(404, "No such agent in the office");
    if (a.isManager) throw httpError(400, "A manager can't fire themselves. Ask the boss.");
    if (a.isIntern) throw httpError(400, "The intern works for the boss directly.");
  }

  /** The hire message for an agent the manager hires: their brief plus who hired them. */
  function hireMessage(projectId: string, message: string, by: string) {
    if (by !== "manager") return message;
    const mgr = managerOf(projectId);
    const who = mgr ? `${bloopName(mgr)}, the floor manager` : "the floor manager";
    return `${message}\n\n(You were hired by ${who}, in Agent Office. Work on this task on your own. When you're done, end with a short summary: what you did, how you checked it, and anything left open.)`;
  }

  // ---------------------------------------------------------------- notices to the manager

  function watchFor(projectId: string, threadId: string) {
    store.data.managerWatch[threadId] = projectId;
    store.save();
  }

  /** Runs on every poll: when an agent the manager handed work to stops working, tell the manager. */
  function onPoll(agents: AgentInfo[]) {
    for (const a of agents) {
      const before = lastActivity.get(a.id);
      lastActivity.set(a.id, a.activity);
      const pid = store.data.managerWatch[a.id];
      if (!pid || before !== "working" || a.activity === "working" || a.activity === "needs-input") continue;
      const mgr = managerOf(pid);
      if (!mgr || mgr === a.id) continue;
      let batch = pendingNotices.get(pid);
      if (!batch) {
        batch = { agents: [], timer: setTimeout(() => void flushNotices(pid), NOTICE_BATCH_MS) };
        pendingNotices.set(pid, batch);
      }
      batch.agents = [...batch.agents.filter((x) => x.id !== a.id), a];
    }
    // Forget managers whose threads are gone, and watches on agents who left.
    for (const [pid, tid] of Object.entries(store.data.managers)) {
      if (!deps.present(tid)) {
        delete store.data.managers[pid];
        store.save();
      }
    }
    for (const id of Object.keys(store.data.managerWatch)) {
      if (!deps.present(id)) {
        delete store.data.managerWatch[id];
        store.save();
      }
    }
  }

  async function flushNotices(projectId: string) {
    const batch = pendingNotices.get(projectId);
    pendingNotices.delete(projectId);
    const mgr = managerOf(projectId);
    if (!batch || !mgr) return;
    const lines = batch.agents.map((a) => {
      const what = a.activity === "error" ? `hit an error${a.lastError ? `: ${a.lastError.slice(0, 300)}` : ""}` : "finished";
      const said = a.lastMessage && a.lastMessageRole === "assistant" ? `\nTheir last message:\n> ${a.lastMessage.slice(0, 500).replace(/\n/g, "\n> ")}` : "";
      return `- ${displayName(a)} (id ${a.id}, "${a.title}", desk ${deskLabel(a.desk)}) ${what}.${said}`;
    });
    const text = `[Office update: this is the office, not the boss]\n\n${lines.join("\n\n")}\n\nRead more with curl -s '${base()}/api/threads/<id>'. Decide what's next: more work for them, a short report to the boss, or firing them if they're no longer needed.`;
    try {
      await deps.sendMessage(mgr, text);
    } catch (error) {
      console.warn(`[manager] couldn't notify ${mgr}: ${(error as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- roster

  function deskLabel(desk: number | null) {
    if (desk === null) return "none";
    if (desk === PM_DESK) return "PM desk";
    if (desk === MANAGER_DESK) return "manager's office";
    return String(desk + 1);
  }

  function roster(projectId: string) {
    const p = project(projectId);
    const now = Date.now();
    const agents = floorAgents(projectId);
    const issues = store.data.issues.filter((i) => i.projectId === projectId && i.assignee);
    const hires = new Map<string, StaffLogEntry>();
    for (const e of store.data.staffLog) if (e.action === "hire") hires.set(e.threadId, e);
    const used = agents.filter((a) => a.desk !== null && a.desk >= 0).length;
    return {
      floor: { id: p.id, title: p.title, folder: p.workspaceRoot },
      manager: managerOf(projectId),
      pm: store.data.pm[projectId] ?? null,
      freeDesks: DESK_COUNT - used,
      agents: agents.map((a) => ({
        id: a.id,
        name: displayName(a),
        title: a.title,
        role: a.isManager ? "manager" : a.isPm ? "board PM" : "agent",
        activity: a.activity,
        status: a.status,
        desk: deskLabel(a.desk),
        model: a.model,
        lastActiveMinutesAgo: Math.max(0, Math.round((now - Date.parse(a.updatedAt)) / 60_000)),
        lastMessage: a.lastMessage?.slice(0, 300) ?? null,
        tickets: issues.filter((i) => i.assignee === a.id).map((i) => ({ id: i.id, title: i.title, status: i.status })),
        hiredBy: hires.get(a.id)?.by ?? null,
        reportsToManager: Boolean(store.data.managerWatch[a.id]),
      })),
    };
  }

  // ---------------------------------------------------------------- brief + guide

  function guide(projectId: string) {
    const b = base();
    const claude = deps.snapshot().projects.find((x) => x.id === projectId)?.backend === "claude";
    const fire = claude
      ? "stops them if they're mid-task and takes them out of the office (their Claude Code session and transcript stay), frees the desk"
      : "stops them if they're mid-task, settles their thread in T3 (not deleted, the boss can bring them back), frees the desk";
    const json = `-H 'content-type: application/json'`;
    return `Floor manager API for project ${projectId} (JSON over HTTP, use curl). Pass "by":"manager" whenever you hire or fire.
- Roster: everyone on the floor (id, name, title, role, activity, desk, minutes since last active, last message, tickets):
    curl -s '${b}/api/staff?projectId=${projectId}'
- What one agent has been doing (recent messages, commands, file edits, pending questions):
    curl -s '${b}/api/threads/<id>'
- Hire an agent. They take a free desk and start on "message" right away, so make it a complete brief. Returns {"threadId","name"}:
    curl -s -X POST ${b}/api/hire ${json} -d '{"projectId":"${projectId}","title":"<short job title>","message":"<their full brief>","by":"manager"}'
    Optional: "desk": 0-${DESK_COUNT - 1}, "model", "provider". Long briefs are easiest as a heredoc: curl ... --data-binary @- <<'EOF' {...} EOF
- Message or delegate to agents (they see it's from you; "to" is an id, a list of ids, or "all" for the whole floor except you):
    curl -s -X POST ${b}/api/manager/message ${json} -d '{"projectId":"${projectId}","to":["<id>"],"text":"..."}'
- Fire an agent: ${fire}:
    curl -s -X POST ${b}/api/threads/<id>/layoff ${json} -d '{"by":"manager","reason":"<one line>"}'
- Hiring and firing history for this floor:
    curl -s '${b}/api/staff/log?projectId=${projectId}'
- The issue board (tickets, assigning them to agents): curl -s '${b}/api/board/guide?projectId=${projectId}'

When an agent you hired or messaged stops working (finished or hit an error), the office sends you an "[Office update]" message.`;
  }

  function brief(p: ProjectInfo) {
    const pm = store.data.pm[p.id];
    return `You are the Floor Manager of the "${p.title}" floor in Agent Office, a 3D office where coding agents (${p.backend === "claude" ? "Claude Code sessions" : "T3 Code threads"}) work at desks, one floor per project. Project folder: ${p.workspaceRoot}. Project id: ${p.id}. You have the corner office, and you're the one with role "manager" in the roster.

Your job is to run this floor's team for the boss. You don't write or change project code yourself: you delegate.
- Staffing: turn the boss's requests into well-scoped tasks. Give each to an idle agent whose title fits, or hire a new agent for it. Write every brief for a capable engineer who hasn't seen this conversation: the goal, where to look in the code, constraints, how to check the work, and what "done" means. Give each new hire a short job title.
- Follow-through: keep an eye on who's doing what. Read an agent's recent activity before you judge their work. Nudge, redirect or unblock them with a message.
- Keep the floor tidy: fire agents who are finished and not needed any more, stuck beyond help, or duplicating someone else. Before firing anyone with unfinished or unreported work, tell the boss. When it isn't clear, ask the boss first. Never fire yourself or the board PM unless the boss says so.
- Reporting: keep your replies to the boss short and plain: who's on what, what's done, what needs the boss.
- Hire through the office API below, not your own subagent or delegation tools, so new agents get a desk on the floor where the boss can see them and talk to them. There are ${DESK_COUNT} desks.
- The issue board belongs to the board PM${pm ? ` (${bloopName(pm)}, id ${pm})` : " (there isn't one yet)"}. You can read it and assign tickets, but leave running the board to them.

${guide(p.id)}

Start by checking the roster. Then greet the boss in one or two sentences (how many agents are on the floor and what's going on) and wait for instructions.`;
  }

  async function ensure(projectId: string) {
    const p = project(projectId);
    const existing = managerOf(projectId);
    if (existing && deps.present(existing)) return existing;
    const { threadId } = await deps.startThread({ projectId, message: brief(p), title: `Floor Manager · ${p.title}`, officeApi: true });
    store.data.managers[projectId] = threadId;
    record({ projectId, action: "hire", threadId, title: `Floor Manager · ${p.title}`, by: "boss", reason: null });
    store.save();
    deps.poll();
    return threadId;
  }

  async function message(projectId: string, to: unknown, text: string) {
    if (!text?.trim()) throw httpError(400, "text is required");
    const mgr = managerOf(projectId);
    const onFloor = floorAgents(projectId).filter((a) => a.id !== mgr);
    const ids = to === "all" ? onFloor.map((a) => a.id) : (Array.isArray(to) ? to : [to]).map(String);
    if (!ids.length) throw httpError(400, 'to is required: an agent id, a list of ids, or "all"');
    const unknown = ids.filter((id) => !onFloor.some((a) => a.id === id));
    if (unknown.length) throw httpError(400, `Not on this floor: ${unknown.join(", ")}. Check the roster.`);
    const from = mgr ? `${bloopName(mgr)}, your floor manager` : "your floor manager";
    const body = `[Message from ${from}]\n\n${text.trim()}`;
    const results = await Promise.allSettled(ids.map((id) => deps.sendMessage(id, body)));
    ids.forEach((id, i) => results[i].status === "fulfilled" && watchFor(projectId, id));
    deps.poll();
    const failed = ids.filter((_, i) => results[i].status === "rejected");
    return { sent: ids.length - failed.length, failed };
  }

  /** Handles /api/manager* and /api/staff*. Returns undefined for other routes. */
  async function route(method: string, parts: string[], query: URLSearchParams, body: Json): Promise<Json | undefined> {
    const [, a, b] = parts;
    const projectId = String(query.get("projectId") ?? body?.projectId ?? "");
    if (a === "manager") {
      if (!projectId) throw httpError(400, "projectId is required");
      if (method === "POST" && !b) return { threadId: await ensure(projectId) };
      if (method === "GET" && b === "guide") return guide(projectId);
      if (method === "POST" && b === "message") return message(projectId, body.to, body.text);
    }
    if (a === "staff") {
      if (!projectId) throw httpError(400, "projectId is required");
      if (method === "GET" && !b) return roster(projectId);
      if (method === "GET" && b === "log") {
        const limit = Math.max(1, Math.min(STAFF_LOG_MAX, Number(query.get("limit")) || 50));
        return store.data.staffLog.filter((e) => e.projectId === projectId).slice(-limit);
      }
    }
    return undefined;
  }

  return { route, onHired, onFired, onPoll, checkFire, hireMessage, isManager, managerOf };
}
