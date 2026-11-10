// Demo agents for when T3 Code isn't running, so the office (and the ray tracer's glowing
// status lights) has someone in it. On with ?demo, or automatically when T3 Code can't be reached;
// ?demo=0 turns it off.

import type { Activity, ActivityItem, AgentInfo, Issue, OfficeSnapshot, ThreadDetail } from "../../shared/types.ts";

const SCRIPT: [string, string][] = [
  ["user", "Can you take this one?"],
  ["thinking", "Reading the code around the failing path"],
  ["command", "rg -n \"traceScene\" src/"],
  ["file", "src/rt/glsl.ts"],
  ["command", "npm test -- --runInBand"],
  ["thinking", "The BVH stack overflows on deep trees"],
  ["file", "src/rt/bake.ts"],
  ["todo", "Add a regression test"],
  ["command", "npm run build"],
  ["assistant", "Done: the change is in, tests pass and the build is green."],
];

/** Fake thread history for a demo agent's monitor and chat panel. */
export function demoDetail(id: string): ThreadDetail {
  const n = Number(id.split("-").pop()) || 1;
  const now = Date.now();
  const items: ActivityItem[] = SCRIPT.map(([type, text], i) => ({
    id: `${id}-${i}`,
    type,
    text,
    title: null,
    status: type === "command" ? "completed" : null,
    at: new Date(now - (SCRIPT.length - i) * 45_000 * n).toISOString(),
    role: type === "user" ? "user" : type === "assistant" ? "assistant" : undefined,
  }));
  return { id, items: items.slice(0, 4 + (n % 7)), pending: null };
}

const TASKS: [string, Activity][] = [
  ["Ray-traced reflections pass", "working"],
  ["Fix flaky login test", "needs-input"],
  ["Migrate billing to v2 API", "working"],
  ["Write release notes", "done"],
  ["Upgrade build toolchain", "error"],
  ["Refactor search indexer", "working"],
  ["Audit dependency licences", "idle"],
  ["Dark mode for settings", "needs-input"],
  ["Speed up CI cache", "working"],
  ["Onboarding checklist", "done"],
  ["Localise checkout flow", "working"],
  ["Profile memory spike", "idle"],
];
const DESKS = [0, 2, 4, 7, 9, 11, 13, 14, 16, 19, 21, 23];
const CYCLE: Activity[] = ["working", "needs-input", "working", "done", "working", "error", "idle"];
const PROJECT = { id: "demo-floor", title: "Demo floor", workspaceRoot: "" };

export class DemoOffice {
  readonly enabled: boolean;
  private agents: AgentInfo[];
  private issues: Issue[];
  private onChange: (() => void) | null = null;

  constructor() {
    const q = new URLSearchParams(location.search);
    this.enabled = q.get("demo") === "1";
    const now = new Date().toISOString();
    this.agents = TASKS.map(([title, activity], i) => ({
      id: `demo-agent-${i + 1}`,
      projectId: PROJECT.id,
      title,
      status: activity === "working" ? "running" : "ready",
      activity,
      pendingKind: activity === "needs-input" ? "approval" : null,
      lastMessage: activity === "needs-input" ? "Can I run the migration on staging?" : "Working on it.",
      lastMessageRole: "assistant",
      model: "claude-opus-5-5",
      provider: "claude",
      createdAt: now,
      updatedAt: now,
      link: null,
      lastError: activity === "error" ? "Build failed: exit code 1" : null,
      desk: DESKS[i],
      isPm: false,
      isManager: false,
      isIntern: false,
    }));
    this.issues = [];
    // Every so often someone's status changes, so the lights change colour.
    setInterval(() => {
      const a = this.agents[Math.floor(Math.random() * this.agents.length)];
      a.activity = CYCLE[(CYCLE.indexOf(a.activity) + 1) % CYCLE.length];
      a.status = a.activity === "working" ? "running" : "ready";
      a.pendingKind = a.activity === "needs-input" ? "approval" : null;
      a.updatedAt = new Date().toISOString();
      this.onChange?.();
    }, 9000);
  }

  /** Fills in demo agents when the bridge can't reach T3 Code. */
  wrap(s: OfficeSnapshot, onChange: () => void): OfficeSnapshot {
    this.onChange = onChange;
    if (!this.enabled || s.connected || s.projects.length) return s;
    return { ...s, connected: true, error: null, projects: [PROJECT], agents: this.agents.map((a) => ({ ...a })), issues: this.issues };
  }
}
