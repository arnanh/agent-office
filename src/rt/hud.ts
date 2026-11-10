// The ray tracing switch in the top bar (⚡, or G) and its options popover (▾): lighting
// mood, denoiser, reflections, GI, debug views and live stats. The popover stays closed
// unless you open it.

import type { RayTracer } from "./renderer.ts";
import { MOODS } from "./moods.ts";

const VIEWS = ["Final", "Diffuse light", "Reflections", "Normals", "Roughness / metal"];

const CSS = `
  #hud-tl .hud-btns { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; }
  .rt-ctl { display: flex; align-items: center; background: var(--bg); box-shadow: var(--shadow); border-radius: 999px; height: 38px; padding: 0 4px 0 6px; gap: 2px; }
  .rt-ctl button { border: none; background: none; cursor: pointer; font: inherit; color: inherit; padding: 0; width: auto; }
  .rt-switch { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 6px !important; border-radius: 999px; }
  .rt-switch:hover, .rt-more:hover { background: rgba(0,0,0,.06) !important; }
  .rt-bolt { font-size: 17px; filter: grayscale(1) opacity(.6); transition: filter .2s; }
  .rt-track { position: relative; width: 30px; height: 17px; border-radius: 999px; background: #c9ccd6; transition: background .2s, box-shadow .2s; }
  .rt-knob { position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: left .2s; }
  .rt-ctl.on .rt-bolt { filter: drop-shadow(0 0 4px rgba(41,231,255,.9)); }
  .rt-ctl.on .rt-track { background: #18c8e6; box-shadow: 0 0 8px rgba(41,231,255,.7); }
  .rt-ctl.on .rt-knob { left: 15px; }
  .rt-more { width: 26px !important; height: 30px; border-radius: 999px; font-size: 12px !important; color: var(--muted) !important; }
  .rt-pop { position: absolute; z-index: 30; width: 290px; background: rgba(10, 12, 24, 0.92); color: #e9f6ff; backdrop-filter: blur(8px);
    border: 1px solid rgba(41, 231, 255, 0.4); border-radius: 14px; padding: 12px 14px; font: 500 13px/1.45 system-ui, sans-serif;
    box-shadow: 0 10px 30px rgba(0,0,0,.35), 0 0 22px rgba(41, 231, 255, 0.15); }
  .rt-pop.hidden { display: none; }
  .rt-pop h4 { margin: 0 0 2px; font-size: 13px; font-weight: 800; letter-spacing: .08em; color: #29e7ff; text-shadow: 0 0 8px rgba(41,231,255,.6); }
  .rt-pop .rt-dim { color: #9fb0c8; }
  .rt-pop .rt-sec { margin-top: 10px; }
  .rt-pop .rt-lbl { font-size: 11px; font-weight: 700; letter-spacing: .06em; color: #9fb0c8; text-transform: uppercase; margin-bottom: 4px; }
  .rt-pop .rt-seg { display: flex; gap: 4px; flex-wrap: wrap; }
  .rt-pop .rt-seg button { flex: 1; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: #e9f6ff; border-radius: 8px; padding: 5px 6px; font: 600 12px system-ui; cursor: pointer; white-space: nowrap; }
  .rt-pop .rt-seg button.sel { background: rgba(41,231,255,.22); border-color: rgba(41,231,255,.7); }
  .rt-pop label { display: flex; align-items: center; gap: 8px; cursor: pointer; margin: 3px 0; width: auto; }
  .rt-pop input[type=checkbox] { width: auto; margin: 0; padding: 0; accent-color: #29e7ff; }
  .rt-pop select { width: 100%; background: rgba(255,255,255,.08); color: #e9f6ff; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; padding: 4px 6px; }
  .rt-pop select option { color: #111; }
  .rt-pop kbd { font: 700 11px system-ui; background: rgba(255,255,255,.12); color: #e9f6ff; border-radius: 4px; padding: 0 5px; margin-right: 2px; min-width: 0; box-shadow: none; border: none; }
`;

export class RTHud {
  private rt: RayTracer;
  private ctl: HTMLElement;
  private pop: HTMLElement;
  private stats: HTMLElement;
  private timer = 0;
  private onToggle: (on: boolean) => void;

