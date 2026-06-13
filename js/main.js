"use strict";

// ---------------------------------------------------------------------------
// main.js — rendering, input, game loop, and the "future" analysis.
//
// Controls: drag the felt to aim · drag the left slider (release) or Space to
// shoot · drag the right dial for fine aim · R to re-rack.
//
// Two views:
//   Play   — one clean predicted shot (cue path, ghost contact, target path,
//            target pocket) plus translucent ghost balls at predicted rests.
//   Assist — the full solver: every ball's path, stop markers, all badges.
//
// A "future" panel estimates pot / scratch / next-shot chances by simulating
// the aimed shot many times with small aim & power jitter (Monte-Carlo).
// Fully self-contained; nothing connects to any external game.
// ---------------------------------------------------------------------------

const canvas = document.getElementById("table");
const ctx = canvas.getContext("2d");
const bounds = playfield();

const W = TABLE.width;
const H = TABLE.height;

const dpr = Math.max(1, Math.min(3, Math.floor(window.devicePixelRatio || 1)));
canvas.width = W * dpr;
canvas.height = H * dpr;
ctx.scale(dpr, dpr);

const MAX_SPEED = 19;
const FINE_SENSITIVITY = 0.0015;

const ui = {
  mode: document.getElementById("mode"), // 'play' | 'assist'
  reset: document.getElementById("reset"),
};
const isAssist = () => ui.mode && ui.mode.value === "assist";

const statusEl = document.getElementById("status");
const shotListEl = document.getElementById("shotList");
const shotStatsEl = document.getElementById("shotStats");
const shotTipsEl = document.getElementById("shotTips");
const POCKET_NAMES = ["top-left", "top-middle", "top-right", "bottom-left", "bottom-middle", "bottom-right"];
const advisor = { list: [] };

let balls = [];
let wasMoving = false;

const state = {
  aimAngle: 0,
  power: 0.55,
  drag: null,        // 'aim' | 'power' | 'fine'
  fineLastY: 0,
  predDirty: true,
  pred: null,        // { trails, firstContact }
  outcomes: null,    // { pot, scratch, next, win, lose }
};

const game = { group: null, shotPots: [], won: false, lost: false };

const BALL_COLORS = {
  0: "#f6f4ee",
  1: "#f3c43d", 2: "#1f59c4", 3: "#d33b30", 4: "#7b2d96",
  5: "#e07a1f", 6: "#1f8a4c", 7: "#8a2d2d", 8: "#16181c",
  9: "#f3c43d", 10: "#1f59c4", 11: "#d33b30", 12: "#7b2d96",
  13: "#e07a1f", 14: "#1f8a4c", 15: "#8a2d2d",
};
const isStriped = (n) => n >= 9 && n <= 15;

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

const RACK = [[1], [2, 9], [10, 8, 3], [4, 14, 11, 5], [6, 15, 13, 7, 12]];

function rack() {
  const r = TABLE.ballRadius;
  const list = [new Ball(W * 0.26, H / 2, 0)];
  const apexX = W * 0.6;
  const apexY = H / 2;
  const rowDx = 2 * r * Math.cos(Math.PI / 6) + 0.6;
  RACK.forEach((column, col) => {
    column.forEach((number, i) => {
      list.push(new Ball(apexX + col * rowDx, apexY + (i - col / 2) * (2 * r + 0.6), number));
    });
  });
  return list;
}

function pocketBalls() {
  for (const b of balls) {
    if (!b.active) continue;
    for (const p of pocketCenters()) {
      if (Vec.len(Vec.sub(b.pos, p)) < TABLE.pocketRadius) {
        if (b.number === 0) { b.pos = { x: W * 0.26, y: H / 2 }; b.vel = { x: 0, y: 0 }; }
        else { b.active = false; game.shotPots.push(b.number); }
        break;
      }
    }
  }
}

// --- 8-ball rules ----------------------------------------------------------

function remainingInGroup(group) {
  const lo = group === "solids" ? 1 : 9;
  const hi = group === "solids" ? 7 : 15;
  return balls.filter((b) => b.active && b.number >= lo && b.number <= hi).length;
}

function evaluateShot() {
  const pots = game.shotPots;
  const solids = pots.filter((n) => n >= 1 && n <= 7).length;
  const stripes = pots.filter((n) => n >= 9 && n <= 15).length;
  const eight = pots.includes(8);
  if (!game.group && !game.won && !game.lost) {
    if (solids && !stripes) game.group = "solids";
    else if (stripes && !solids) game.group = "stripes";
  }
  if (eight && !game.won && !game.lost) {
    if (game.group && remainingInGroup(game.group) === 0) game.won = true;
    else game.lost = true;
  }
  updateStatus();
}

function updateStatus() {
  let html, statusState;
  if (game.won) { html = "<b>You win!</b> &middot; 8-ball down &middot; press R to rack again"; statusState = "win"; }
  else if (game.lost) { html = "<b>Game over</b> &middot; 8-ball potted too early &middot; press R to rack again"; statusState = "lose"; }
  else if (!game.group) { html = "<b>Open table</b> &middot; pot any ball to choose your group"; statusState = "open"; }
  else {
    const left = remainingInGroup(game.group);
    const name = game.group === "solids" ? "Solids" : "Stripes";
    html = left > 0 ? `<b>${name}:</b> ${left} left &rarr; then 8-ball` : `<b>${name} cleared</b> &rarr; pot the 8-ball to win`;
    statusState = game.group;
  }
  statusEl.innerHTML = html;
  statusEl.dataset.state = statusState;
}

