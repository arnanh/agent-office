import "./style.css";
import * as THREE from "three";
import { MANAGER_DESK, PM_DESK, type ActivityItem, type AgentInfo, type OfficeSnapshot, type ProjectInfo } from "../shared/types.ts";
import { api, setCurrentFloor } from "./api.ts";
import { Bloop, ACTIVITY_COLORS, bloopColor, bloopName } from "./world/bloop.ts";
import { BOARD, DESKS, ELEVATOR, HANGOUTS, MEETING, MEETING_SEATS, PLAYER_START, PLAYER_START_YAW, MANAGER_SLOT, PM_SLOT, STAFF, type Seat } from "./world/layout.ts";
import { NavGrid } from "./world/nav.ts";
import { OFFICE_ASSETS, THEMES, accentMaterial, buildOffice, type Office } from "./world/office.ts";
import { AssetLibrary } from "./world/assets.ts";
import { buildCity } from "./world/city.ts";
import { DayNight } from "./world/daynight.ts";
import { FLOOR_TO_FLOOR } from "./world/floorplan.ts";
import { Player, isTyping } from "./world/player.ts";
import { drawBoard, drawEmptyMonitor, drawMonitor, drawNameplate, drawRoster, drawSign } from "./world/screens.ts";
import { hashString } from "./world/toon.ts";
import { closeModal, h, modalOpen, onModalClosed, openModal, timeAgo, toast } from "./ui/dom.ts";
import { AgentPanel } from "./ui/panel.ts";
import { IssueBoardModal } from "./ui/board.ts";
import { StaffModal } from "./ui/staff.ts";
import { defaultBoardSettings } from "../shared/board.ts";
import { OfficeChat } from "./ui/chat.ts";
import { InternFollower } from "./world/intern.ts";
import { RayTracer } from "./rt/renderer.ts";
import { RTHud } from "./rt/hud.ts";
import { addRaytracedDecor } from "./rt/decor.ts";
import { DemoOffice } from "./rt/demo.ts";

// ------------------------------------------------------------------ setup

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const ui = document.getElementById("ui")!;
const bubbleLayer = document.getElementById("bubbles")!;
const promptEl = document.getElementById("prompt")!;
const attentionEl = document.getElementById("attention")!;
const floorBadge = document.getElementById("floor-badge")!;
const connEl = document.getElementById("conn")!;
const fadeEl = document.getElementById("fade")!;
const bannerEl = document.getElementById("banner")!;
const crosshairEl = document.getElementById("crosshair")!;
const enterEl = document.getElementById("enter")!;
let enteredOnce = false;
enterEl.addEventListener("click", () => {
  enteredOnce = true;
  player.lock();
});
/** After a panel or dialog closes (from a click or key press), jump straight back into first person. */
function resumeLook() {
  setTimeout(() => {
    if (!modalOpen() && !panel.isOpen && (!isTyping() || chat.typing)) player.lock();
  }, 0);
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
// Downtown outside the windows (src/world/city.ts).
const city = buildCity();
scene.add(city.group);
scene.fog = city.fog;
scene.background = city.background;
const camera = new THREE.PerspectiveCamera(62, 1, 0.08, city.cameraFar);

// Indoor lighting: soft sky/bounce fill plus a high "ceiling" key light for gentle contact shadows.
const hemi = new THREE.HemisphereLight("#ffffff", "#d8ccb4", 1.55);
const ambient = new THREE.AmbientLight("#fff6e8", 0.35);
scene.add(hemi, ambient);
const sun = new THREE.DirectionalLight("#fff6e6", 1.35);
sun.position.set(6, 30, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -21, right: 21, top: 16, bottom: -16, near: 1, far: 60 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun);
// Sky, city lights and office lighting follow the real local time (src/world/daynight.ts).
// Console: dayNight.setTime("21:30") to preview, setTime(null) to go back to live.
const dayNight = new DayNight(city, { hemi, ambient, key: sun });
(window as unknown as Record<string, unknown>).dayNight = dayNight;

// Blender-made models (public/models). Anything missing falls back to built-in primitives.
const assetLib = new AssetLibrary(accentMaterial);
await assetLib.preload(OFFICE_ASSETS);
const office: Office = buildOffice(assetLib);
const rtDecor = addRaytracedDecor(office); // neon and a chrome sculpture, before the nav grid reads the colliders
scene.add(office.root);
const nav = new NavGrid(office.colliders);
prepareSeats();
const player = new Player(canvas);
scene.add(player.bloop.root);
player.teleport(PLAYER_START, PLAYER_START_YAW);
player.inputEnabled = () => !modalOpen();
// The boss's intern follows you around, floor to floor (src/world/intern.ts).
const intern = new InternFollower({ scene, nav, player, elevator: ELEVATOR });
/** Set when you've just recruited an intern, so they arrive from the elevator. */
let internRecruiting = 0;
player.onLockError = () => {
  // Chrome refuses a re-capture for about a second after Esc; the click-to-play overlay covers that.
};

// Optional hybrid real-time ray tracing (src/rt). Off unless you tick it (or press G); the
// original look is untouched while it's off, and nothing is built for it until it's first on.
const rt = new RayTracer({
  renderer,
  scene,
  camera,
  cityGroup: city.group,
  officeRoot: office.root,
  sky: () => ({
    sunDir: dayNight.env.sunDir,
    sunElevation: dayNight.sunElevation,
    moonDir: dayNight.env.moonDir,
    moon: dayNight.env.moon,
    night: dayNight.env.night,
  }),
  bloops: () => {
    const list = [...bloops.values(), ...leaving, player.bloop];
    return list.map((b) => ({ root: b.root, probe: (out) => b.rtProbe(out) }));
  },
  movingChairs: () => office.chairs?.moving() ?? [],
  bakeKey: () => `${floorId}|${player.view}`,
});
const rtHud = new RTHud(rt, (on) => setRayTracing(on));
function setRayTracing(on: boolean, remember = true) {
  rt.enabled = on;
  rtDecor.setVisible(on);
  if (remember) {
    try {
      localStorage.setItem("office.rt", on ? "1" : "0");
    } catch {
      // private mode: just don't remember
    }
  }
  rtHud.draw();
}
{
  const q = new URLSearchParams(location.search).get("rt");
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("office.rt");
  } catch {
    // ignore
  }
  setRayTracing(q !== null ? q !== "0" : saved === "1", false);
}
(window as unknown as Record<string, unknown>).rt = rt;

