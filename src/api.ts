// Client for the office bridge (server/bridge.ts).

import type { BoardState, OfficeSnapshot, ThreadDetail, Issue } from "../shared/types.ts";
import { demoDetail } from "./rt/demo.ts";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/** The floor (project id) you're on. Messages to the intern carry it, so "this project" means something. */
let currentFloor: string | null = null;
export function setCurrentFloor(id: string | null) {
  currentFloor = id;
}

export const api = {
  subscribe(onSnapshot: (s: OfficeSnapshot) => void, onStatus: (connected: boolean) => void) {
    let es: EventSource | null = null;
    const open = () => {
      es = new EventSource("/api/events");
      es.addEventListener("snapshot", (e) => onSnapshot(JSON.parse((e as MessageEvent).data)));
      es.onopen = () => onStatus(true);
      es.onerror = () => {
        onStatus(false);
        es?.close();
        setTimeout(open, 2000);
      };
    };
    open();
    return () => es?.close();
  },
  detail: (id: string) =>
    id.startsWith("demo-agent-") ? Promise.resolve(demoDetail(id)) : call<ThreadDetail>("GET", `/api/threads/${encodeURIComponent(id)}`),
  send: (id: string, text: string) => call("POST", `/api/threads/${encodeURIComponent(id)}/send`, { text, floorId: currentFloor }),
  archive: (id: string) => call("POST", `/api/threads/${encodeURIComponent(id)}/archive`, {}),
  layOff: (id: string, reason?: string) => call("POST", `/api/threads/${encodeURIComponent(id)}/layoff`, { by: "boss", reason }),
  stop: (id: string) => call("POST", `/api/threads/${encodeURIComponent(id)}/stop`, {}),
  settle: (id: string) => call("POST", `/api/threads/${encodeURIComponent(id)}/settle`, {}),
  visit: (id: string) => call("POST", `/api/threads/${encodeURIComponent(id)}/visit`, {}),
  respond: (id: string, body: { requestId: string; decision?: string; answers?: Record<string, unknown> }) =>
    call("POST", `/api/threads/${encodeURIComponent(id)}/respond`, body),
  hire: (body: { projectId: string; message: string; title?: string; desk?: number; model?: string; provider?: string }) =>
    call<{ threadId: string }>("POST", "/api/hire", { ...body, by: "boss" }),
  meeting: (threadIds: string[], text: string) => call<{ sent: number }>("POST", "/api/meeting", { threadIds, text }),
  addProject: (path: string, backend?: "t3" | "claude") => call("POST", "/api/projects", backend ? { path, backend } : { path }),
  recruitIntern: (body: { message?: string; model?: string; provider?: string }) =>
    call<{ threadId: string }>("POST", "/api/intern", { ...body, floorId: currentFloor }),
  ensurePm: (projectId: string) => call<{ threadId: string }>("POST", "/api/pm", { projectId }),
  ensureManager: (projectId: string) => call<{ threadId: string }>("POST", "/api/manager", { projectId }),
  createIssue: (body: { projectId: string; title: string; body?: string; labels?: string[]; status?: string }) =>
    call<Issue>("POST", "/api/issues", { ...body, createdBy: "boss" }),
  updateIssue: (id: string, body: Partial<Issue>) => call<Issue>("PATCH", `/api/issues/${encodeURIComponent(id)}`, body),
  deleteIssue: (id: string) => call("DELETE", `/api/issues/${encodeURIComponent(id)}`),
  assignIssue: (id: string, threadId: string) =>
    call<Issue & { warning?: string }>("POST", `/api/issues/${encodeURIComponent(id)}/assign`, { threadId }),
  hireForIssue: (id: string, desk?: number) =>
    call<{ warning?: string }>("POST", `/api/issues/${encodeURIComponent(id)}/hire`, { desk }),
  updateBoardSettings: (projectId: string, patch: Record<string, unknown>) =>
    call<BoardState>("PATCH", "/api/board/settings", { ...patch, projectId }),
  syncBoard: (projectId: string) => call<BoardState>("POST", "/api/board/sync", { projectId }),
  importBoardColumns: (projectId: string) => call<BoardState>("POST", "/api/board/import", { projectId }),
};