function newRack() {
  balls = rack();
  game.group = null;
  game.shotPots = [];
  game.won = false;
  game.lost = false;
  state.predDirty = true;
  state.outcomes = null;
  updateStatus();
  scheduleAdvisor();
}

// --- legality helpers ------------------------------------------------------

function legalNumberSet() {
  if (game.won || game.lost) return new Set();
  if (!game.group) return new Set([1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]);
  if (remainingInGroup(game.group) > 0)
    return new Set(game.group === "solids" ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15]);
  return new Set([8]);
}
function isLegalNumber(n) { return legalNumberSet().has(n); }
function legalTargets() { const s = legalNumberSet(); return balls.filter((b) => b.active && s.has(b.number)); }

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// --- geometry: blocked paths and clear-pot tests ---------------------------

function pathBlockedIn(list, from, to, ignore) {
  const seg = Vec.sub(to, from);
  const segLen = Vec.len(seg);
  if (segLen < 1e-6) return false;
  const dir = Vec.scale(seg, 1 / segLen);
  for (const b of list) {
    if (!b.active || ignore.includes(b.number)) continue;
    const t = Vec.dot(Vec.sub(b.pos, from), dir);
    if (t < -TABLE.ballRadius || t > segLen + TABLE.ballRadius) continue;
    const clampT = Math.max(0, Math.min(segLen, t));
    const closest = Vec.add(from, Vec.scale(dir, clampT));
    if (Vec.len(Vec.sub(b.pos, closest)) < 2 * TABLE.ballRadius - 1) return true;
  }
  return false;
}
function pathBlocked(from, to, ignore) { return pathBlockedIn(balls, from, to, ignore); }

// Does `cuePos` have a clean pot on `target` into pocket `pi`, given `list`?
function clearGeometry(cuePos, target, pi, list) {
  const P = pocketCenters()[pi];
  const T = target.pos;
  const dirTP = Vec.norm(Vec.sub(P, T));
  const ghost = Vec.sub(T, Vec.scale(dirTP, 2 * TABLE.ballRadius));
  const toGhost = Vec.sub(ghost, cuePos);
  if (Vec.len(toGhost) < 1) return false;
  if (Vec.dot(Vec.norm(toGhost), dirTP) < 0.3) return false; // too thin to count as "clear"
  if (pathBlockedIn(list, cuePos, ghost, [0, target.number])) return false;
  if (pathBlockedIn(list, T, P, [0, target.number])) return false;
  return true;
}

// Is there any legal clear pot on a resting table?
function hasClearPot(list) {
  const cue = list.find((b) => b.number === 0);
  if (!cue) return false;
  const legal = legalNumberSet();
  for (const b of list) {
    if (b.number === 0 || !legal.has(b.number)) continue;
    for (let pi = 0; pi < 6; pi++) if (clearGeometry(cue.pos, b, pi, list)) return true;
  }
  return false;
}

// --- shot advisor (ranked options) -----------------------------------------

function clamp1(x) { return Math.max(-1, Math.min(1, x)); }
function ghostPoint(ballPos, towardPos) {
  return Vec.sub(ballPos, Vec.scale(Vec.norm(Vec.sub(towardPos, ballPos)), 2 * TABLE.ballRadius));
}

// Direct pot: cue strikes the target, target rolls straight to the pocket.
function evaluateCandidate(target, pi) {
  const cue = balls[0];
  const P = pocketCenters()[pi];
  const T = target.pos;
  const dirTP = Vec.norm(Vec.sub(P, T));
  const ghost = ghostPoint(T, P);
  const toGhost = Vec.sub(ghost, cue.pos);
  const distCue = Vec.len(toGhost);
  if (distCue < 1) return null;
  const aimDir = Vec.scale(toGhost, 1 / distCue);
  const dot = Vec.dot(aimDir, dirTP);
  if (dot < 0.21) return null;
  if (pathBlocked(cue.pos, ghost, [0, target.number])) return null;
  if (pathBlocked(T, P, [0, target.number])) return null;
  return {
    type: "direct",
    number: target.number,
    pocketIndex: pi,
    aimAngle: Math.atan2(aimDir.y, aimDir.x),
    cutDeg: Math.acos(clamp1(dot)) * 180 / Math.PI,
    dist: distCue + Vec.len(Vec.sub(P, T)),
  };
}

// Cushions seen by a ball *centre* (inset by the ball radius).
const CUSHIONS = [
  { axis: "y", at: () => bounds.top + TABLE.ballRadius, name: "top rail" },
  { axis: "y", at: () => bounds.bottom - TABLE.ballRadius, name: "bottom rail" },
  { axis: "x", at: () => bounds.left + TABLE.ballRadius, name: "left rail" },
  { axis: "x", at: () => bounds.right - TABLE.ballRadius, name: "right rail" },
];
function mirror(P, cu) {
  const a = cu.at();
  return cu.axis === "y" ? { x: P.x, y: 2 * a - P.y } : { x: 2 * a - P.x, y: P.y };
}
function bankPoint(T, Pm, cu) {
  const a = cu.at();
  if (cu.axis === "y") {
    const d = Pm.y - T.y; if (Math.abs(d) < 1e-6) return null;
    const t = (a - T.y) / d; if (t <= 0 || t >= 1) return null;
    const x = T.x + t * (Pm.x - T.x);
    if (x < bounds.left + TABLE.ballRadius || x > bounds.right - TABLE.ballRadius) return null;
    return { x, y: a };
  }
  const d = Pm.x - T.x; if (Math.abs(d) < 1e-6) return null;
  const t = (a - T.x) / d; if (t <= 0 || t >= 1) return null;
  const y = T.y + t * (Pm.y - T.y);
  if (y < bounds.top + TABLE.ballRadius || y > bounds.bottom - TABLE.ballRadius) return null;
  return { x: a, y };
}