function resize() {
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  renderer.setSize(w, hgt, false);
  camera.aspect = w / hgt;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// ------------------------------------------------------------------ state

let snapshot: OfficeSnapshot = { connected: false, error: null, projects: [], agents: [], issues: [], pm: {}, managers: {}, staffLog: [], boards: {}, bridgeUrl: "" };
let firstSnapshot = true;
let floorId: string | null = null;
const bloops = new Map<string, Bloop>(); // agents on the current floor
const bloopDesk = new Map<string, number>();
const leaving = new Set<Bloop>();
const layingOff = new Set<string>();
const details = new Map<string, { items: ActivityItem[]; updatedAt: string; fetchedAt: number }>();
const pendingHires = new Map<number, number>(); // desk -> started at (ms)
const prevActivity = new Map<string, string>();
const breakTimers = new Map<string, number>();
const bubbles = new Map<string, HTMLElement>();
let pmHirePending = 0;
let managerHirePending = 0;
let muted = localStorage.getItem("office.muted") === "1";

interface Meeting {
  ids: string[];
  seen: Set<string>;
  el: HTMLElement;
  log: HTMLElement;
  typing: HTMLElement;
  timer: ReturnType<typeof setInterval>;
}
let meeting: Meeting | null = null;

const agentById = (id: string) => snapshot.agents.find((a) => a.id === id);
const nameOf = (id: string) =>
  snapshot.managers && Object.values(snapshot.managers).includes(id)
    ? `Manager ${bloopName(id)}`
    : snapshot.pm && Object.values(snapshot.pm).includes(id) ? `PM ${bloopName(id)}` : agentById(id)?.isIntern ? `Intern ${bloopName(id)}` : bloopName(id);
const internAgent = () => snapshot.agents.find((a) => a.isIntern && !layingOff.has(a.id));
/** Everyone you can see and talk to on this floor: the desk agents, plus your intern. */
const talkable = () => (intern.bloop ? [...bloops.values(), intern.bloop] : [...bloops.values()]);
const colorOf = (id: string) => `#${bloopColor(id).getHexString()}`;

function sortedFloors(): ProjectInfo[] {
  return [...snapshot.projects].sort((a, b) => {
    if (a.title === "No project") return -1;
    if (b.title === "No project") return 1;
    return a.title.localeCompare(b.title);
  });
}
/** Each project is a real storey of the tower: the first is the 12th floor, then every 4th storey up. */
const floorNumber = (id: string) => 12 + sortedFloors().findIndex((p) => p.id === id) * 4;
const floorElevation = (id: string) => floorNumber(id) * FLOOR_TO_FLOOR;
const floorTitle = (id: string) => snapshot.projects.find((p) => p.id === id)?.title ?? "?";
const themeFor = (id: string) => THEMES[hashString(id) % THEMES.length];
const seatFor = (desk: number): Seat => (desk === PM_DESK ? PM_SLOT : desk === MANAGER_DESK ? MANAGER_SLOT : DESKS[desk]);
const deskLabel = (a: AgentInfo) =>
  a.desk === null ? "no desk" : a.desk === PM_DESK ? "PM desk" : a.desk === MANAGER_DESK ? "corner office" : `desk ${a.desk + 1}`;

/**
 * Measure each seat's cushion height from the furniture actually placed there, and find
 * walkable spots beside it where an agent can stand, turn around and hop in.
 */
function prepareSeats() {
  office.root.updateMatrixWorld(true);
  const seats: Seat[] = [...DESKS, PM_SLOT, MANAGER_SLOT, ...MEETING_SEATS, ...HANGOUTS.filter((s) => !s.stand)];
  const ray = new THREE.Raycaster();
  ray.camera = camera; // the office has sprites, which need a camera to raycast
  const down = new THREE.Vector3(0, -1, 0);
  const visible = (o: THREE.Object3D | null): boolean => !o || (o.visible && visible(o.parent));
  for (const seat of seats) {
    ray.set(new THREE.Vector3(seat.pos.x, 0.95, seat.pos.z), down);
    const hit = ray.intersectObject(office.root, true).find((h) => h.point.y > 0.25 && h.point.y < 0.8 && visible(h.object));
    seat.height = hit ? hit.point.y : undefined;
  }
  for (const seat of seats) {
    const side = new THREE.Vector3(seat.facing.z, 0, -seat.facing.x);
    const ok = (p: THREE.Vector3) => nav.isFreeAt(p) && seats.every((o) => o === seat || Math.hypot(o.pos.x - p.x, o.pos.z - p.z) > 0.75);
    // In front (a little closer if something like a coffee table is in the way), either side, behind.
    const front = [0.7, 0.5, 0.4].map((d) => seat.pos.clone().addScaledVector(seat.facing, d)).find(ok);
    const others = [side.clone().multiplyScalar(0.62), side.clone().multiplyScalar(-0.62), seat.facing.clone().multiplyScalar(-0.75)]
      .map((o) => seat.pos.clone().add(o))
      .filter(ok);
    seat.approaches = front ? [front, ...others] : others;
  }
}

/** Path to a seat, ending beside it (preferably in front, else the nearer side) so the agent can hop in. */
function seatPath(from: THREE.Vector3, seat: Seat) {
  let best: THREE.Vector3 | null = null;
  let bestScore = Infinity;
  for (const p of seat.approaches ?? []) {
    const ahead = (p.x - seat.pos.x) * seat.facing.x + (p.z - seat.pos.z) * seat.facing.z;
    const score = Math.hypot(p.x - from.x, p.z - from.z) + (ahead > 0.3 ? -3 : ahead < -0.3 ? 3 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return nav.find(from, best ?? seat.pos);
}

// ------------------------------------------------------------------ panels

const panel = new AgentPanel({
  getAgent: agentById,
  nameOf,
  colorOf,
  layOff,
  onClose: resumeLook,
});
ui.append(panel.el);

// Office Chat: message anyone from anywhere while you keep walking (T to show/hide).
const chat = new OfficeChat({
  agents: () => snapshot.agents.filter((a) => !layingOff.has(a.id)),
  nameOf,
  colorOf,
  floorLabel: (pid) => `${floorNumber(pid)}F ${floorTitle(pid)}`,
  walkTo: (id) => approachAgent(id),
  resume: resumeLook,
});
ui.append(chat.el); // after the panel: hides itself while you're talking to someone face to face

onModalClosed(resumeLook);

const board = new IssueBoardModal({
  snapshot: () => snapshot,
  projectId: () => floorId ?? "",
  nameOf,
  talkTo: (id) => approachAgent(id),
});

// The roster of everyone on the floor, and the floor manager (R, or the board in the corner office).
const staff = new StaffModal({
  snapshot: () => snapshot,
  projectId: () => floorId ?? "",
  nameOf,
  colorOf,
  deskLabel,
  talkTo: (id) => approachAgent(id),
  layOff,
  hireManager,
  managerHirePending: () => managerHirePending > 0,
});

// ------------------------------------------------------------------ sound

let audio: AudioContext | null = null;
function chime(kind: "attention" | "done" | "ding") {
  if (muted) return;
  try {
    audio ??= new AudioContext();
    const notes = kind === "ding" ? [1318.5, 1046.5] : kind === "done" ? [660, 880] : [880, 660, 880];
    notes.forEach((f, i) => {
      const o = audio!.createOscillator();
      const g = audio!.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t0 = audio!.currentTime + i * 0.11;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
      o.connect(g).connect(audio!.destination);
      o.start(t0);
      o.stop(t0 + 0.3);
    });
  } catch {
    /* audio unavailable */
  }
}

// ------------------------------------------------------------------ floors

function goToFloor(id: string, opts: { instant?: boolean; keepPlayer?: boolean; then?: () => void } = {}) {
  const doSwitch = () => {
    for (const b of bloops.values()) b.dispose();
    for (const b of leaving) b.dispose();
    bloops.clear();
    bloopDesk.clear();
    leaving.clear();
    breakTimers.clear();
    pendingHires.clear();
    if (meeting) endMeeting(false);
    panel.close();
    floorId = id;
    setCurrentFloor(id);
    localStorage.setItem("office.floor", id);
    const theme = themeFor(id);
    office.setTheme(theme);
    drawSign(office.sign.ctx, floorNumber(id), floorTitle(id), theme.accent);
    city.setElevation(floorElevation(id));
    office.sign.texture.needsUpdate = true;
    // Riding the lift you stay where you are (in the car); otherwise you arrive at reception.
    if (!opts.keepPlayer) player.teleport(PLAYER_START, PLAYER_START_YAW);
    intern.arriveWithBoss();
    lastBoardKey = "";
    lastStaffKey = "";
    syncFloor(true);
    renderHud();
    opts.then?.();
  };
  if (opts.instant) return doSwitch();
  fadeEl.classList.add("on");
  setTimeout(() => {
    doSwitch();
    setTimeout(() => fadeEl.classList.remove("on"), 120);
  }, 350);
}

/** Ride lift car `cab` to a floor: doors shut, the car moves, the floor changes under you, doors open. */
function rideTo(cab: number, id: string) {
  office.elevators.go(cab, { id, number: floorNumber(id), title: floorTitle(id) }, () => goToFloor(id, { instant: true, keepPlayer: true }));
}
office.elevators.onDing = () => chime("ding");

function openElevator() {
  const floors = sortedFloors();
  const list = h(
    "div",
    { class: "floors" },
    floors
      .slice()
      .reverse()
      .map((p) => {
        const agents = snapshot.agents.filter((a) => a.projectId === p.id && !a.isIntern);
        const working = agents.filter((a) => a.activity === "working").length;
        const attention = agents.filter((a) => a.activity === "needs-input" || a.activity === "error").length;
        const done = agents.filter((a) => a.activity === "done").length;
        return h(
          "button",
          {
            class: `floor-btn ${p.id === floorId ? "current" : ""}`,
            onclick: () => {
              closeModal();
              const cab = office.elevators.cabAt(player.position);
              if (cab >= 0) rideTo(cab, p.id);
              else if (p.id !== floorId) goToFloor(p.id);
            },
          },
          h("span", { class: "fnum", style: `background:${themeFor(p.id).accent}` }, `${floorNumber(p.id)}F`),
          h("span", { class: "ftitle" }, h("strong", {}, p.title), h("small", {}, p.backend === "claude" ? `Claude Code · ${p.workspaceRoot}` : p.workspaceRoot)),
          h(
            "span",
            { class: "fstats" },
            h("span", { title: "agents" }, `👥 ${agents.length}`),
            working ? h("span", { class: "st working" }, `⌨ ${working}`) : null,
            attention ? h("span", { class: "st needs-input" }, `🙋 ${attention}`) : null,
            done ? h("span", { class: "st done" }, `✓ ${done}`) : null,
          ),
        );
      }),
  );
  const pathIn = h("input", { placeholder: "/path/to/project", onkeydown: (e: KeyboardEvent) => e.stopPropagation() });
  // Without T3 Code running, offer Claude Code first.
  const t3Down = snapshot.backends ? !snapshot.backends.t3.ok : !snapshot.connected;
  const backendIn = h(
    "select",
    { title: "Which app runs this floor's agents" },
    h("option", { value: "t3" }, "T3 Code"),
    h("option", { value: "claude" }, "Claude Code"),
  ) as HTMLSelectElement;
  backendIn.value = t3Down ? "claude" : "t3";
  const add = h(
    "form",
    {
      class: "row",
      onsubmit: async (e: SubmitEvent) => {
        e.preventDefault();
        if (!pathIn.value.trim()) return;
        try {
          await api.addProject(pathIn.value.trim(), backendIn.value === "claude" ? "claude" : undefined);
          toast("New floor built! It'll show up in the elevator in a moment.", "good");
          closeModal();
        } catch (err) {
          toast(`Couldn't add that project: ${(err as Error).message}`, "bad");
        }
      },
    },
    pathIn,
    backendIn,
    h("button", { class: "btn", type: "submit" }, "🏗 Build floor"),
  );
  openModal(
    "Elevator",
    h("div", {}, h("p", { class: "muted" }, "Each floor is a T3 Code project or a Claude Code folder."), list, h("h3", {}, "Open a new floor"), add),
  );
}

// ------------------------------------------------------------------ agents on the floor

function spawnBloop(agent: AgentInfo, arriving: boolean) {
  // The floor manager is a touch bigger and wears a top hat.
  const b = agent.isManager ? new Bloop({ id: agent.id, hat: "tophat", scale: 1.1 }) : new Bloop({ id: agent.id });
  if (agent.isPm) b.root.scale.setScalar(1.05);
  // Plop! The desk chair bounces when its agent lands in it.
  b.onLanded = (seat) => {
    const d = bloopDesk.get(b.id);
    if (d !== undefined && seat === seatFor(d)) office.chairs?.bump(d);
  };
  b.setActivity(agent.activity);
  scene.add(b.root);
  bloops.set(agent.id, b);
  const desk = agent.desk!;
  bloopDesk.set(agent.id, desk);
  const seat = seatFor(desk);
  if (arriving) {
    b.placeStanding(ELEVATOR.spawn, 0);
    b.errand = "arriving";
    b.walkToSeat(seatPath(ELEVATOR.spawn, seat), seat, () => (b.errand = null));
    pendingHires.delete(desk);
  } else {
    b.sitAt(seat);
  }
  breakTimers.set(agent.id, 20 + Math.random() * 60);
}

function sendHome(b: Bloop) {
  const desk = bloopDesk.get(b.id);
  if (desk === undefined) return;
  const seat = seatFor(desk);
  b.errand = "returning";
  b.inMeeting = false;
  b.walkToSeat(seatPath(b.position, seat), seat, () => (b.errand = null));
}

function departBloop(b: Bloop, withBox: boolean) {
  bloops.delete(b.id);
  bloopDesk.delete(b.id);
  leaving.add(b);
  b.errand = "leaving";
  b.inMeeting = false;
  b.mode = "stand";
  bubbles.get(b.id)?.remove();
  bubbles.delete(b.id);
  const go = () => {
    b.walk(nav.find(b.position, ELEVATOR.exit), () => {
      b.removeWhenArrived = true;
    });
  };
  if (withBox) {
    setTimeout(() => {
      b.setCarrying(true);
      setTimeout(go, 500);
    }, 400);
  } else go();
}

function layOff(id: string, reason?: string) {
  const b = bloops.get(id);
  layingOff.add(id);
  if (b) departBloop(b, true);
  if (intern.id === id) intern.depart();
  if (meeting?.ids.includes(id)) meeting.ids = meeting.ids.filter((x) => x !== id);
  api
    .layOff(id, reason)
    .then(() => toast(`${nameOf(id)} packed up their desk and left. 📦`, "info"))
    .catch((e) => {
      layingOff.delete(id);
      toast(`Couldn't lay off: ${(e as Error).message}`, "bad");
    });
}

function syncFloor(initial = false) {
  if (!floorId) return;
  const present = new Map(snapshot.agents.map((a) => [a.id, a]));
  const onFloor = snapshot.agents.filter((a) => a.projectId === floorId && a.desk !== null && !layingOff.has(a.id));
  const ids = new Set(onFloor.map((a) => a.id));
  for (const [id, b] of [...bloops]) {
    if (!ids.has(id)) {
      // Gone entirely means archived or laid off elsewhere: pack a box on the way out.
      departBloop(b, !present.has(id));
    }
  }
  for (const agent of onFloor) {
    const b = bloops.get(agent.id);
    if (!b) {
      spawnBloop(agent, !initial && !firstSnapshot);
      continue;
    }
    b.setActivity(agent.activity);
    const desk = bloopDesk.get(agent.id);
    if (desk !== agent.desk && agent.desk !== null) {
      bloopDesk.set(agent.id, agent.desk);
      if (!b.errand) sendHome(b);
    }
  }
  updateMonitors();
}

// ------------------------------------------------------------------ monitors + board

function updateMonitors() {
  if (!floorId) return;
  const seated = new Map<number, AgentInfo>();
  for (const [id, desk] of bloopDesk) {
    const a = agentById(id);
    if (a) seated.set(desk, a);
  }
  DESKS.forEach((slot) => {
    const mon = office.monitors[slot.index];
    const agent = seated.get(slot.index);
    if (agent) drawMonitor(mon, agent, details.get(agent.id)?.items ?? null);
    else if (pendingHires.has(slot.index)) drawEmptyMonitor(mon, "recruiting…");
    else drawEmptyMonitor(mon, `desk ${slot.index + 1} · walk up and press E`);
    office.hireMarkers[slot.index].visible = !agent && !pendingHires.has(slot.index);
  });
  const pm = seated.get(PM_DESK);
  if (pm) drawMonitor(office.pmMonitor, pm, details.get(pm.id)?.items ?? null);
  else drawEmptyMonitor(office.pmMonitor, pmHirePending ? "recruiting…" : "board manager wanted");
  office.pmMarker.visible = !pm && !pmHirePending;
  const mgr = seated.get(MANAGER_DESK);
  if (mgr) drawMonitor(office.managerMonitor, mgr, details.get(mgr.id)?.items ?? null);
  else drawEmptyMonitor(office.managerMonitor, managerHirePending ? "recruiting…" : "floor manager wanted");
  office.managerMarker.visible = !mgr && !managerHirePending;
  drawBoardIfChanged();
  drawStaffIfChanged();
}

let lastStaffKey = "";
/** The roster on the manager's office wall, and the nameplate over their door. */
function drawStaffIfChanged() {
  if (!floorId) return;
  const agents = snapshot.agents.filter((a) => a.projectId === floorId && !a.isIntern && !layingOff.has(a.id));
  const mgrId = snapshot.managers?.[floorId] ?? null;
  const log = (snapshot.staffLog ?? []).filter((e) => e.projectId === floorId);
  const minute = Math.floor(Date.now() / 60_000); // keeps "5m ago" current
  const key = JSON.stringify([agents.map((a) => [a.id, a.activity, a.title, a.desk]), mgrId, log.slice(-2).map((e) => e.id), minute]);
  if (key === lastStaffKey) return;
  lastStaffKey = key;
  drawRoster(office.staffBoard.ctx, agents, { nameOf, colorOf, managerName: mgrId ? nameOf(mgrId) : null, log, deskLabel });
  office.staffBoard.texture.needsUpdate = true;
  drawNameplate(office.managerSign.ctx, mgrId ? bloopName(mgrId) : null);
  office.managerSign.texture.needsUpdate = true;
}

let lastBoardKey = "";
function drawBoardIfChanged() {
  if (!floorId) return;
  const issues = snapshot.issues.filter((i) => i.projectId === floorId);
  const pmId = snapshot.pm[floorId];
  const settings = snapshot.boards?.[floorId] ?? defaultBoardSettings();
  const key = JSON.stringify([
    issues.map((i) => [i.id, i.status, i.title, i.assignee, i.labels]),
    pmId,
    settings.columns,
    settings.wall,
    settings.gitlab.enabled,
    "labels" in settings ? settings.labels : null,
  ]);
  if (key === lastBoardKey) return;
  lastBoardKey = key;
  drawBoard(office.board.ctx, issues, settings, nameOf, pmId ? nameOf(pmId) : null);
  office.board.texture.needsUpdate = true;
}

let inFlight = 0;
function pumpDetails() {
  if (!floorId || inFlight >= 2) return;
  const now = Date.now();
  const candidates = [...bloops.keys()]
    .map((id) => agentById(id))
    .filter((a): a is AgentInfo => !!a)
    .filter((a) => {
      const d = details.get(a.id);
      if (!d) return true;
      return d.updatedAt !== a.updatedAt && now - d.fetchedAt > 2500;
    })
    .sort((a, b) => (a.activity === "working" ? -1 : 0) - (b.activity === "working" ? -1 : 0));
  for (const a of candidates.slice(0, 2 - inFlight)) {
    inFlight++;
    const updatedAt = a.updatedAt;
    api
      .detail(a.id)
      .then((d) => {
        details.set(a.id, { items: d.items, updatedAt, fetchedAt: Date.now() });
        updateMonitors();
      })
      .catch(() => details.set(a.id, { items: [], updatedAt, fetchedAt: Date.now() }))
      .finally(() => inFlight--);
  }
}
setInterval(pumpDetails, 700);

// ------------------------------------------------------------------ snapshot handling

function onSnapshot(s: OfficeSnapshot) {
  const prev = snapshot;
  snapshot = s;
  bannerEl.classList.toggle("hidden", s.connected);
  if (!s.connected) {
    bannerEl.textContent = `Can't reach T3 Code (${s.error ?? "unknown error"}). Is the T3 Code app running?`;
    if (s.backends) bannerEl.textContent += " Or take the elevator (F) to open a Claude Code floor in any folder.";
  }

  // Notifications for agents that just finished or need a hand.
  if (!firstSnapshot) {
    for (const a of s.agents) {
      const before = prevActivity.get(a.id);
      if (before && before !== a.activity) {
        const where = a.projectId === floorId || a.isIntern ? "" : ` (${floorNumber(a.projectId)}F ${floorTitle(a.projectId)})`;
        if (a.activity === "needs-input") {
          toast(`🙋 ${nameOf(a.id)} needs your input${where}`, "warn", () => approachAgent(a.id));
          chime("attention");
        } else if (a.activity === "done") {
          toast(`✅ ${nameOf(a.id)} finished "${a.title}"${where}`, "good", () => approachAgent(a.id));
          chime("done");
        } else if (a.activity === "error") {
          toast(`⚠️ ${nameOf(a.id)} hit an error${where}`, "bad", () => approachAgent(a.id));
          chime("attention");
        }
      }
    }
  }
  for (const a of s.agents) prevActivity.set(a.id, a.activity);
  if (floorId && s.pm[floorId] && !prev.pm[floorId]) pmHirePending = 0;
  if (floorId && s.managers?.[floorId] && !prev.managers?.[floorId]) managerHirePending = 0;

  if (!floorId && s.projects.length) {
    const saved = localStorage.getItem("office.floor");
    const start = s.projects.find((p) => p.id === saved)?.id ?? sortedFloors()[0].id;
    goToFloor(start, { instant: true });
  } else if (floorId && !s.projects.some((p) => p.id === floorId) && s.projects.length) {
    goToFloor(sortedFloors()[0].id);
  } else {
    syncFloor();
  }
  const ia = internAgent();
  intern.sync(ia?.id ?? null, ia?.activity, internRecruiting > 0);
  if (ia) internRecruiting = 0;
  renderInternButton();
  firstSnapshot = false;
  panel.sync();
  chat.sync();
  board.refresh();
  staff.refresh();
  renderHud();
}

// ?demo=1 fills an empty office with demo agents (for trying the office or the ray tracer).
const demo = new DemoOffice();
let rawSnapshot: OfficeSnapshot | null = null;
const feedSnapshot = () => {
  if (rawSnapshot) onSnapshot(demo.wrap(rawSnapshot, feedSnapshot));
};
api.subscribe(
  (s) => {
    rawSnapshot = s;
    feedSnapshot();
  },
  (ok) => connEl.classList.toggle("ok", ok),
);

// ------------------------------------------------------------------ HUD

function renderHud() {
  if (floorId) {
    floorBadge.replaceChildren(
      h("span", { class: "fnum", style: `background:${themeFor(floorId).accent}` }, `${floorNumber(floorId)}F`),
      h("span", {}, floorTitle(floorId)),
      h("span", { class: "muted" }, " ▾"),
    );
  }
  const order: Record<string, number> = { "needs-input": 0, error: 1, done: 2 };
  const needy = snapshot.agents
    .filter((a) => a.activity in order && !layingOff.has(a.id))
    .sort((a, b) => order[a.activity] - order[b.activity] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const working = snapshot.agents.filter((a) => a.activity === "working").length;
  attentionEl.replaceChildren(
    h("div", { class: "att-head" }, needy.length ? `${needy.length} need${needy.length === 1 ? "s" : ""} you` : "All caught up ✨", h("span", { class: "muted" }, ` · ${working} working`)),
    ...needy.slice(0, 8).map((a) =>
      h(
        "button",
        { class: "att-item", onclick: () => approachAgent(a.id) },
        h("span", { class: "dot", style: `background:${ACTIVITY_COLORS[a.activity]}` }),
        h("span", { class: "att-name" }, nameOf(a.id)),
        h("span", { class: "att-what" }, a.activity === "needs-input" ? "needs input" : a.activity === "done" ? "done" : "error"),
        a.projectId !== floorId && !a.isIntern ? h("span", { class: "att-floor" }, `${floorNumber(a.projectId)}F`) : null,
      ),
    ),
  );
}

floorBadge.addEventListener("click", openElevator);
document.getElementById("mute")!.addEventListener("click", toggleMute);
document.getElementById("help-toggle")!.addEventListener("click", () => document.getElementById("help")!.classList.toggle("collapsed"));
function toggleMute() {
  muted = !muted;
  localStorage.setItem("office.muted", muted ? "1" : "0");
  document.getElementById("mute")!.textContent = muted ? "🔇" : "🔔";
}
document.getElementById("mute")!.textContent = muted ? "🔇" : "🔔";

// ------------------------------------------------------------------ interactions

interface Interactable {
  pos: THREE.Vector3;
  radius: number;
  label: string;
  run: () => void;
  weight?: number;
  /** Set when this is an agent. */
  bloopId?: string;
}

function interactables(): Interactable[] {
  const list: Interactable[] = [];
  for (const b of talkable()) {
    if (b.errand === "leaving") continue;
    list.push({ pos: b.position, radius: 1.7, label: `Talk to ${nameOf(b.id)}`, run: () => openAgent(b.id), weight: 0.75, bloopId: b.id });
  }
  if (floorId) {
    const occupied = new Set(bloopDesk.values());
    for (const slot of DESKS) {
      if (occupied.has(slot.index) || pendingHires.has(slot.index)) continue;
      list.push({ pos: slot.pos, radius: 1.3, label: `Hire an agent for desk ${slot.index + 1}`, run: () => openHire(slot.index) });
    }
    if (!occupied.has(PM_DESK) && !pmHirePending) {
      list.push({ pos: PM_SLOT.pos, radius: 1.4, label: "Hire a board manager", run: hirePm });
    }
    if (!occupied.has(MANAGER_DESK) && !managerHirePending) {
      list.push({ pos: MANAGER_SLOT.pos, radius: 1.4, label: "Hire a floor manager", run: () => void hireManager() });
    }
  }
  list.push({ pos: BOARD.front, radius: 2.6, label: "Open the issue board", run: () => board.open() });
  list.push({ pos: STAFF.front, radius: 2.4, label: "Open the staff roster", run: () => staff.open() });
  list.push({
    pos: MEETING.table,
    radius: 3.6,
    label: meeting ? "Meeting in progress (end it from the meeting panel)" : "Call a meeting",
    run: () => (meeting ? meeting.el.querySelector("textarea")?.focus() : openMeetingSetup()),
  });
  const inCar = office.elevators.cabAt(player.position) >= 0;
  if (!inCar) list.push({ pos: ELEVATOR.panel, radius: 2.4, label: "Call the elevator", run: () => office.elevators.call(player.position) });
  // Inside a car: aim at a floor button (see updatePrompt), or pick from the list.
  else if (!office.elevators.riding) {
    list.push({ pos: player.position.clone(), radius: 9, label: "Choose a floor", run: openElevator, weight: 50 });
  }
  return list;
}

let focused: Interactable | null = null;
function updatePrompt() {
  if (modalOpen() || panel.isOpen) {
    focused = null;
    promptEl.classList.add("hidden");
    return;
  }
  let best: Interactable | null = null;
  let bestScore = Infinity;
  const firstPerson = player.view === "first";
  const look = player.viewDir();
  const lookFlat = new THREE.Vector2(look.x, look.z).normalize();
  // In first person, whoever is under the crosshair wins.
  if (firstPerson) {
    raycaster.set(player.eye(), look);
    raycaster.far = 6;
    const hit = raycaster.intersectObjects(talkable().map((b) => b.root), true)[0];
    raycaster.far = Infinity;
    const b = hit?.object.userData.bloop as Bloop | undefined;
    if (b && b.errand !== "leaving") {
      best = { pos: b.position, radius: 6, label: `Talk to ${nameOf(b.id)}`, run: () => openAgent(b.id), bloopId: b.id };
      bestScore = -1;
    }
  }
  // In a lift car, the floor button under the crosshair.
  if (firstPerson && bestScore >= 0 && office.elevators.cabAt(player.position) >= 0 && !office.elevators.riding) {
    raycaster.set(player.eye(), look);
    raycaster.far = 2.5;
    const pick = office.elevators.pick(raycaster);
    raycaster.far = Infinity;
    if (pick) {
      const { cab, floor } = pick;
      const here = floor.id === floorId;
      best = { pos: player.position, radius: 9, label: here ? `You're on ${floor.number}F (opens the doors)` : `Go to ${floor.number}F · ${floor.title}`, run: () => rideTo(cab, floor.id) };
      bestScore = -1;
    }
  } else office.elevators.clearHover();
  for (const it of interactables()) {
    if (bestScore < 0) break;
    const d = it.pos.distanceTo(player.position.clone().setY(it.pos.y));
    if (d > it.radius) continue;
    let score = d * (it.weight ?? 1);
    if (firstPerson && d > 0.6) {
      // Prefer what you're facing; ignore things behind you.
      const to = new THREE.Vector2(it.pos.x - player.position.x, it.pos.z - player.position.z).normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(to.dot(lookFlat), -1, 1));
      if (angle > 0.95) continue;
      score *= 1 + angle * 2;
    }
    if (score < bestScore) {
      bestScore = score;
      best = it;
    }
  }
  focused = best;
  if (best) {
    promptEl.replaceChildren(h("kbd", {}, "E"), player.view === "first" ? " / click " : " ", best.label);
    promptEl.classList.remove("hidden");
  } else {
    promptEl.classList.add("hidden");
  }
}

window.addEventListener("keydown", (e) => {
  if (isTyping()) return;
  if (e.code === "Escape") {
    if (modalOpen()) closeModal();
    else if (panel.isOpen) panel.close();
    return;
  }
  if (modalOpen()) return;
  if (e.code === "KeyE" && focused) {
    e.preventDefault();
    focused.run();
  } else if (e.code === "KeyF") {
    openElevator();
  } else if (e.code === "KeyB") {
    board.open();
  } else if (e.code === "KeyR") {
    staff.open();
  } else if (e.code === "KeyM") {
    toggleMute();
  } else if (e.code === "KeyV") {
    player.toggleView();
  } else if (e.code === "KeyT") {
    chat.toggle();
  } else if (e.code === "KeyI") {
    callIntern();
  } else if ((e.code === "Enter" || e.code === "NumpadEnter") && !(document.activeElement as HTMLElement | null)?.closest("button, a")) {
    e.preventDefault();
    chat.focusComposer();
  } else if (e.code === "BracketLeft" || e.code === "BracketRight") {
    chat.cycle(e.code === "BracketLeft" ? -1 : 1);
  } else if (e.code === "KeyG") {
    setRayTracing(!rt.enabled);
    toast(rt.enabled ? "⚡ Ray tracing on" : "Ray tracing off (original look)");
  } else if (e.code === "KeyL" && rt.enabled) {
    toast(`Lighting: ${rt.cycleMood()}`);
    rtHud.draw();
  } else if (e.code === "KeyX" && rt.enabled) {
    rt.view = (rt.view + 1) % 5;
    rtHud.draw();
  } else if (e.code === "KeyN" && rt.enabled) {
    rt.denoise = !rt.denoise;
    rtHud.draw();
  }
});

function openAgent(id: string) {
  panel.open(id);
  const b = bloops.get(id) ?? (intern.id === id ? intern.bloop : null);
  // Seated agents swivel round on their own (see the frame loop); standing ones just turn.
  if (b && b.mode !== "sit") b.targetYaw = Math.atan2(player.position.x - b.position.x, player.position.z - b.position.z);
}

/** Walk over to an agent (switching floors if needed) and open their panel. */
function approachAgent(id: string) {
  const agent = agentById(id);
  if (!agent) return;
  closeModal();
  if (agent.isIntern) {
    // They're already right behind you.
    player.cancelAuto();
    openAgent(id);
    return;
  }
  const walk = () => {
    const b = bloops.get(id);
    if (!b) {
      openAgent(id);
      return;
    }
    player.goTo(nav, b.position, () => openAgent(id), player.view === "first" ? 1.5 : 1.1);
  };
  if (agent.projectId !== floorId) goToFloor(agent.projectId, { then: () => setTimeout(walk, 50) });
  else walk();
}

function openHire(desk: number) {
  if (!floorId) return;
  const pid = floorId;
  const models = new Map<string, string>();
  const claudeFloor = snapshot.projects.find((p) => p.id === pid)?.backend === "claude";
  if (claudeFloor) for (const m of ["opus", "sonnet", "haiku"]) models.set(`claude-code|${m}`, `${m[0].toUpperCase()}${m.slice(1)} (Claude Code)`);
  else for (const a of snapshot.agents) if (a.model && a.provider && a.backend !== "claude") models.set(`${a.provider}|${a.model}`, `${a.model} (${a.provider})`);
  const task = h("textarea", { rows: 5, placeholder: "What should they work on? This becomes their first message.", onkeydown: (e: KeyboardEvent) => e.stopPropagation() });
  const title = h("input", { placeholder: "Job title (optional, defaults to the task's first line)", onkeydown: (e: KeyboardEvent) => e.stopPropagation() });
  const model = h("select", {}, h("option", { value: "" }, "Project default model"), [...models].map(([v, l]) => h("option", { value: v }, l)));
  const submit = h("button", { class: "btn primary", type: "submit" }, "🤝 Hire");
  const form = h(
    "form",
    {
      class: "form",
      onsubmit: async (e: SubmitEvent) => {
        e.preventDefault();
        if (!task.value.trim()) return task.focus();
        submit.disabled = true;
        submit.textContent = "Recruiting…";
        const [provider, modelSlug] = model.value ? model.value.split("|") : [undefined, undefined];
        pendingHires.set(desk, Date.now());
        updateMonitors();
        closeModal();
        toast("Recruiting a new agent… they'll be up from the elevator shortly.", "info");
        try {
          await api.hire({ projectId: pid, desk, message: task.value.trim(), title: title.value.trim() || undefined, provider, model: modelSlug });
        } catch (err) {
          pendingHires.delete(desk);
          updateMonitors();
          toast(`Hiring failed: ${(err as Error).message}`, "bad");
        }
      },
    },
    h("label", {}, "Task", task),
    h("label", {}, "Title", title),
    h("label", {}, "Model", model),
    h("div", { class: "row end" }, submit),
  );
  openModal(`Hire for desk ${desk + 1} · ${floorTitle(pid)}`, form);
}

async function hirePm() {
  if (!floorId) return;
  pmHirePending = Date.now();
  updateMonitors();
  toast("Hiring a board manager for this floor…", "info");
  try {
    await api.ensurePm(floorId);
  } catch (e) {
    pmHirePending = 0;
    updateMonitors();
    toast(`Couldn't hire a PM: ${(e as Error).message}`, "bad");
  }
}

async function hireManager() {
  if (!floorId) return;
  managerHirePending = Date.now();
  updateMonitors();
  staff.refresh();
  toast("Hiring a floor manager… they'll head up to the corner office. 🎩", "info");
  try {
    await api.ensureManager(floorId);
  } catch (e) {
    managerHirePending = 0;
    updateMonitors();
    staff.refresh();
    toast(`Couldn't hire a manager: ${(e as Error).message}`, "bad");
  }
}

// ------------------------------------------------------------------ the intern

const internBtn = h("button", { class: "icon-btn intern-btn", title: "Your intern (I)", onclick: () => callIntern() }, "🌱");
document.querySelector("#hud-tl .hud-btns")?.prepend(internBtn);

function renderInternButton() {
  const a = internAgent();
  internBtn.title = a ? `Talk to ${nameOf(a.id)}, your intern (I)` : internRecruiting ? "Your intern is on the way…" : "Recruit an intern (I)";
  internBtn.classList.toggle("has-intern", !!a);
  internBtn.style.setProperty("--dot", a ? ACTIVITY_COLORS[a.activity] : "transparent");
}

/** I: talk to your intern (they come round in front of you), or recruit one. */
function callIntern() {
  const a = internAgent();
  if (a) {
    if (panel.agentId === a.id) panel.close();
    else openAgent(a.id);
  } else if (internRecruiting) {
    toast("Your intern is on the way up. Hang tight!", "info");
  } else {
    openRecruitIntern();
  }
}

function openRecruitIntern() {
  const models = new Map<string, string>();
  for (const a of snapshot.agents) if (a.model && a.provider) models.set(`${a.provider}|${a.model}`, `${a.model} (${a.provider})`);
  const ask = h("textarea", {
    rows: 3,
    placeholder: "First thing to ask them (optional). E.g. \"How does the issue board sync with GitLab here?\"",
    onkeydown: (e: KeyboardEvent) => e.stopPropagation(),
  });
  const model = h("select", {}, h("option", { value: "" }, "Default model"), [...models].map(([v, l]) => h("option", { value: v }, l)));
  const submit = h("button", { class: "btn primary", type: "submit" }, "🌱 Recruit intern");
  const form = h(
    "form",
    {
      class: "form",
      onsubmit: async (e: SubmitEvent) => {
        e.preventDefault();
        submit.disabled = true;
        const [provider, modelSlug] = model.value ? model.value.split("|") : [undefined, undefined];
        internRecruiting = Date.now();
        renderInternButton();
        closeModal();
        toast("Recruiting an intern… they'll be up from the elevator shortly.", "info");
        try {
          await api.recruitIntern({ message: ask.value.trim() || undefined, provider, model: modelSlug });
        } catch (err) {
          internRecruiting = 0;
          renderInternButton();
          toast(`Couldn't recruit an intern: ${(err as Error).message}`, "bad");
        }
      },
    },
    h(
      "p",
      { class: "muted" },
      "An intern has no desk and no project. They follow you from floor to floor, so you can ask how something works on whatever floor you're on, ask general questions, or send them on errands. Press I any time to talk to them.",
    ),
    h("label", {}, "First question", ask),
    h("label", {}, "Model", model),
    h("div", { class: "row end" }, submit),
  );
  openModal("Recruit an intern", form);
}

// ------------------------------------------------------------------ meetings

function openMeetingSetup() {
  if (!floorId) return;
  const candidates = [...bloops.keys()].map(agentById).filter((a): a is AgentInfo => !!a);
  if (!candidates.length) {
    toast("Nobody on this floor to meet with yet. Hire someone first!", "warn");
    return;
  }
  const checks = candidates.map((a) => {
    const cb = h("input", { type: "checkbox", value: a.id });
    return h(
      "label",
      { class: "check" },
      cb,
      h("span", { class: "dot", style: `background:${colorOf(a.id)}` }),
      h("strong", {}, nameOf(a.id)),
      h("span", { class: "muted" }, ` · ${a.activity} · ${a.title}`),
    );
  });
  const topic = h("textarea", { rows: 3, placeholder: "Opening topic (optional). Sent to everyone when the meeting starts.", onkeydown: (e: KeyboardEvent) => e.stopPropagation() });
  const form = h(
    "form",
    {
      class: "form",
      onsubmit: (e: SubmitEvent) => {
        e.preventDefault();
        const ids = checks.map((c) => c.querySelector("input")!).filter((i) => i.checked).map((i) => i.value).slice(0, MEETING_SEATS.length);
        if (!ids.length) return toast("Pick at least one agent.", "warn");
        closeModal();
        void startMeeting(ids, topic.value.trim());
      },
    },
    h("p", { class: "muted" }, `Invite up to ${MEETING_SEATS.length} agents. Everything you say in the meeting goes to all attendees.`),
    h("div", { class: "checks" }, checks),
    h("label", {}, "Topic", topic),
    h("div", { class: "row end" }, h("button", { class: "btn primary", type: "submit" }, "📣 Start meeting")),
  );
  openModal("Call a meeting", form);
}

async function startMeeting(ids: string[], topic: string) {
  const seen = new Set<string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const d = await api.detail(id);
        d.items.forEach((i) => seen.add(i.id));
      } catch {
        /* ignore */
      }
    }),
  );
  const log = h("div", { class: "meeting-log" });
  const typing = h("div", { class: "typing muted" });
  const input = h("textarea", {
    rows: 2,
    placeholder: "Say something to the room… (Enter to send)",
    onkeydown: (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void say(input.value);
        input.value = "";
      }
      if (e.key === "Escape") input.blur();
    },
  });
  const el = h(
    "aside",
    { class: "meeting-panel" },
    h(
      "header",
      {},
      h("h2", {}, "📣 Meeting"),
      h("div", { class: "attendees" }, ids.map((id) => h("span", { class: "chip", style: `--c:${colorOf(id)}` }, nameOf(id)))),
      h("button", { class: "btn", onclick: () => endMeeting(true) }, "End meeting"),
    ),
    log,
    typing,
    h("div", { class: "composer" }, input, h("button", { class: "btn primary", onclick: () => { void say(input.value); input.value = ""; } }, "Say")),
  );
  ui.append(el);
  const timer = setInterval(() => void pollMeeting(), 2500);
  meeting = { ids, seen, el, log, typing, timer };

  // Everyone walks to the meeting room.
  ids.forEach((id, i) => {
    const b = bloops.get(id);
    if (!b) return;
    const seat = MEETING_SEATS[i];
    b.errand = "meeting";
    b.inMeeting = true;
    b.walkToSeat(seatPath(b.position, seat), seat);
  });
  player.goTo(nav, MEETING.host, () => player.faceTowards(MEETING.table), 0.01);
  log.append(h("div", { class: "sys" }, `Meeting started with ${ids.map(nameOf).join(", ")}.`));
  if (topic) void say(topic);

  async function say(text: string) {
    text = text.trim();
    if (!text || !meeting) return;
    log.append(h("div", { class: "line boss" }, h("strong", {}, "You: "), text));
    log.scrollTop = log.scrollHeight;
    try {
      await api.meeting(meeting.ids, text);
    } catch (e) {
      toast(`Couldn't reach the room: ${(e as Error).message}`, "bad");
    }
  }
}