  constructor(rt: RayTracer, onToggle: (on: boolean) => void) {
    this.rt = rt;
    this.onToggle = onToggle;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    this.ctl = document.createElement("div");
    this.ctl.className = "rt-ctl";
    const sw = document.createElement("button");
    sw.className = "rt-switch";
    sw.title = "Real-time ray tracing (G): reflections, ray-traced shadows and global illumination. Needs a good GPU.";
    sw.innerHTML = `<span class="rt-bolt">⚡</span><span class="rt-track"><span class="rt-knob"></span></span>`;
    sw.addEventListener("click", () => {
      onToggle(!this.rt.enabled);
      sw.blur(); // so G and walking keys go back to the office
    });
    const more = document.createElement("button");
    more.className = "rt-more";
    more.title = "Ray tracing options";
    more.textContent = "▾";
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePopover();
      more.blur();
    });
    this.ctl.append(sw, more);
    const bar = document.querySelector("#hud-tl .hud-btns") ?? document.getElementById("hud-tl");
    bar?.append(this.ctl);

    this.pop = document.createElement("div");
    this.pop.className = "rt-pop hidden";
    this.pop.addEventListener("click", (e) => e.stopPropagation());
    this.stats = document.createElement("div");
    document.getElementById("ui")?.append(this.pop);
    document.addEventListener("click", () => this.close());
    window.addEventListener("keydown", (e) => {
      if (e.code === "Escape") this.close();
    });
    this.draw();
  }

  get open() {
    return !this.pop.classList.contains("hidden");
  }

  close() {
    this.pop.classList.add("hidden");
  }

  private togglePopover() {
    if (this.open) return this.close();
    const r = this.ctl.getBoundingClientRect();
    this.pop.style.left = `${r.left}px`;
    this.pop.style.top = `${r.bottom + 8}px`;
    this.pop.classList.remove("hidden");
    this.drawPopover();
  }

  update(dt: number) {
    this.timer += dt;
    if (this.timer < 0.5) return;
    this.timer = 0;
    if (this.open) this.drawStats();
  }

  /** Redraw after anything changes (switch, keys). */
  draw() {
    this.ctl.classList.toggle("on", this.rt.enabled);
    if (this.open) this.drawPopover();
  }

  private drawStats() {
    const s = this.rt.stats;
    this.stats.className = "rt-dim";
    this.stats.textContent = !this.rt.enabled
      ? ""
      : s.triangles
        ? `${s.fps.toFixed(0)} fps · ${s.width}×${s.height} · ${(s.triangles / 1000).toFixed(0)}k triangles · ${s.lights} lights`
        : "Building the scene for ray tracing…";
  }

  private drawPopover() {
    const rt = this.rt;
    const p = this.pop;
    p.replaceChildren();
    const el = (tag: string, cls = "", text = "") => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    p.append(el("h4", "", rt.enabled ? "⚡ RAY TRACING ON" : "⚡ RAY TRACING"));
    if (!rt.enabled) {
      p.append(
        el("div", "rt-dim", "Real-time reflections, ray-traced soft shadows from every light (status bulbs and monitors too) and a bounce of global illumination. It wants a good GPU; the original look is unchanged while it's off."),
      );
      const sec = el("div", "rt-sec");
      const on = el("button", "", "Turn it on");
      on.addEventListener("click", () => this.onToggle(true));
      const seg = el("div", "rt-seg");
      seg.append(on);
      sec.append(seg);
      p.append(sec, el("div", "rt-sec rt-dim", "Shortcut: G"));
      return;
    }
    this.drawStats();
    p.append(this.stats);

    const moods = el("div", "rt-sec");
    moods.append(el("div", "rt-lbl", "Lighting"));
    const seg = el("div", "rt-seg");
    MOODS.forEach((m, i) => {
      const b = el("button", i === rt.moodIndex ? "sel" : "", m.name);
      b.title = i === 0 ? "Follows the real time of day" : "";
      b.addEventListener("click", () => {
        rt.moodIndex = i;
        this.drawPopover();
      });
      seg.append(b);
    });
    moods.append(seg);
    p.append(moods);

    const toggles = el("div", "rt-sec");
    toggles.append(el("div", "rt-lbl", "Passes"));
    const check = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const l = el("label");
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = get();
      c.addEventListener("change", () => set(c.checked));
      l.append(c, document.createTextNode(label));
      toggles.append(l);
    };
    check("Reflections", () => rt.specular, (v) => (rt.specular = v));
    check("Global illumination (one bounce)", () => rt.gi, (v) => (rt.gi = v));
    check("Denoiser", () => rt.denoise, (v) => (rt.denoise = v));
    p.append(toggles);

    const view = el("div", "rt-sec");
    view.append(el("div", "rt-lbl", "Debug view"));
    const sel = document.createElement("select");
    VIEWS.forEach((v, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = v;
      o.selected = i === rt.view;
      sel.append(o);
    });
    sel.addEventListener("change", () => (rt.view = Number(sel.value)));
    view.append(sel);
    p.append(view);

    const keys = el("div", "rt-sec rt-dim");
    keys.innerHTML = `<kbd>G</kbd> on/off · <kbd>L</kbd> lighting · <kbd>X</kbd> debug view · <kbd>N</kbd> denoiser`;
    p.append(keys);
  }
}