// Bank pot: target rebounds off one cushion into the pocket. Aiming the target
// at the pocket mirrored across that cushion produces the bank (cushions are
// perfectly elastic here, so the mirror image is exact).
function evaluateBank(target, pi, cu) {
  const cue = balls[0];
  const P = pocketCenters()[pi];
  const T = target.pos;
  const Pm = mirror(P, cu);
  const bp = bankPoint(T, Pm, cu);
  if (!bp) return null;
  const dirTPm = Vec.norm(Vec.sub(Pm, T));
  const ghost = ghostPoint(T, Pm);
  const toGhost = Vec.sub(ghost, cue.pos);
  const distCue = Vec.len(toGhost);
  if (distCue < 1) return null;
  const aimDir = Vec.scale(toGhost, 1 / distCue);
  const dot = Vec.dot(aimDir, dirTPm);
  if (dot < 0.25) return null;
  if (pathBlocked(cue.pos, ghost, [0, target.number])) return null;
  if (pathBlocked(T, bp, [0, target.number])) return null;
  if (pathBlocked(bp, P, [0, target.number])) return null;
  return {
    type: "bank",
    number: target.number,
    pocketIndex: pi,
    cushion: cu.name,
    aimAngle: Math.atan2(aimDir.y, aimDir.x),
    cutDeg: Math.acos(clamp1(dot)) * 180 / Math.PI,
    dist: distCue + Vec.len(Vec.sub(bp, T)) + Vec.len(Vec.sub(P, bp)),
  };
}

// Combination: cue strikes ball A, which strikes target B into the pocket.
function evaluateCombo(B, A, pi) {
  const cue = balls[0];
  const P = pocketCenters()[pi];
  const ghostB = ghostPoint(B.pos, P);                    // where A must hit B
  const dirAB = Vec.norm(Vec.sub(ghostB, A.pos));
  const ghostA = Vec.sub(A.pos, Vec.scale(dirAB, 2 * TABLE.ballRadius)); // where cue hits A
  const toGhostA = Vec.sub(ghostA, cue.pos);
  const distCue = Vec.len(toGhostA);
  if (distCue < 1) return null;
  const aimDir = Vec.scale(toGhostA, 1 / distCue);
  const cutCueA = Vec.dot(aimDir, dirAB);
  const cutAB = Vec.dot(dirAB, Vec.norm(Vec.sub(P, B.pos)));
  if (cutCueA < 0.3 || cutAB < 0.3) return null;
  if (pathBlocked(cue.pos, ghostA, [0, A.number])) return null;
  if (pathBlocked(A.pos, ghostB, [A.number, B.number])) return null;
  if (pathBlocked(B.pos, P, [A.number, B.number])) return null;
  return {
    type: "combo",
    number: B.number,
    via: A.number,
    pocketIndex: pi,
    aimAngle: Math.atan2(aimDir.y, aimDir.x),
    cutDeg: Math.acos(clamp1(Math.min(cutCueA, cutAB))) * 180 / Math.PI,
    dist: distCue + Vec.len(Vec.sub(ghostB, A.pos)) + Vec.len(Vec.sub(P, B.pos)),
  };
}

// Cue-ball kick: the cue rebounds off one cushion, then strikes the target,
// which rolls to the pocket. Mirror the target's ghost across the cushion and
// aim the cue there; the straight line bends at the rail to reach the ghost.
function evaluateKick(target, pi, cu) {
  const cue = balls[0];
  const P = pocketCenters()[pi];
  const T = target.pos;
  const ghostT = ghostPoint(T, P);             // where the cue must arrive to pot T
  const ghostTm = mirror(ghostT, cu);          // reflect that arrival point across the rail
  const bp = bankPoint(cue.pos, ghostTm, cu);  // where the cue meets the cushion
  if (!bp) return null;
  const reflectedDir = Vec.norm(Vec.sub(ghostT, bp)); // cue's path after the bounce
  const dirTP = Vec.norm(Vec.sub(P, T));
  if (Vec.dot(reflectedDir, dirTP) < 0.25) return null; // wrong side / too thin
  const toAim = Vec.sub(ghostTm, cue.pos);
  const distCue = Vec.len(toAim);
  if (distCue < 1) return null;
  if (pathBlocked(cue.pos, bp, [0, target.number])) return null;
  if (pathBlocked(bp, ghostT, [0, target.number])) return null;
  if (pathBlocked(T, P, [0, target.number])) return null;
  return {
    type: "kick",
    number: target.number,
    pocketIndex: pi,
    cushion: cu.name,
    aimAngle: Math.atan2(toAim.y, toAim.x),
    cutDeg: Math.acos(clamp1(Vec.dot(reflectedDir, dirTP))) * 180 / Math.PI,
    dist: Vec.len(Vec.sub(bp, cue.pos)) + Vec.len(Vec.sub(ghostT, bp)) + Vec.len(Vec.sub(P, T)),
  };
}

function typePenalty(type) {
  return type === "direct" ? 0 : type === "bank" ? 16 : type === "kick" ? 20 : 22;
}
function heuristic(c) { return c.cutDeg + c.dist * 0.05 + typePenalty(c.type); }