async function pollMeeting() {
  const m = meeting;
  if (!m) return;
  const typingNames: string[] = [];
  await Promise.all(
    m.ids.map(async (id) => {
      const a = agentById(id);
      if (a?.activity === "working") typingNames.push(nameOf(id));
      try {
        const d = await api.detail(id);
        for (const item of d.items) {
          if (m.seen.has(item.id)) continue;
          if (item.type !== "assistant" || /*streaming partials*/ !item.text) continue;
          if (a?.activity === "working" && item === d.items.at(-1)) continue; // wait until it settles
          m.seen.add(item.id);
          m.log.append(
            h("div", { class: "line" }, h("strong", { style: `color:${colorOf(id)}` }, `${nameOf(id)}: `), item.text),
          );
          m.log.scrollTop = m.log.scrollHeight;
        }
      } catch {
        /* ignore */
      }
    }),
  );
  m.typing.textContent = typingNames.length ? `${typingNames.join(", ")} ${typingNames.length > 1 ? "are" : "is"} thinking…` : "";
}

function endMeeting(walkBack: boolean) {
  const m = meeting;
  if (!m) return;
  meeting = null;
  clearInterval(m.timer);
  m.el.remove();
  if (!walkBack) return;
  for (const id of m.ids) {
    const b = bloops.get(id);
    if (b) sendHome(b);
  }
}

