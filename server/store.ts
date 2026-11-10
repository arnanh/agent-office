// Small JSON persistence for office-only state: desk seating, the issue board,
// board settings (incl. the GitLab link), and which thread is each floor's board manager.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BoardSettings, Issue, StaffLogEntry } from "../shared/types.ts";
import { normalizeBoardSettings } from "../shared/board.ts";
import type { ClaudeData } from "./claude.ts";

/** Board settings as saved. The GitLab token stays on this machine and is never sent to the page. */
export interface StoredBoard {
  settings: BoardSettings;
  gitlabToken: string | null;
}

export interface OfficeData {
  version: 1;
  desks: Record<string, { projectId: string; desk: number }>;
  issues: Issue[];
  pm: Record<string, string>;
  boards: Record<string, StoredBoard>;
  /** Threads laid off from the office (settled in T3), with when. They stay out until un-settled. */
  laidOff: Record<string, string>;
  /** Thread id of the boss's intern: a helper who follows you between floors instead of sitting at a desk. */
  intern: string | null;
  /** Floor manager thread per project id. */
  managers: Record<string, string>;
  /** Hires and firings across all floors, newest last (capped). */
  staffLog: StaffLogEntry[];
  /** Agents the floor manager handed work to (thread id -> project id): the manager hears when they finish. */
  managerWatch: Record<string, string>;
  /** Claude Code floors and the office's notes on their sessions (absent until one is added). */
  claude?: ClaudeData;
}

export class Store {
  data: OfficeData;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.data = { version: 1, desks: {}, issues: [], pm: {}, boards: {}, laidOff: {}, intern: null, managers: {}, staffLog: [], managerWatch: {} };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      this.data = { ...this.data, ...parsed };
    } catch {
      /* first run */
    }
    // Older saves: tickets had no tags/source, boards had no settings.
    this.data.issues = this.data.issues.map((i) => ({
      ...i,
      labels: Array.isArray(i.labels) ? i.labels : [],
      source: i.source ?? "local",
      external: i.external ?? null,
    }));
    for (const [pid, b] of Object.entries(this.data.boards)) {
      this.data.boards[pid] = { settings: normalizeBoardSettings(b?.settings), gitlabToken: b?.gitlabToken ?? null };
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 250);
  }

  /** Writes any pending save now (on shutdown, so the last change isn't lost). */
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