// Confirm a candidate by simulating it; require the right ball to drop into the
// intended pocket, and the first contact to be the right ball (A for combos).
function validateShot(c) {
  const diag = Math.hypot(W, H);
  let best = null;
  for (const p of [0.55, 0.85]) {
    const sp = p * MAX_SPEED;
    const { trails, firstContact } = simulateShot(balls, bounds,
      { x: Math.cos(c.aimAngle) * sp, y: Math.sin(c.aimAngle) * sp }, 900);
    const tt = trails.find((t) => t.number === c.number);
    const cueT = trails.find((t) => t.number === 0);
    const intoPocket = tt && tt.pocketed &&
      Vec.len(Vec.sub(tt.rest, pocketCenters()[c.pocketIndex])) < TABLE.pocketRadius + 3;
    if (!intoPocket) continue;
    const wantFirst = c.type === "combo" ? c.via : c.number;
    if (firstContact && firstContact.ball !== wantFirst) continue;
    const scratch = !!(cueT && cueT.pocketed);
    const difficulty = (c.cutDeg / 90) * 55 + (c.dist / diag) * 30 + (scratch ? 40 : 0) + p * 8 + typePenalty(c.type);
    if (!best || difficulty < best.difficulty) {
      best = { ...c, power: p, scratch, difficulty, quality: Math.max(5, Math.round(100 - difficulty)) };
    }
  }
  return best;
}