// ------------------------------------------------------------------ clicking in the world

const raycaster = new THREE.Raycaster();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
canvas.addEventListener("click", (e) => {
  if (player.wasDrag || modalOpen()) return;
  if (player.view === "first") {
    // First person: the first click captures the mouse; after that, click uses what's under the crosshair.
    if (panel.isOpen) panel.close();
    else if (!player.isLocked) player.lock();
    else if (focused) focused.run();
    return;
  }
  const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const roots = talkable().map((b) => b.root);
  const hit = raycaster.intersectObjects(roots, true)[0];
  if (hit) {
    const b = hit.object.userData.bloop as Bloop | undefined;
    if (b) {
      player.goTo(nav, b.position, () => openAgent(b.id), 1.1);
      return;
    }
  }
  const p = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(floorPlane, p)) return;
  // Clicked near something interactive? Walk there and use it.
  let best: Interactable | null = null;
  let bestD = Infinity;
  for (const it of interactables()) {
    const d = it.pos.distanceTo(p.clone().setY(it.pos.y));
    if (d < Math.min(1.2, it.radius) && d < bestD) {
      best = it;
      bestD = d;
    }
  }
  if (best) {
    const target = best;
    player.goTo(nav, target.pos, () => target.run(), Math.min(1.0, target.radius * 0.6));
  } else {
    player.goTo(nav, p, undefined, 0.01);
  }
});

