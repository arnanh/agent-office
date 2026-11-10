// Side panel for talking to one agent: their live activity feed, any pending
// question/approval, a message box, and desk actions (done, stop, lay off).

import type { ActivityItem, AgentInfo, PendingRequest, ThreadDetail } from "../../shared/types.ts";
import { api } from "../api.ts";
import { h, renderMarkdown, timeAgo, toast } from "./dom.ts";

export interface PanelHost {
  getAgent(id: string): AgentInfo | undefined;
  nameOf(id: string): string;
  colorOf(id: string): string;
  layOff(id: string): void;
  onClose(): void;
}

export const ACTIVITY_TEXT: Record<string, string> = {
  working: "Working",
  "needs-input": "Needs you",
  done: "Done, waiting for review",
  error: "Hit an error",
  idle: "Idle",
};

export class AgentPanel {
  readonly el: HTMLElement;
  agentId: string | null = null;
  private feed: HTMLElement;
  private pendingBox: HTMLElement;
  private header: HTMLElement;
  private actions: HTMLElement;
  private input: HTMLTextAreaElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKey = "";
  private lastPendingId = "";
  private sending = false;

  private host: PanelHost;

  constructor(host: PanelHost) {
    this.host = host;
    this.header = h("header", { class: "panel-head" });
    this.pendingBox = h("div", { class: "pending" });
    this.feed = h("div", { class: "feed" });
    this.input = h("textarea", {
      placeholder: "Message this agent… (Enter to send, Shift+Enter for a new line)",
      rows: 2,
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void this.send();
        }
        if (e.key === "Escape") this.input.blur();
        e.stopPropagation();
      },
    });
    this.actions = h("div", { class: "panel-actions" });
    this.el = h(
      "aside",
      { class: "panel hidden" },
      this.header,
      this.pendingBox,
      this.feed,
      h("div", { class: "composer" }, this.input, h("button", { class: "btn primary", onclick: () => this.send() }, "Send")),
      this.actions,
    );
  }

  get isOpen() {
    return this.agentId !== null;
  }

  open(agentId: string) {
    this.agentId = agentId;
    this.lastKey = "";
    this.lastPendingId = "";
    this.feed.replaceChildren(h("div", { class: "muted pad" }, "Pulling up their screen…"));
    this.pendingBox.replaceChildren();
    this.el.classList.remove("hidden");
    this.renderHeader();
    const agent = this.host.getAgent(agentId);
    if (agent && (agent.activity === "done" || agent.activity === "error")) {
      api.visit(agentId).catch(() => {});
    }
    void this.refresh();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.refresh(), 2000);
    setTimeout(() => this.input.focus(), 50);
  }

  close() {
    if (!this.agentId) return;
    this.agentId = null;
    this.el.classList.add("hidden");
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.input.blur();
    this.host.onClose();
  }

  /** Called on every office snapshot. */
  sync() {
    if (!this.agentId) return;
    if (!this.host.getAgent(this.agentId)) {
      this.close();
      return;
    }
    this.renderHeader();
  }

  private renderHeader() {
    const agent = this.agentId ? this.host.getAgent(this.agentId) : undefined;
    if (!agent) return;
    const name = this.host.nameOf(agent.id);
    this.header.replaceChildren(
      h("div", { class: "avatar", style: `background:${this.host.colorOf(agent.id)}` }, name.replace(/^(PM|Intern) /, "")[0]),
      h(
        "div",
        { class: "who" },
        h("div", { class: "name" }, name, agent.isManager ? h("span", { class: "tag" }, "Floor manager") : agent.isPm ? h("span", { class: "tag" }, "Board PM") : agent.isIntern ? h("span", { class: "tag" }, "Intern") : null),
        h("div", { class: "title", title: agent.title }, agent.title),
        h(
          "div",
          { class: "meta" },
          h("span", { class: `pill ${agent.activity}` }, ACTIVITY_TEXT[agent.activity] ?? agent.activity),
          h("span", { class: "muted" }, [agent.model, timeAgo(agent.updatedAt)].filter(Boolean).join(" · ")),
        ),
      ),
      h("button", { class: "icon-btn", title: "Close (Esc)", onclick: () => this.close() }, "×"),
    );
    const actionButtons: (HTMLElement | null)[] = [
      agent.activity === "working"
        ? h("button", { class: "btn", onclick: () => this.act("stop", () => api.stop(agent.id), "Asked them to stop.") }, "⏹ Stop")
        : null,
      agent.activity === "done" || agent.activity === "error" || agent.activity === "idle"
        ? h("button", { class: "btn", onclick: () => this.act("settle", () => api.settle(agent.id), "Marked as done.") }, "✓ Mark done")
        : null,
      agent.link ? h("a", { class: "btn", href: agent.link, target: "_blank", rel: "noreferrer" }, "↗ Open in T3") : null,
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn danger",
          onclick: () => {
            const fate =
              agent.backend === "claude"
                ? `Their Claude Code session "${agent.title}" leaves the office (its transcript stays in Claude Code).`
                : `Their thread "${agent.title}" will be settled in T3 Code (not archived). Un-settle it there to bring them back.`;
            if (confirm(`Lay off ${this.host.nameOf(agent.id)}? ${fate}`)) {
              this.host.layOff(agent.id);
              this.close();
            }
          },
        },
        "📦 Lay off",
      ),
    ];
    this.actions.replaceChildren(...actionButtons.filter((x): x is HTMLElement => x !== null));
  }

  private async act(_name: string, fn: () => Promise<unknown>, okMsg: string) {
    try {
      await fn();
      toast(okMsg, "good");
    } catch (e) {
      toast(`Couldn't do that: ${(e as Error).message}`, "bad");
    }
  }

  private async send() {
    const text = this.input.value.trim();
    if (!text || !this.agentId || this.sending) return;
    this.sending = true;
    const id = this.agentId;
    this.input.value = "";
    this.appendOptimistic(text);
    try {
      await api.send(id, text);
    } catch (e) {
      toast(`Message failed: ${(e as Error).message}`, "bad");
      this.input.value = text;
    } finally {
      this.sending = false;
    }
  }

  private appendOptimistic(text: string) {
    this.feed.append(h("div", { class: "msg user pending-send" }, h("div", { class: "bubble" }, text)));
    this.feed.scrollTop = this.feed.scrollHeight;
  }

  private async refresh() {
    const id = this.agentId;
    if (!id) return;
    let detail: ThreadDetail;
    try {
      detail = await api.detail(id);
    } catch (e) {
      if (this.agentId === id && !this.lastKey) {
        this.feed.replaceChildren(h("div", { class: "muted pad" }, `Couldn't load: ${(e as Error).message}`));
      }
      return;
    }
    if (this.agentId !== id) return;
    const key = `${detail.items.length}|${detail.items.at(-1)?.id}|${detail.items.at(-1)?.text.length}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      const atBottom = this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 80;
      this.renderFeed(detail.items);
      if (atBottom || !this.feed.dataset.init) this.feed.scrollTop = this.feed.scrollHeight;
      this.feed.dataset.init = "1";
    }
    const pid = detail.pending?.requestId ?? "";
    if (pid !== this.lastPendingId) {
      this.lastPendingId = pid;
      this.renderPending(detail.pending);
    }
  }

  private renderFeed(items: ActivityItem[]) {
    const nodes: HTMLElement[] = [];
    let toolRun: HTMLElement | null = null;
    for (const item of items) {
      if (item.type === "user" || item.type === "assistant") {
        toolRun = null;
        nodes.push(
          h(
            "div",
            { class: `msg ${item.type}` },
            h("div", { class: "bubble" }, item.type === "assistant" ? renderMarkdown(item.text) : item.text),
          ),
        );
        continue;
      }
      if (!toolRun) {
        toolRun = h("div", { class: "tools" });
        nodes.push(toolRun);
      }
      toolRun.append(toolLine(item));
    }
    if (!nodes.length) nodes.push(h("div", { class: "muted pad" }, "Nothing on their screen yet."));
    this.feed.replaceChildren(...nodes);
  }

  private renderPending(p: PendingRequest | null) {
    if (!p || !this.agentId) {
      this.pendingBox.replaceChildren();
      return;
    }
    this.pendingBox.replaceChildren(pendingCard(this.agentId, p, () => this.pendingBox.replaceChildren()));
  }
}

/** A question or approval card the agent is waiting on, answerable inline. */
export function pendingCard(id: string, p: PendingRequest, onResolved: () => void): HTMLElement {
  const box = h("div", { class: "pending-card" });
  if (p.questions.length) {
    box.append(h("div", { class: "pending-title" }, "🙋 They have a question"));
    const answers: Record<string, string | string[]> = {};
    for (const q of p.questions) {
      const opts = h("div", { class: "options" });
      const custom = h("input", { placeholder: "Or type your own answer…" });
      for (const o of q.options) {
        const b = h(
          "button",
          {
            class: "opt",
            title: o.description,
            onclick: () => {
              if (q.multiSelect) {
                const cur = new Set((answers[q.id] as string[] | undefined) ?? []);
                cur.has(o.label) ? cur.delete(o.label) : cur.add(o.label);
                answers[q.id] = [...cur];
                b.classList.toggle("on");
              } else {
                answers[q.id] = o.label;
                opts.querySelectorAll(".opt").forEach((x) => x.classList.remove("on"));
                b.classList.add("on");
              }
            },
          },
          h("strong", {}, o.label),
          o.description ? h("span", {}, o.description) : null,
        );
        opts.append(b);
      }
      custom.addEventListener("input", () => {
        if (custom.value.trim()) answers[q.id] = custom.value.trim();
      });
      custom.addEventListener("keydown", (e) => e.stopPropagation());
      box.append(h("div", { class: "question" }, h("div", { class: "q" }, q.header ? h("span", { class: "tag" }, q.header) : null, q.question), opts, custom));
    }
    box.append(
      h(
        "button",
        {
          class: "btn primary",
          onclick: async () => {
            try {
              await api.respond(id, { requestId: p.requestId, answers });
              toast("Answer sent!", "good");
              onResolved();
            } catch (e) {
              toast(`Couldn't answer: ${(e as Error).message}. You can reply in the message box instead.`, "bad");
            }
          },
        },
        "Send answer",
      ),
    );
  } else {
    box.append(h("div", { class: "pending-title" }, `✋ Needs approval (${p.kind})`));
    if (p.prompt) box.append(h("pre", { class: "approval" }, p.prompt));
    if (p.reason) box.append(h("div", { class: "muted" }, p.reason));
    const options = p.options.length
      ? p.options
      : [
          { decision: "accept", label: "Approve" },
          { decision: "acceptForSession", label: "Approve for session" },
          { decision: "decline", label: "Decline" },
        ];
    box.append(
      h(
        "div",
        { class: "row" },
        options.map((o) =>
          h(
            "button",
            {
              class: `btn ${o.decision.startsWith("accept") ? "primary" : "danger"}`,
              onclick: async () => {
                try {
                  await api.respond(id, { requestId: p.requestId, decision: o.decision });
                  toast(`${o.label} ✓`, "good");
                  onResolved();
                } catch (e) {
                  toast(`Couldn't respond: ${(e as Error).message}`, "bad");
                }
              },
            },
            o.label,
          ),
        ),
      ),
    );
  }
  return box;
}

export function toolLine(item: ActivityItem) {
  const icons: Record<string, string> = {
    command: "$",
    thinking: "💭",
    file: "✎",
    search: "⌕",
    web: "🌐",
    todo: "☑",
    plan: "🗺",
    question: "🙋",
    approval: "✋",
    error: "⚠",
    notice: "ℹ",
  };
  const text = item.type === "thinking" ? item.text.trim() : item.text;
  const el = h(
    "div",
    { class: `tool ${item.type}` },
    h("span", { class: "ic" }, icons[item.type] ?? "·"),
    h("span", { class: "tx" }, text || item.title || item.type),
  );
  el.addEventListener("click", () => el.classList.toggle("expanded"));
  return el;
}