function computeRecommendations() {
  if (!allStopped(balls)) return;
  const legal = legalTargets();
  const legalSet = legalNumberSet();
  const cands = [];

  for (const t of legal) for (let pi = 0; pi < 6; pi++) { const c = evaluateCandidate(t, pi); if (c) cands.push(c); }
  for (const t of legal) for (let pi = 0; pi < 6; pi++) for (const cu of CUSHIONS) { const c = evaluateBank(t, pi, cu); if (c) cands.push(c); }
  for (const t of legal) for (let pi = 0; pi < 6; pi++) for (const cu of CUSHIONS) { const c = evaluateKick(t, pi, cu); if (c) cands.push(c); }
  for (const B of legal) for (const A of balls) {
    if (!A.active || A.number === 0 || A.number === B.number || !legalSet.has(A.number)) continue;
    for (let pi = 0; pi < 6; pi++) { const c = evaluateCombo(B, A, pi); if (c) cands.push(c); }
  }

  // Simulate a promising shortlist, guaranteeing each shot type a few tries.
  const byType = (t) => cands.filter((c) => c.type === t).sort((a, b) => heuristic(a) - heuristic(b));
  const shortlist = [
    ...byType("direct").slice(0, 7),
    ...byType("bank").slice(0, 4),
    ...byType("kick").slice(0, 4),
    ...byType("combo").slice(0, 4),
  ];

  const out = [];
  const seen = new Set();
  for (const c of shortlist) {
    const s = validateShot(c);
    if (!s) continue;
    const key = `${s.type}-${s.number}-${s.pocketIndex}-${s.via || ""}-${s.cushion || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  out.sort((a, b) => a.difficulty - b.difficulty);
  advisor.list = out.slice(0, 5);
  renderShotList();
}
function scheduleAdvisor() { setTimeout(computeRecommendations, 0); }

function difficultyLabel(s) { return s.quality >= 72 ? "Easy" : s.quality >= 48 ? "Medium" : "Hard"; }

function shotLabel(s) {
  const base = `${s.number}-ball &rarr; ${POCKET_NAMES[s.pocketIndex]}`;
  if (s.type === "bank") return `${base} <span class="tag bank">bank off ${s.cushion}</span>`;
  if (s.type === "kick") return `${base} <span class="tag kick">kick off ${s.cushion}</span>`;
  if (s.type === "combo") return `${base} <span class="tag combo">combo via ${s.via}</span>`;
  return base;
}

function reasonFor(s) {
  const range = s.dist > Math.hypot(W, H) * 0.6 ? "long range" : "short range";
  const cue = s.scratch ? "cue may scratch — use soft pace" : "clear path, safe cue position";
  if (s.type === "bank") return `bank shot off the ${s.cushion}, ${range}; ${cue}`;
  if (s.type === "kick") return `cue kicks off the ${s.cushion} to reach it, ${range}; ${cue}`;
  if (s.type === "combo") return `combination through the ${s.via}-ball, ${range}; ${cue}`;
  const cut = s.cutDeg < 8 ? "straight pot" : s.cutDeg < 25 ? "gentle cut" : s.cutDeg < 45 ? "moderate cut" : "thin cut";
  return `${cut}, ${range}; ${cue}`;
}

function renderShotList() {
  if (!shotListEl) return;
  if (game.won || game.lost) { shotListEl.innerHTML = `<p class="muted">Game over — press R to rack again.</p>`; return; }
  if (!advisor.list.length) { shotListEl.innerHTML = `<p class="muted">No clear pot, bank, or combo — play safe or break up a cluster.</p>`; return; }
  const best = advisor.list[0];
  let html = `<div class="best">
      <div class="best-line"><span class="rankdot">1</span> ${shotLabel(best)}</div>
      <div class="best-meta"><span>Difficulty: <b>${difficultyLabel(best)}</b></span><span>Success: <b>${best.quality}%</b></span></div>
      <div class="best-reason">${reasonFor(best)}</div>
    </div>`;
  if (advisor.list.length > 1) {
    html += `<ol class="rank" start="2">` + advisor.list.slice(1).map((s) =>
      `<li>${shotLabel(s)} <span class="meta">${difficultyLabel(s)} &middot; ${s.quality}%</span></li>`
    ).join("") + `</ol>`;
  }
  shotListEl.innerHTML = html;
}

// --- "future" outcomes: Monte-Carlo over jittered aim & power ---------------

function buildRestTable(trails) {
  return trails.filter((t) => !t.pocketed).map((t) => ({ pos: { x: t.rest.x, y: t.rest.y }, number: t.number, active: true }));
}

function predictOutcomes(aimAngle, power, samples) {
  samples = samples || 28;
  let pot = 0, scratch = 0, next = 0, win = 0, lose = 0;
  for (let s = 0; s < samples; s++) {
    const a = aimAngle + (Math.random() - 0.5) * 0.016;            // ~±0.5 deg of aim wobble
    const p = Math.max(0.05, power + (Math.random() - 0.5) * 0.06);
    const speed = p * MAX_SPEED;
    const { trails } = simulateShot(balls, bounds, { x: Math.cos(a) * speed, y: Math.sin(a) * speed }, 900);
    const cueT = trails.find((t) => t.number === 0);
    const cueScratched = !!(cueT && cueT.pocketed);
    const pottedLegal = trails.some((t) => t.pocketed && t.number !== 0 && isLegalNumber(t.number));
    const potted8 = trails.some((t) => t.pocketed && t.number === 8);
    if (cueScratched) scratch++;
    if (pottedLegal && !cueScratched) pot++;
    if (potted8) { if (isLegalNumber(8) && !cueScratched) win++; else lose++; }
    if (!cueScratched && !potted8 && hasClearPot(buildRestTable(trails))) next++;
  }
  const pct = (n) => Math.round((n / samples) * 100);
  return { pot: pct(pot), scratch: pct(scratch), next: pct(next), win: pct(win), lose: pct(lose) };
}

let outcomesTimer = null;
function scheduleOutcomes() {
  if (outcomesTimer) clearTimeout(outcomesTimer);
  outcomesTimer = setTimeout(() => {
    if (!allStopped(balls) || game.won || game.lost) { state.outcomes = null; renderOutcomes(null); return; }
    state.outcomes = predictOutcomes(state.aimAngle, state.power);
    renderOutcomes(state.outcomes);
  }, 140);
}

function renderOutcomes(o) {
  if (!shotStatsEl) return;
  if (!o) { shotStatsEl.innerHTML = `<p class="muted">Aim a shot to forecast its future.</p>`; return; }
  const bar = (label, val, cls) =>
    `<div class="stat ${cls}"><span class="stat-l">${label}</span>
       <span class="stat-bar"><i style="width:${val}%"></i></span>
       <b class="stat-v">${val}%</b></div>`;
  let html = bar("Pot", o.pot, "good") + bar("Scratch", o.scratch, "bad") + bar("Next shot", o.next, "neutral");
  if (o.win) html += bar("Win (8-ball)", o.win, "good");
  if (o.lose) html += bar("Lose (early 8)", o.lose, "bad");
  shotStatsEl.innerHTML = html;
}

// --- current-shot explanation ("why") --------------------------------------

function renderTips(tips) {
  if (!shotTipsEl) return;
  shotTipsEl.innerHTML = tips.length ? tips.map((t) => `<li>${t}</li>`).join("") : "<li>Aim to see feedback on your shot.</li>";
}

function currentShotTips() {
  if (!shotTipsEl) return;
  if (game.won || game.lost) { renderTips(["Game over — press R to rack again."]); return; }
  const trails = state.pred && state.pred.trails;
  if (!trails) { renderTips([]); return; }

  const tips = [];
  const cueT = trails.find((t) => t.number === 0);
  const scratch = !!(cueT && cueT.pocketed);
  const potted = trails.filter((t) => t.pocketed && t.number !== 0);
  const good = potted.filter((t) => isLegalNumber(t.number)).map((t) => t.number);
  const bad8 = potted.some((t) => t.number === 8) && !isLegalNumber(8);

  if (scratch) tips.push("This line scratches the cue ball — lower the power or change the angle.");
  if (bad8) tips.push("This pots the 8-ball early, which loses the game.");
  if (good.length) tips.push(`This pots the ${good.join(", ")}.`);

  if (advisor.list.length) {
    let nearest = null, nd = Infinity;
    for (const s of advisor.list) {
      const d = angDiff(s.aimAngle, state.aimAngle);
      if (Math.abs(d) < nd) { nd = Math.abs(d); nearest = { s, d }; }
    }
    const degs = nearest.d * 180 / Math.PI;
    if (Math.abs(degs) > 1.2) {
      tips.push(`Rotate about ${Math.abs(degs).toFixed(1)}° ${degs > 0 ? "clockwise" : "counter-clockwise"} for the ${nearest.s.number}-ball (${POCKET_NAMES[nearest.s.pocketIndex]}).`);
    } else {
      if (!good.length && !scratch) tips.push(`Lined up on the ${nearest.s.number}-ball — fine-tune with the right dial.`);
      const pd = state.power - nearest.s.power;
      if (pd > 0.12) tips.push("Ease off the power for better cue control.");
      else if (pd < -0.12) tips.push("Add a touch more power so it reaches.");
    }
  }
  if (!tips.length) tips.push("No legal pot on this line — try a different angle.");
  renderTips(tips.slice(0, 3));
}

// --- control geometry ------------------------------------------------------

const POWER = { x: 16, w: 14 };
function powerRect() { return { x: POWER.x, w: POWER.w, y0: bounds.top + 12, y1: bounds.bottom - 12 }; }
function inPower(p) { const r = powerRect(); return p.x >= r.x - 8 && p.x <= r.x + r.w + 8 && p.y >= r.y0 - 10 && p.y <= r.y1 + 10; }
function fineDial() { const cx = W - TABLE.margin / 2; return { cx, cy: H / 2, y0: bounds.top + 12, y1: bounds.bottom - 12 }; }
function inFine(p) { const d = fineDial(); return Math.abs(p.x - d.cx) < 16 && p.y >= d.y0 - 10 && p.y <= d.y1 + 10; }

// --- table -----------------------------------------------------------------

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function diamond(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = "rgba(232,226,200,0.85)";
  ctx.fillRect(-3, -3, 6, 6);
  ctx.restore();
}

function drawDiamonds() {
  const b = bounds, m = TABLE.margin / 2;
  const w = b.right - b.left, h = b.bottom - b.top;
  for (let i = 1; i <= 7; i++) { if (i === 4) continue; const x = b.left + (w * i) / 8; diamond(x, m); diamond(x, H - m); }
  for (let i = 1; i <= 3; i++) { const y = b.top + (h * i) / 4; diamond(m, y); diamond(W - m, y); }
}

function drawPockets() {
  const rr = TABLE.pocketMouth; // visible opening (capture radius is larger)
  for (const p of pocketCenters()) {
    const jaw = ctx.createRadialGradient(p.x, p.y, rr * 0.4, p.x, p.y, rr + 7);
    jaw.addColorStop(0, "rgba(3,16,10,0.95)");
    jaw.addColorStop(0.7, "rgba(5,20,13,0.5)");
    jaw.addColorStop(1, "rgba(5,20,13,0)");
    ctx.beginPath(); ctx.arc(p.x, p.y, rr + 7, 0, Math.PI * 2); ctx.fillStyle = jaw; ctx.fill();

    const mouth = ctx.createRadialGradient(p.x - rr * 0.3, p.y - rr * 0.3, 1, p.x, p.y, rr);
    mouth.addColorStop(0, "#232824");
    mouth.addColorStop(0.6, "#0c110d");
    mouth.addColorStop(1, "#020604");
    ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.fillStyle = mouth; ctx.fill();

    ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1; ctx.stroke();
  }
}

function drawTable() {
  const rail = ctx.createLinearGradient(0, 0, 0, H);
  rail.addColorStop(0, "#1e5763");
  rail.addColorStop(1, "#0f343c");
  roundRect(0, 0, W, H, 22); ctx.fillStyle = rail; ctx.fill();
  roundRect(8, 8, W - 16, H - 16, 16); ctx.fillStyle = "#0c2a31"; ctx.fill();

  const fx = bounds.left, fy = bounds.top;
  const fw = bounds.right - bounds.left, fh = bounds.bottom - bounds.top;
  const felt = ctx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, Math.max(fw, fh) * 0.8);
  felt.addColorStop(0, "#1aa45a");
  felt.addColorStop(1, "#0b6536");
  roundRect(fx, fy, fw, fh, 7); ctx.fillStyle = felt; ctx.fill();

  ctx.save();
  roundRect(fx, fy, fw, fh, 7); ctx.clip();
  for (let k = 0; k < 3; k++) {
    roundRect(fx + k, fy + k, fw - 2 * k, fh - 2 * k, 7);
    ctx.strokeStyle = `rgba(0,0,0,${0.16 - k * 0.05})`;
    ctx.lineWidth = 9 - k * 3;
    ctx.stroke();
  }
  ctx.restore();

  drawDiamonds();
  drawPockets();
}

// --- balls -----------------------------------------------------------------

function fillCircle(x, y, r, color) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }

function ballBody(x, y, number, r) {
  if (isStriped(number)) {
    fillCircle(x, y, r, "#f4f0e6");
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = BALL_COLORS[number];
    ctx.fillRect(x - r, y - r * 0.6, r * 2, r * 1.2);
    ctx.restore();
  } else {
    fillCircle(x, y, r, BALL_COLORS[number]);
  }
}

function drawBall(b) {
  const { x, y } = b.pos;
  const r = TABLE.ballRadius;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x + 1.5, y + 3, r * 1.02, r * 0.85, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fill();
  ctx.restore();

  ballBody(x, y, b.number, r);

  if (b.number > 0) {
    fillCircle(x, y, r * 0.5, "#fcfbf6");
    ctx.fillStyle = "#15171b";
    ctx.font = `bold ${Math.round(r * 0.66)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(b.number), x, y + 0.5);
  }

  const g = ctx.createRadialGradient(x - r * 0.38, y - r * 0.42, r * 0.1, x, y, r);
  g.addColorStop(0, "rgba(255,255,255,0.6)");
  g.addColorStop(0.4, "rgba(255,255,255,0.08)");
  g.addColorStop(1, "rgba(0,0,0,0.22)");
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,0.28)"; ctx.stroke();
}