// ------------------------------------------------------------------ bubbles

const tmpV = new THREE.Vector3();
function updateBubbles() {
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  const seen = new Set<string>();
  for (const b of talkable()) {
    const agent = agentById(b.id);
    if (!agent) continue;
    const near = b.position.distanceTo(player.position) < 4.5;
    let text = "";
    let cls = "";
    if (agent.activity === "needs-input") {
      text = agent.pendingKind && agent.pendingKind !== "user_input" ? "✋ needs approval" : "🙋 needs input";
      cls = "needs-input";
    } else if (agent.activity === "done") {
      text = "✅ done!";
      cls = "done";
    } else if (agent.activity === "error") {
      text = "⚠️ error";
      cls = "error";
    } else if (agent.activity === "working") {
      text = b.inMeeting ? "💭" : "⌨︎";
      cls = "working small";
    }
    if (!text && !near) continue;
    b.headWorld(tmpV);
    tmpV.project(camera);
    if (tmpV.z > 1) continue;
    const x = (tmpV.x * 0.5 + 0.5) * w;
    const y = (-tmpV.y * 0.5 + 0.5) * hgt;
    if (x < -100 || x > w + 100 || y < -60 || y > hgt + 60) continue;
    seen.add(b.id);
    let el = bubbles.get(b.id);
    if (!el) {
      el = h("div", { class: "bubble", onclick: () => player.goTo(nav, b.position, () => openAgent(b.id), 1.1) });
      bubbleLayer.append(el);
      bubbles.set(b.id, el);
    }
    const content = near ? `${nameOf(b.id)}${text ? " · " + text : ""}` : text;
    if (el.dataset.content !== content) {
      el.dataset.content = content;
      el.textContent = content;
      el.title = `${agent.title}\n${agent.status} · ${timeAgo(agent.updatedAt)}`;
    }
    el.className = `bubble ${cls} ${near ? "near" : ""}`;
    const dist = camera.position.distanceTo(b.position);
    const scale = THREE.MathUtils.clamp(9 / dist, 0.6, 1.15);
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) scale(${scale})`;
  }
  for (const [id, el] of bubbles) {
    if (!seen.has(id)) {
      el.remove();
      bubbles.delete(id);
    }
  }
}

// ------------------------------------------------------------------ idle breaks

function updateBreaks(dt: number) {
  const busyHangouts = new Set<number>();
  for (const b of bloops.values()) if (b.hangout !== undefined) busyHangouts.add(b.hangout);
  for (const b of bloops.values()) {
    const agent = agentById(b.id);
    if (!agent) continue;
    if (b.errand === "break") {
      // Get back to the desk as soon as there's work or someone needs them.
      const t = (breakTimers.get(b.id) ?? 0) - dt;
      breakTimers.set(b.id, t);
      if (agent.activity !== "idle" || t < 0) {
        b.hangout = undefined;
        breakTimers.set(b.id, 30 + Math.random() * 60);
        sendHome(b);
      }
      continue;
    }
    if (b.errand || b.mode !== "sit" || agent.activity !== "idle" || panel.agentId === b.id) continue;
    const t = (breakTimers.get(b.id) ?? 30) - dt;
    breakTimers.set(b.id, t);
    if (t > 0) continue;
    breakTimers.set(b.id, 30 + Math.random() * 60);
    if (Math.random() > 0.45) continue;
    const free = HANGOUTS.map((_, i) => i).filter((i) => !busyHangouts.has(i));
    if (!free.length) continue;
    const idx = free[Math.floor(Math.random() * free.length)];
    const spot = HANGOUTS[idx];
    busyHangouts.add(idx);
    b.hangout = idx;
    b.errand = "break";
    breakTimers.set(b.id, 15 + Math.random() * 25);
    if (spot.stand) {
      b.walk(nav.find(b.position, spot.pos), () => {
        b.targetYaw = Math.atan2(spot.facing.x, spot.facing.z);
      });
    } else {
      b.walkToSeat(seatPath(b.position, spot), spot);
    }
  }
}

// ------------------------------------------------------------------ main loop

const clock = new THREE.Clock();
let hudTimer = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  office.elevators.setFloors(
    sortedFloors()
      .slice()
      .reverse()
      .map((p) => ({ id: p.id, number: floorNumber(p.id), title: p.title })),
    floorId,
  );
  office.elevators.update(dt, [player.position, ...[...bloops.values()].map((b) => b.position), ...(intern.bloop ? [intern.bloop.position] : [])]);
  player.update(dt, office.colliders);
  player.updateCamera(camera, dt);
  camera.position.y += office.elevators.cameraOffset;
  for (const [id, b] of bloops) {
    // Walk up to someone (or talk to them) and they swivel round in their chair to face you.
    if (b.mode === "sit" && !b.inMeeting) {
      const near = Math.hypot(player.position.x - b.position.x, player.position.z - b.position.z);
      if (panel.agentId === id || (focused?.bloopId === id && near < 2.6)) b.attend(player.position);
    }
    b.update(dt, time);
  }
  // Desk chairs turn with whoever is sitting in them.
  if (office.chairs) {
    const held = new Map<number, number>();
    for (const [id, b] of bloops) {
      const d = bloopDesk.get(id);
      const yaw = b.chairYaw;
      if (d !== undefined && yaw !== null && b.seat === seatFor(d)) held.set(d, yaw);
    }
    office.chairs.update(dt, held);
  }
  intern.summoned = !!intern.id && panel.agentId === intern.id;
  intern.update(dt, time);
  for (const b of leaving) {
    b.update(dt, time);
    if (b.removeWhenArrived) {
      b.root.scale.multiplyScalar(1 - Math.min(1, dt * 6));
      if (b.root.scale.x < 0.05) {
        b.dispose();
        leaving.delete(b);
      }
    }
  }
  const hover = Math.sin(time * 2.5) * 0.06;
  for (const m of office.hireMarkers) {
    if (!m.visible) continue;
    m.position.y = 1.15 + hover;
    const near = m.position.distanceTo(player.position) < 5.5;
    m.scale.setScalar(near ? 0.42 : 0.0001);
  }
  if (office.pmMarker.visible) office.pmMarker.position.y = 1.15 + hover;
  if (office.managerMarker.visible) office.managerMarker.position.y = 1.15 + hover;
  // Typing in Office Chat keeps the mouse captured so you can glance around mid-message.
  const uiBusy = modalOpen() || panel.isOpen || (isTyping() && !chat.typing);
  if (uiBusy && player.isLocked) player.unlock();
  const fp = player.view === "first";
  crosshairEl.classList.toggle("hidden", !fp || uiBusy || !player.isLocked);
  crosshairEl.classList.toggle("active", !!focused);
  const showEnter = fp && !player.isLocked && !uiBusy;
  enterEl.classList.toggle("hidden", !showEnter);
  if (showEnter) enterEl.dataset.mode = enteredOnce ? "resume" : "start";
  updateBreaks(dt);
  office.setCutaway(player.view === "third");
  city.towerAbove.visible = player.view !== "third";
  city.update(dt, time);
  dayNight.update(dt);
  updatePrompt();
  updateBubbles();
  hudTimer += dt;
  if (hudTimer > 5) {
    hudTimer = 0;
    // Expire hires that never showed up.
    for (const [desk, at] of pendingHires) if (Date.now() - at > 90_000) pendingHires.delete(desk);
    if (pmHirePending && Date.now() - pmHirePending > 90_000) pmHirePending = 0;
    if (managerHirePending && Date.now() - managerHirePending > 90_000) managerHirePending = 0;
    if (internRecruiting && Date.now() - internRecruiting > 90_000) {
      internRecruiting = 0;
      renderInternButton();
    }
  }
  rtHud.update(dt);
  if (rt.enabled) rt.render();
  else renderer.render(scene, camera);
}
frame();

// Handy for poking at the office from the browser console.
(window as unknown as Record<string, unknown>).office = {
  player,
  approachAgent,
  goToFloor,
  openElevator,
  openAgent,
  board,
  chat,
  intern,
  snapshot: () => snapshot,
  bloops,
  nav,
  renderer,
  seatFor: (id: string) => {
    const d = bloopDesk.get(id);
    return d === undefined ? undefined : seatFor(d);
  },
  seatPath,
  seats: { pm: PM_SLOT, manager: MANAGER_SLOT, meeting: MEETING_SEATS, hangouts: HANGOUTS },
  staff,
  chairs: office.chairs,
  elevators: office.elevators,
};
