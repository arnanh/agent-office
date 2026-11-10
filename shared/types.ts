// Types shared by the bridge server and the 3D client.

export const DESK_COUNT = 24;
/** Desk index used for a floor's issue-board PM agent. */
export const PM_DESK = -1;
/** Desk index used for a floor's manager (the desk in the corner office). */
export const MANAGER_DESK = -2;

export type Activity = "working" | "needs-input" | "done" | "error" | "idle";

/** Where a floor's agents run. Missing means T3 Code. */
export type Backend = "t3" | "claude";

export interface ProjectInfo {
  id: string;
  title: string;
  workspaceRoot: string;
  backend?: Backend;
}

export interface AgentInfo {
  id: string;
  projectId: string;
  title: string;
  status: string;
  activity: Activity;
  pendingKind: string | null;
  lastMessage: string | null;
  lastMessageRole: string | null;
  model: string | null;
  provider: string | null;
  createdAt: string;
  updatedAt: string;
  link: string | null;
  lastError: string | null;
  /** Desk index on its project's floor, PM_DESK / MANAGER_DESK for those two, null if no seat. */
  desk: number | null;
  isPm: boolean;
  /** The floor manager: hires, briefs, checks on and fires the floor's agents. Doesn't write code. */
  isManager: boolean;
  /** The boss's intern: no desk, follows the boss from floor to floor. */
  isIntern: boolean;
  backend?: Backend;
}

/** A ticket's column id (see BoardSettings.columns). "" means it fits no column. */
export type IssueStatus = string;

export interface Issue {
  id: string;
  projectId: string;
  title: string;
  body: string;
  status: IssueStatus;
  /** Tags. For GitLab tickets these are the GitLab labels. */
  labels: string[];
  /** Office agent (thread id) working on it. Kept locally, even for GitLab tickets. */
  assignee: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  source: "local" | "gitlab";
  /** Set for tickets mirrored from GitLab. */
  external: { iid: number; url: string; state: "opened" | "closed"; projectId: number } | null;
}

export interface BoardColumn {
  /** Stable id, used as the ticket's status. */
  id: string;
  title: string;
  color: string;
  /** GitLab list this column mirrors: a label list, or the board's Open / Closed list. */
  gitlabLabel: string | null;
  gitlabState: "opened" | "closed" | null;
}

export interface BoardViewConfig {
  /** Column ids to show, in order. The wall board shows at most 4. */
  columns: string[];
  /** Which tags appear on cards: all of them, none, or only these. */
  tags: "all" | "none" | string[];
}

export interface GitlabLink {
  enabled: boolean;
  /** e.g. https://gitlab.com or a self-hosted instance. */
  baseUrl: string;
  /** Project path ("group/project") or numeric id. */
  project: string;
  /** Issue board to import columns from (optional). */
  boardId: number | null;
}

export interface BoardSettings {
  columns: BoardColumn[];
  /** The big board on the office wall. */
  wall: BoardViewConfig;
  /** The board view you open with B / E. */
  view: BoardViewConfig;
  /** Where tickets move automatically: when assigned, and when the agent finishes. */
  flow: { onAssign: string; onFinish: string };
  gitlab: GitlabLink;
}

/** Board settings as the client sees them: the token is never sent, only whether one is set. */
export interface BoardState extends BoardSettings {
  gitlab: GitlabLink & { hasToken: boolean };
  labels: { name: string; color: string }[];
  sync: { at: string | null; error: string | null; count: number; busy: boolean };
}

export interface OfficeSnapshot {
  connected: boolean;
  error: string | null;
  projects: ProjectInfo[];
  agents: AgentInfo[];
  issues: Issue[];
  pm: Record<string, string>;
  /** Floor manager thread per project id. */
  managers: Record<string, string>;
  /** Recent hires and firings, newest last. */
  staffLog: StaffLogEntry[];
  /** Board settings per project id. */
  boards: Record<string, BoardState>;
  bridgeUrl: string;
  /** Health of each agent backend (absent from older bridges). */
  backends?: {
    t3: { ok: boolean; error: string | null };
    claude: { ok: boolean; error: string | null; floors: number };
  };
}

/** Who did a hire or a firing: "boss" (you, in the office), "manager", "pm", or another label. */
export interface StaffLogEntry {
  id: string;
  projectId: string;
  at: string;
  action: "hire" | "fire";
  threadId: string;
  /** The agent's name and job title at the time. */
  name: string;
  title: string;
  by: string;
  reason: string | null;
}

export interface ActivityItem {
  id: string;
  type: string;
  text: string;
  title: string | null;
  status: string | null;
  at: string | null;
  role?: string;
}

export interface PendingQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: { label: string; description: string; value?: string }[];
}

export interface PendingRequest {
  requestId: string;
  kind: string;
  prompt: string | null;
  reason: string | null;
  questions: PendingQuestion[];
  options: { decision: string; label: string }[];
}

export interface ThreadDetail {
  id: string;
  items: ActivityItem[];
  pending: PendingRequest | null;
}