// Translucent "future" ball at a predicted resting position.
function drawGhostBall(pos, number) {
  const r = TABLE.ballRadius;
  ctx.save();
  ctx.globalAlpha = 0.34;
  ballBody(pos.x, pos.y, number, r);
  ctx.restore();
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 1.3; ctx.stroke();
  ctx.restore();
}

// --- prediction overlay ----------------------------------------------------

function shotVelocity() {
  const speed = Math.max(0.06, state.power) * MAX_SPEED;
  return { x: Math.cos(state.aimAngle) * speed, y: Math.sin(state.aimAngle) * speed };
}

function ensurePrediction() {
  if (state.predDirty) {
    state.pred = simulateShot(balls, bounds, shotVelocity());
    state.predDirty = false;
    currentShotTips();
    scheduleOutcomes();
  }
}

function strokePath(points, rgba, width, dash) {
  if (!points || points.length < 2) return;
  ctx.beginPath();
  ctx.setLineDash(dash || []);
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.strokeStyle = rgba;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.setLineDash([]);
}

function arrowHead(at, dir, color, size) {
  const a = Math.atan2(dir.y, dir.x);
  size = size || 7;
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(a);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, -size * 0.6);
  ctx.lineTo(-size, size * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function endArrow(points, color) {
  if (!points || points.length < 2) return;
  const a = points[points.length - 1], b = points[points.length - 2];
  arrowHead(a, Vec.sub(a, b), color, 8);
}

function splitAt(points, contact) {
  if (!contact) return { pre: points, post: [] };
  let bi = 0, bd = Infinity;
  points.forEach((p, i) => { const d = Math.hypot(p.x - contact.x, p.y - contact.y); if (d < bd) { bd = d; bi = i; } });
  return { pre: points.slice(0, bi + 1).concat([{ x: contact.x, y: contact.y }]), post: points.slice(bi) };
}

function ghostCircle(pt) {
  ctx.beginPath(); ctx.arc(pt.x, pt.y, TABLE.ballRadius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,80,80,0.95)"; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,80,80,0.95)"; ctx.fill();
}

function pocketIndexAt(pos) {
  const ps = pocketCenters();
  for (let i = 0; i < ps.length; i++) if (Vec.len(Vec.sub(pos, ps[i])) < TABLE.pocketRadius + 4) return i;
  return -1;
}

function highlightPocket(i) {
  if (i < 0) return;
  const p = pocketCenters()[i];
  ctx.beginPath(); ctx.arc(p.x, p.y, TABLE.pocketRadius + 7, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(74,222,128,0.35)"; ctx.lineWidth = 7; ctx.stroke();
  ctx.beginPath(); ctx.arc(p.x, p.y, TABLE.pocketRadius + 3, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(74,222,128,0.95)"; ctx.lineWidth = 2.5; ctx.stroke();
}

// Play view: one clean predicted shot + ghost rests of the involved balls.
function drawPredictionPlay() {
  const pred = state.pred;
  if (!pred) return;
  const { trails, firstContact } = pred;
  const cueT = trails.find((t) => t.number === 0);
  if (!cueT) return;

  if (firstContact) {
    const { pre, post } = splitAt(cueT.points, firstContact);
    strokePath(post, "rgba(255,255,255,0.16)", 1.6, [5, 6]);      // faint cue-after path
    strokePath(pre, "rgba(255,255,255,0.95)", 2.6);               // bright cue-to-contact
    endArrow(pre, "rgba(255,255,255,0.95)");

    const tt = trails.find((t) => t.number === firstContact.ball);
    if (tt && tt.moved) {
      strokePath(tt.points, "rgba(243,210,70,0.95)", 2.4);        // target path
      endArrow(tt.points, "rgba(243,210,70,0.95)");
      if (tt.pocketed) highlightPocket(pocketIndexAt(tt.rest));
      else drawGhostBall(tt.rest, tt.number);
    }
    if (!cueT.pocketed) drawGhostBall(cueT.rest, 0);              // ghost cue rest
    ghostCircle(firstContact);
  } else {
    strokePath(cueT.points, "rgba(255,255,255,0.9)", 2.4);
    endArrow(cueT.points, "rgba(255,255,255,0.9)");
    if (!cueT.pocketed) drawGhostBall(cueT.rest, 0);
  }
}

// Assist view: every ball's path with confidence styling + stop markers.
function drawPredictionAssist() {
  const pred = state.pred;
  if (!pred) return;
  const { trails, firstContact } = pred;
  for (const t of trails) {
    const isCue = t.number === 0;
    if (!isCue && !t.moved) continue;
    const rgb = isCue ? "255,255,255" : hexRgb(BALL_COLORS[t.number]);
    const primary = isCue || (firstContact && t.number === firstContact.ball);
    strokePath(t.points, `rgba(${rgb},${primary ? 0.85 : 0.38})`, primary ? 2.2 : 1.6, primary ? [] : [5, 6]);
    if (t.pocketed) {
      const p = t.rest;
      ctx.strokeStyle = `rgba(${rgb},0.95)`; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x - 4, p.y - 4); ctx.lineTo(p.x + 4, p.y + 4);
      ctx.moveTo(p.x + 4, p.y - 4); ctx.lineTo(p.x - 4, p.y + 4);
      ctx.stroke();
    } else {
      drawGhostBall(t.rest, t.number);
    }
  }
  if (firstContact) ghostCircle(firstContact);
}

function drawAdvisorBadges(onlyTop) {
  const list = onlyTop ? advisor.list.slice(0, 1) : advisor.list;
  list.forEach((s, i) => {
    const b = balls.find((x) => x.active && x.number === s.number);
    if (!b) return;
    const bx = b.pos.x, by = b.pos.y - TABLE.ballRadius - 10;
    ctx.beginPath(); ctx.arc(bx, by, 8, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? "rgba(243,196,61,0.95)" : "rgba(16,24,30,0.9)"; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.stroke();
    ctx.fillStyle = i === 0 ? "#1a1a1a" : "#fff";
    ctx.font = "bold 10px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(onlyTop ? 1 : i + 1), bx, by + 0.5);
  });
}

function drawTargetGlow(number, color) {
  const b = balls.find((x) => x.active && x.number === number);
  if (!b) return;
  ctx.beginPath(); ctx.arc(b.pos.x, b.pos.y, TABLE.ballRadius + 4, 0, Math.PI * 2);
  ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
}

function drawAimRing() {
  const cue = balls[0];
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.beginPath(); ctx.arc(cue.pos.x, cue.pos.y, TABLE.ballRadius + 9, 0, Math.PI * 2);
  ctx.strokeStyle = state.drag === "aim" ? "rgba(76,194,255,0.85)" : "rgba(255,255,255,0.32)";
  ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
}

function drawCueStick() {
  const cue = balls[0];
  const aim = { x: Math.cos(state.aimAngle), y: Math.sin(state.aimAngle) };
  const back = Vec.scale(aim, -1);
  const gap = TABLE.ballRadius + 10 + state.power * 46;
  const tip = Vec.add(cue.pos, Vec.scale(back, gap));
  const butt = Vec.add(tip, Vec.scale(back, 200));
  const g = ctx.createLinearGradient(tip.x, tip.y, butt.x, butt.y);
  g.addColorStop(0.0, "#e9e2cf");
  g.addColorStop(0.05, "#2a2a2a");
  g.addColorStop(0.1, "#d2ab5e");
  g.addColorStop(1.0, "#5a3a1a");
  ctx.save();
  ctx.lineCap = "round"; ctx.strokeStyle = g; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(butt.x, butt.y); ctx.stroke();
  ctx.restore();
}

function drawPowerMeter() {
  const r = powerRect();
  const h = r.y1 - r.y0;
  const g = ctx.createLinearGradient(0, r.y1, 0, r.y0);
  g.addColorStop(0.0, "#e07a1f");
  g.addColorStop(0.5, "#f3c43d");
  g.addColorStop(1.0, "#d33b30");
  roundRect(r.x, r.y0, r.w, h, 6); ctx.fillStyle = g; ctx.fill();
  if (state.power < 1) {
    roundRect(r.x, r.y0, r.w, h * (1 - state.power), 6);
    ctx.fillStyle = "rgba(8,20,16,0.62)"; ctx.fill();
  }
  const ky = r.y1 - state.power * h;
  ctx.fillStyle = state.drag === "power" ? "#4cc2ff" : "#ffffff";
  roundRect(r.x - 3, ky - 3, r.w + 6, 6, 3); ctx.fill();
}

function line(from, to, color, width) {
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = color; ctx.lineWidth = width || 2; ctx.stroke();
}

function drawFineDial() {
  const d = fineDial();
  line({ x: d.cx, y: d.y0 }, { x: d.cx, y: d.y1 }, "rgba(255,255,255,0.18)", 2);
  ctx.beginPath(); ctx.arc(d.cx, d.cy, 11, 0, Math.PI * 2);
  ctx.fillStyle = state.drag === "fine" ? "rgba(76,194,255,0.95)" : "rgba(255,255,255,0.85)"; ctx.fill();
  ctx.strokeStyle = "#0d2c33"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(d.cx - 4, d.cy - 2); ctx.lineTo(d.cx, d.cy - 6); ctx.lineTo(d.cx + 4, d.cy - 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(d.cx - 4, d.cy + 2); ctx.lineTo(d.cx, d.cy + 6); ctx.lineTo(d.cx + 4, d.cy + 2); ctx.stroke();
}

// --- loop & input ----------------------------------------------------------

function render() {
  ctx.clearRect(0, 0, W, H);
  drawTable();

  const moving = !allStopped(balls);
  const assist = isAssist();

  if (!moving) {
    ensurePrediction();
    if (assist) drawPredictionAssist();
    else drawPredictionPlay();
  }

  for (const b of balls) if (b.active) drawBall(b);

  if (!moving) {
    if (advisor.list.length) drawTargetGlow(advisor.list[0].number, "rgba(243,196,61,0.9)");
    if (state.pred && state.pred.firstContact) drawTargetGlow(state.pred.firstContact.ball, "rgba(255,255,255,0.5)");
    drawAdvisorBadges(!assist);
    drawAimRing();
    drawCueStick();
    drawPowerMeter();
    drawFineDial();
  }
}

function frame() {
  const moving = !allStopped(balls);
  if (moving) {
    stepPhysics(balls, bounds);
    pocketBalls();
  } else if (wasMoving) {
    state.predDirty = true;
    evaluateShot();
    scheduleAdvisor();
  }
  wasMoving = moving;
  render();
  requestAnimationFrame(frame);
}

function toCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left) * (W / rect.width), y: (e.clientY - rect.top) * (H / rect.height) };
}

function setPowerFromY(y) {
  const r = powerRect();
  state.power = Math.max(0, Math.min(1, (r.y1 - y) / (r.y1 - r.y0)));
  state.predDirty = true;
}

function shoot() {
  if (game.won || game.lost) return;
  game.shotPots = [];
  balls[0].vel = shotVelocity();
  state.predDirty = true;
}

canvas.addEventListener("pointerdown", (e) => {
  if (!allStopped(balls)) return;
  const p = toCanvas(e);
  if (inPower(p)) { state.drag = "power"; setPowerFromY(p.y); }
  else if (inFine(p)) { state.drag = "fine"; state.fineLastY = p.y; }
  else {
    state.drag = "aim";
    const cue = balls[0];
    state.aimAngle = Math.atan2(p.y - cue.pos.y, p.x - cue.pos.x);
    state.predDirty = true;
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (!state.drag) return;
  const p = toCanvas(e);
  if (state.drag === "aim") {
    const cue = balls[0];
    state.aimAngle = Math.atan2(p.y - cue.pos.y, p.x - cue.pos.x);
    state.predDirty = true;
  } else if (state.drag === "power") {
    setPowerFromY(p.y);
  } else if (state.drag === "fine") {
    state.aimAngle += (p.y - state.fineLastY) * FINE_SENSITIVITY;
    state.fineLastY = p.y;
    state.predDirty = true;
  }
});

window.addEventListener("pointerup", () => {
  if (state.drag === "power") shoot();
  state.drag = null;
});

window.addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") newRack();
  else if (e.code === "Space") { e.preventDefault(); if (allStopped(balls)) shoot(); }
});

ui.reset.addEventListener("click", newRack);

newRack();
requestAnimationFrame(frame);
