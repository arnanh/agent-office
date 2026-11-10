// Office Chat: a Teams-style phone docked in the corner. It stays open while you walk
// (it never grabs the mouse or blocks WASD), so you can message any agent on any floor
// without going to their desk. Keyboard: T show/hide · Enter type · [ ] switch chats.

import type { ActivityItem, AgentInfo, PendingRequest, ThreadDetail } from "../../shared/types.ts";
import { api } from "../api.ts";
import { h, renderMarkdown, toast } from "./dom.ts";
import { ACTIVITY_TEXT, pendingCard, toolLine } from "./panel.ts";

export interface ChatHost {
  agents(): AgentInfo[];
  nameOf(id: string): string;
  colorOf(id: string): string;
  /** e.g. "12F agent-office" */
  floorLabel(projectId: string): string;
  /** Walk over to the agent's desk (switching floors if needed). */
  walkTo(id: string): void;
  /** Called after sending from the keyboard, to drop back into walking. */
  resume(): void;
}

const PRIORITY: Record<string, number> = { "needs-input": 0, error: 1, done: 2, working: 4, idle: 5 };
const SEEN_KEY = "office.chat.seen";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export class OfficeChat {
  readonly el: HTMLElement;
  private host: ChatHost;
  private isOpen = load("office.chat.open", false);
  private selected: string | null = load<string | null>("office.chat.selected", null);
  /** updatedAt of each agent's latest reply you've seen in the chat. */
  private seen: Record<string, string> = load(SEEN_KEY, {});
  private seenInitialized = localStorage.getItem(SEEN_KEY) !== null;
  private drafts = new Map<string, string>();
  private visited = new Map<string, string>();
  private openSteps = new Set<string>();
  private unreadCount = 0;

  private launcher: HTMLButtonElement;
  private badge: HTMLElement;
  private phone: HTMLElement;
  private rail: HTMLElement;
  private convHead: HTMLElement;
  private pendingBox: HTMLElement;
  private feed: HTMLElement;
  private typingEl: HTMLElement;
  private input: HTMLTextAreaElement;
  private conv: HTMLElement;
  private empty: HTMLElement;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKey = "";
  private lastPendingId = "";
  private lastUpdatedAt = "";
  /** Messages sent but not yet in the thread, with how many of your messages the thread had at the time. */
  private optimistic: { text: string; base: number }[] = [];
  private userCount = 0;
  private sending = false;
  private returnToWalk = false;

  constructor(host: ChatHost) {
    this.host = host;
    this.badge = h("span", { class: "chat-badge hidden" });
    this.launcher = h(
      "button",
      { class: "chat-launcher", title: "Office Chat (T)", onclick: () => this.toggle() },
      h("span", { class: "chat-launcher-ic" }, "💬"),
      h("span", {}, "Chat"),
      h("kbd", {}, "T"),
      this.badge,
    );

    this.rail = h("nav", { class: "chat-rail" });
    this.convHead = h("header", { class: "chat-conv-head" });
    this.pendingBox = h("div", { class: "pending chat-pending" });
    this.feed = h("div", { class: "chat-feed" });
    this.typingEl = h("div", { class: "chat-typing" });
    this.input = h("textarea", {
      rows: 1,
      placeholder: "Type a message",
      onkeydown: (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void this.send();
          // Started typing from walking (Enter)? Then sending drops you straight back into it.
          if (this.returnToWalk) {
            this.input.blur();
            this.host.resume();
          }
        } else if (e.key === "Escape") {
          this.input.blur();
        }
      },
      oninput: () => this.autosize(),
      onblur: () => (this.returnToWalk = false),
    });
    this.conv = h(
      "section",
      { class: "chat-conv" },
      this.convHead,
      this.pendingBox,
      this.feed,
      this.typingEl,
      h(
        "div",
        { class: "chat-composer" },
        this.input,
        h("button", { class: "chat-send", title: "Send (Enter)", onclick: () => void this.send() }, "➤"),
      ),
    );
    this.empty = h(
      "section",
      { class: "chat-conv chat-empty" },
      h("div", { class: "chat-empty-ic" }, "🫧"),
      h("div", {}, "No agents yet."),
      h("div", { class: "muted" }, "Hire one at an empty desk and they'll show up here."),
    );

    this.phone = h(
      "div",
      { class: "chat-phone" },
      h(
        "header",
        { class: "chat-top" },
        h("span", { class: "chat-brand" }, "💬 Office Chat"),
        h("span", { class: "chat-keys" }, h("kbd", {}, "Enter"), " type ", h("kbd", {}, "["), h("kbd", {}, "]"), " switch"),
        h("button", { class: "icon-btn", title: "Hide (T)", onclick: () => this.toggle(false) }, "–"),
      ),
      h("div", { class: "chat-body" }, this.rail, this.conv, this.empty),
    );

    this.el = h("aside", { class: "chat" }, this.launcher, this.phone);
    this.applyOpen();

    // Keep the phone clear of the "needs you" list in the top-right corner.
    const attention = document.getElementById("attention");
    if (attention) {
      const fit = () => this.el.style.setProperty("--chat-top", `${attention.getBoundingClientRect().bottom + 12}px`);
      new ResizeObserver(fit).observe(attention);
      window.addEventListener("resize", fit);
      fit();
    }
  }

  /** True while you're typing in the chat (walking pauses, but the mouse stays captured). */
  get typing() {
    return document.activeElement === this.input;
  }

  toggle(open = !this.isOpen) {
    this.isOpen = open;
    save("office.chat.open", open);
    if (!open && this.typing) this.input.blur();
    this.applyOpen();
    this.sync();
  }

  /** Open the chat and put the cursor in the message box. */
  focusComposer() {
    if (!this.isOpen) this.toggle(true);
    if (!this.selected) return;
    setTimeout(() => {
      this.input.focus();
      this.returnToWalk = true;
    }, 0);
  }

  /** Switch to the previous/next conversation in the list. */
  cycle(step: number) {
    if (!this.isOpen) return this.toggle(true);
    const list = this.sorted();
    if (!list.length) return;
    const i = list.findIndex((a) => a.id === this.selected);
    const next = list[(i + step + list.length) % list.length];
    this.select(next.id);
  }

  /** Open the chat on a particular agent. */
  openWith(id: string) {
    if (!this.isOpen) this.toggle(true);
    this.select(id);
  }

  /** Called on every office snapshot. */
  sync() {
    const agents = this.host.agents();
    if (!this.seenInitialized && agents.length) {
      // First run: don't flood the badge with everything that happened before you installed the app.
      for (const a of agents) this.seen[a.id] = a.updatedAt;
      this.seenInitialized = true;
      save(SEEN_KEY, this.seen);
    }
    if (this.selected && !agents.some((a) => a.id === this.selected)) this.selected = null;
    if (!this.selected && agents.length) this.selected = this.sorted()[0].id;

    const current = this.selected ? agents.find((a) => a.id === this.selected) : undefined;
    if (current && this.visible) this.markRead(current);

    const unread = agents.filter((a) => this.isUnread(a)).length;
    if (unread > this.unreadCount && !this.isOpen) {
      this.launcher.classList.remove("ping");
      void this.launcher.offsetWidth;
      this.launcher.classList.add("ping");
    }
    this.unreadCount = unread;
    this.badge.textContent = String(unread);
    this.badge.classList.toggle("hidden", unread === 0);

    if (!this.isOpen) return;
    this.renderRail();
    this.renderHead();
    this.empty.classList.toggle("hidden", !!current);
    this.conv.classList.toggle("hidden", !current);
    if (current && current.updatedAt !== this.lastUpdatedAt) {
      this.lastUpdatedAt = current.updatedAt;
      void this.refresh();
    }
  }

  private get visible() {
    return this.isOpen && !this.el.matches(".panel:not(.hidden) ~ .chat");
  }

  private applyOpen() {
    this.el.classList.toggle("open", this.isOpen);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.isOpen) {
      this.timer = setInterval(() => void this.refresh(), 2000);
      this.resetConversation();
    }
  }

  private select(id: string) {
    if (id === this.selected) return;
    if (this.selected) this.drafts.set(this.selected, this.input.value);
    this.selected = id;
    save("office.chat.selected", id);
    this.input.value = this.drafts.get(id) ?? "";
    this.autosize();
    this.resetConversation();
    this.sync();
    // Keep the chosen avatar in view in the rail.
    this.rail.querySelector(".chat-rail-item.on")?.scrollIntoView({ block: "nearest" });
  }

  private resetConversation() {
    this.lastKey = "";
    this.lastPendingId = "";
    this.lastUpdatedAt = "";
    this.optimistic = [];
    this.userCount = 0;
    delete this.feed.dataset.init;
    this.feed.replaceChildren(h("div", { class: "chat-note" }, "Loading…"));
    this.pendingBox.replaceChildren();
    this.typingEl.replaceChildren();
  }

  private sorted() {
    const rank = (a: AgentInfo) => (this.isUnread(a) && a.activity === "idle" ? 3 : PRIORITY[a.activity] ?? 5);
    return [...this.host.agents()].sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  private isUnread(a: AgentInfo) {
    if (a.activity === "needs-input" || a.activity === "error" || a.activity === "done") return true;
    return a.activity !== "working" && a.lastMessageRole === "assistant" && a.updatedAt > (this.seen[a.id] ?? "");
  }

  private markRead(a: AgentInfo) {
    if (a.activity !== "working" && this.seen[a.id] !== a.updatedAt) {
      this.seen[a.id] = a.updatedAt;
      save(SEEN_KEY, this.seen);
    }
    // Reading a finished reply counts as visiting their desk (clears the green "done" flag).
    if ((a.activity === "done" || a.activity === "error") && this.visited.get(a.id) !== a.updatedAt) {
      this.visited.set(a.id, a.updatedAt);
      api.visit(a.id).catch(() => {});
    }
  }

  private avatar(a: AgentInfo, size: "sm" | "md") {
    const name = this.host.nameOf(a.id);
    return h(
      "span",
      { class: `chat-avatar ${size}`, style: `background:${this.host.colorOf(a.id)}` },
      name.replace(/^(PM|Manager|Intern) /, "")[0] ?? "?",
      h("span", { class: `chat-presence ${a.activity}` }),
    );
  }

  private renderRail() {
    const list = this.sorted();
    this.rail.replaceChildren(
      ...list.map((a) => {
        const name = this.host.nameOf(a.id);
        const unread = this.isUnread(a) && a.id !== this.selected;
        return h(
          "button",
          {
            class: `chat-rail-item ${a.id === this.selected ? "on" : ""} ${unread ? "unread" : ""} ${a.activity}`,
            title: `${name} · ${this.where(a)}\n${a.title}\n${ACTIVITY_TEXT[a.activity] ?? a.activity}`,
            onclick: () => this.select(a.id),
          },
          this.avatar(a, "md"),
          unread ? h("span", { class: "chat-dot" }, a.activity === "needs-input" ? "!" : "") : null,
          h("span", { class: "chat-rail-name" }, name),
        );
      }),
    );
  }

  private renderHead() {
    const a = this.selected ? this.host.agents().find((x) => x.id === this.selected) : undefined;
    if (!a) return;
    const name = this.host.nameOf(a.id);
    this.convHead.replaceChildren(
      this.avatar(a, "sm"),
      h(
        "div",
        { class: "chat-who" },
        h("div", { class: "chat-name" }, name, a.isManager ? h("span", { class: "tag" }, "Manager") : a.isPm ? h("span", { class: "tag" }, "PM") : a.isIntern ? h("span", { class: "tag" }, "Intern") : null),
        h(
          "div",
          { class: "chat-sub" },
          h("span", { class: `pill ${a.activity}` }, ACTIVITY_TEXT[a.activity] ?? a.activity),
          h("span", { class: "chat-floor" }, this.where(a)),
        ),
        h("div", { class: "chat-title", title: a.title }, a.title),
      ),
      h("button", { class: "icon-btn", title: a.isIntern ? "Call them over" : "Walk over to their desk", onclick: () => this.host.walkTo(a.id) }, a.isIntern ? "👋" : "🚶"),
      ...(a.link ? [h("a", { class: "icon-btn", title: "Open in T3 Code", href: a.link, target: "_blank", rel: "noreferrer" }, "↗")] : []),
    );
    const name1 = name.replace(/^(PM|Manager|Intern) /, "");
    this.input.placeholder = `Message ${name1}`;
    this.typingEl.replaceChildren(
      ...(a.activity === "working" ? [h("span", { class: "chat-dots" }, h("i"), h("i"), h("i")), ` ${name1} is working…`] : []),
    );
  }

  /** Which floor someone's on. The intern has no floor: they're wherever you are. */
  private where(a: AgentInfo) {
    return a.isIntern ? "follows you around" : this.host.floorLabel(a.projectId);
  }

  private autosize() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`;
  }

  private async send() {
    const id = this.selected;
    const text = this.input.value.trim();
    if (!text || !id || this.sending) return;
    this.sending = true;
    this.input.value = "";
    this.drafts.delete(id);
    this.autosize();
    this.optimistic.push({ text, base: this.userCount + this.optimistic.length });
    this.feed.append(this.userBubble(text, true));
    this.feed.scrollTop = this.feed.scrollHeight;
    try {
      await api.send(id, text);
    } catch (e) {
      toast(`Message to ${this.host.nameOf(id)} failed: ${(e as Error).message}`, "bad");
      this.optimistic = this.optimistic.filter((o) => o.text !== text);
      if (this.selected === id && !this.input.value) this.input.value = text;
      this.lastKey = "";
      void this.refresh();
    } finally {
      this.sending = false;
    }
  }

  private async refresh() {
    const id = this.selected;
    if (!id || !this.visible) return;
    let detail: ThreadDetail;
    try {
      detail = await api.detail(id);
    } catch (e) {
      if (this.selected === id && !this.lastKey) this.feed.replaceChildren(h("div", { class: "chat-note" }, `Couldn't load: ${(e as Error).message}`));
      return;
    }
    if (this.selected !== id) return;
    // Drop optimistic bubbles once the real message shows up.
    const mine = detail.items.filter((i) => i.type === "user");
    const sent = new Set(mine.map((i) => i.text.trim()));
    this.userCount = mine.length;
    this.optimistic = this.optimistic.filter((o) => !sent.has(o.text) && mine.length <= o.base);
    const last = detail.items.at(-1);
    const key = `${detail.items.length}|${last?.id}|${last?.text.length}|${this.optimistic.length}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      const atBottom = this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 80;
      this.renderFeed(id, detail.items);
      if (atBottom || !this.feed.dataset.init) this.feed.scrollTop = this.feed.scrollHeight;
      this.feed.dataset.init = "1";
    }
    const pid = detail.pending?.requestId ?? "";
    if (pid !== this.lastPendingId) {
      this.lastPendingId = pid;
      this.renderPending(id, detail.pending);
    }
  }

  private renderPending(id: string, p: PendingRequest | null) {
    this.pendingBox.replaceChildren(...(p ? [pendingCard(id, p, () => this.pendingBox.replaceChildren())] : []));
  }

  private userBubble(text: string, pending = false) {
    return h("div", { class: `chat-msg me ${pending ? "sending" : ""}` }, h("div", { class: "chat-bubble" }, text));
  }

  private renderFeed(id: string, items: ActivityItem[]) {
    const name = this.host.nameOf(id);
    const color = this.host.colorOf(id);
    const nodes: HTMLElement[] = [];
    let steps: ActivityItem[] = [];
    let lastDay = "";
    const flushSteps = () => {
      if (!steps.length) return;
      const run = steps;
      steps = [];
      const key = run[0].id;
      const list = h("div", { class: "chat-steps-list" }, run.map(toolLine));
      const box = h(
        "div",
        { class: `chat-steps ${this.openSteps.has(key) ? "open" : ""}` },
        h(
          "button",
          {
            class: "chat-steps-sum",
            onclick: () => {
              box.classList.toggle("open");
              if (box.classList.contains("open")) this.openSteps.add(key);
              else this.openSteps.delete(key);
            },
          },
          h("span", {}, `⚙ ${run.length} step${run.length === 1 ? "" : "s"}`),
          h("span", { class: "chat-steps-last" }, (run.at(-1)!.text || run.at(-1)!.title || "").split("\n")[0]),
        ),
        list,
      );
      nodes.push(box);
    };
    for (const item of items) {
      const day = item.at ? new Date(item.at).toDateString() : "";
      if (day && day !== lastDay && (item.type === "user" || item.type === "assistant")) {
        flushSteps();
        lastDay = day;
        nodes.push(h("div", { class: "chat-day" }, day === new Date().toDateString() ? "Today" : new Date(item.at!).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })));
      }
      if (item.type === "user") {
        flushSteps();
        nodes.push(this.userBubble(item.text));
      } else if (item.type === "assistant") {
        flushSteps();
        if (!item.text.trim()) continue;
        nodes.push(
          h(
            "div",
            { class: "chat-msg them" },
            h(
              "div",
              { class: "chat-meta" },
              h("strong", { style: `color:${color}` }, name),
              item.at ? h("span", { title: new Date(item.at).toLocaleString() }, new Date(item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) : null,
            ),
            h("div", { class: "chat-bubble" }, renderMarkdown(item.text)),
          ),
        );
      } else {
        steps.push(item);
      }
    }
    flushSteps();
    for (const o of this.optimistic) nodes.push(this.userBubble(o.text, true));
    const where = this.host.agents().find((x) => x.id === id)?.backend === "claude" ? "Claude Code session" : "T3 Code thread";
    if (!nodes.length) nodes.push(h("div", { class: "chat-note" }, `Say hi to ${name}. Messages go straight to their ${where}.`));
    this.feed.replaceChildren(...nodes);
  }
}

