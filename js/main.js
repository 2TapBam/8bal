"use strict";

// ---------------------------------------------------------------------------
// main.js — rendering, input, and the game loop.
//
// Controls (8-ball-pool style):
//   - Aim:   drag anywhere on the felt to point the line.
//   - Power: drag the slider on the LEFT rail; release to shoot.
//   - Fine:  drag the dial on the RIGHT rail for tiny aim adjustments.
//   - Space shoots at the current power; R re-racks.
//
// The aim guide is a full-shot preview: it simulates the entire shot and draws
// where the cue ball stops and where every ball it hits stops.
// Still a self-contained sandbox; nothing connects to any external game.
// ---------------------------------------------------------------------------

const canvas = document.getElementById("table");
const ctx = canvas.getContext("2d");
const bounds = playfield();

const W = TABLE.width;
const H = TABLE.height;

// Crisp rendering on high-DPI screens.
const dpr = Math.max(1, Math.min(3, Math.floor(window.devicePixelRatio || 1)));
canvas.width = W * dpr;
canvas.height = H * dpr;
ctx.scale(dpr, dpr);

const MAX_SPEED = 19;        // cue-ball speed at full power
const FINE_SENSITIVITY = 0.0015; // radians of aim change per pixel of dial drag

const ui = {
  showGuides: document.getElementById("showGuides"),
  showStops: document.getElementById("showStops"),
  reset: document.getElementById("reset"),
};
const statusEl = document.getElementById("status");
const shotListEl = document.getElementById("shotList");
const shotTipsEl = document.getElementById("shotTips");
const POCKET_NAMES = ["top-left", "top-middle", "top-right", "bottom-left", "bottom-middle", "bottom-right"];
const advisor = { list: [] };

let balls = [];
let wasMoving = false;

const state = {
  aimAngle: 0,     // radians; 0 points toward the rack
  power: 0.55,     // 0..1
  drag: null,      // 'aim' | 'power' | 'fine'
  fineLastY: 0,
  predDirty: true,
  pred: null,
};

// 8-ball rules state. `group` is claimed on the first clean pot; `shotPots`
// collects the balls sunk during the shot in progress.
const game = {
  group: null,     // null (open) | 'solids' | 'stripes'
  shotPots: [],
  won: false,
  lost: false,
};

// Authentic-ish 8-ball colours: 1-7 solids, 8 black, 9-15 stripes, 0 = cue.
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

// A standard-looking rack: apex toward the cue ball, 8 in the centre.
const RACK = [
  [1],
  [2, 9],
  [10, 8, 3],
  [4, 14, 11, 5],
  [6, 15, 13, 7, 12],
];

function rack() {
  const r = TABLE.ballRadius;
  const list = [new Ball(W * 0.26, H / 2, 0)];
  const apexX = W * 0.6;
  const apexY = H / 2;
  const rowDx = 2 * r * Math.cos(Math.PI / 6) + 0.6;
  RACK.forEach((column, col) => {
    column.forEach((number, i) => {
      const x = apexX + col * rowDx;
      const y = apexY + (i - col / 2) * (2 * r + 0.6);
      list.push(new Ball(x, y, number));
    });
  });
  return list;
}

function pocketBalls() {
  for (const b of balls) {
    if (!b.active) continue;
    for (const p of pocketCenters()) {
      if (Vec.len(Vec.sub(b.pos, p)) < TABLE.pocketRadius) {
        if (b.number === 0) {
          b.pos = { x: W * 0.26, y: H / 2 };
          b.vel = { x: 0, y: 0 };
        } else {
          b.active = false;
          game.shotPots.push(b.number);
        }
        break;
      }
    }
  }
}

// How many of a group's balls are still on the table.
function remainingInGroup(group) {
  const lo = group === "solids" ? 1 : 9;
  const hi = group === "solids" ? 7 : 15;
  return balls.filter((b) => b.active && b.number >= lo && b.number <= hi).length;
}

// Apply 8-ball rules once the table settles after a shot.
function evaluateShot() {
  const pots = game.shotPots;
  const solids = pots.filter((n) => n >= 1 && n <= 7).length;
  const stripes = pots.filter((n) => n >= 9 && n <= 15).length;
  const eight = pots.includes(8);

  // Claim a group on the first clean pot (mixed pots leave the table open).
  if (!game.group && !game.won && !game.lost) {
    if (solids && !stripes) game.group = "solids";
    else if (stripes && !solids) game.group = "stripes";
  }

  // The 8-ball decides the game: legal only after your group is cleared.
  if (eight && !game.won && !game.lost) {
    if (game.group && remainingInGroup(game.group) === 0) game.won = true;
    else game.lost = true;
  }

  updateStatus();
}

function updateStatus() {
  let text, statusState;
  if (game.won) {
    text = "You sank the 8-ball — you win! Press R to rack again.";
    statusState = "win";
  } else if (game.lost) {
    text = "The 8-ball went down too early — game over. Press R to rack again.";
    statusState = "lose";
  } else if (!game.group) {
    text = "Open table — pot a solid (1–7) or stripe (9–15) to claim your group.";
    statusState = "open";
  } else {
    const left = remainingInGroup(game.group);
    const name = game.group === "solids" ? "Solids (1–7)" : "Stripes (9–15)";
    text = left > 0
      ? `You're ${name} — ${left} ball${left === 1 ? "" : "s"} left, then the 8.`
      : `You're ${name} — group cleared! Pot the 8-ball to win.`;
    statusState = game.group;
  }
  statusEl.textContent = text;
  statusEl.dataset.state = statusState;
}

function newRack() {
  balls = rack();
  game.group = null;
  game.shotPots = [];
  game.won = false;
  game.lost = false;
  state.predDirty = true;
  updateStatus();
  scheduleAdvisor();
}

// --- shot advisor ----------------------------------------------------------

function legalTargets() {
  if (game.won || game.lost) return [];
  let nums;
  if (!game.group) nums = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];
  else if (remainingInGroup(game.group) > 0)
    nums = game.group === "solids" ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
  else nums = [8];
  return balls.filter((b) => b.active && nums.includes(b.number));
}

function isLegalNumber(n) {
  if (game.won || game.lost) return false;
  if (!game.group) return n >= 1 && n <= 15 && n !== 8;
  if (remainingInGroup(game.group) > 0)
    return game.group === "solids" ? n >= 1 && n <= 7 : n >= 9 && n <= 15;
  return n === 8;
}

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// Is the straight corridor from `from` to `to` blocked by another ball?
function pathBlocked(from, to, ignore) {
  const seg = Vec.sub(to, from);
  const segLen = Vec.len(seg);
  if (segLen < 1e-6) return false;
  const dir = Vec.scale(seg, 1 / segLen);
  for (const b of balls) {
    if (!b.active || ignore.includes(b.number)) continue;
    const t = Vec.dot(Vec.sub(b.pos, from), dir);
    if (t < -TABLE.ballRadius || t > segLen + TABLE.ballRadius) continue;
    const clampT = Math.max(0, Math.min(segLen, t));
    const closest = Vec.add(from, Vec.scale(dir, clampT));
    if (Vec.len(Vec.sub(b.pos, closest)) < 2 * TABLE.ballRadius - 1) return true;
  }
  return false;
}

// Geometry of potting `target` into pocket `pi`: aim, cut angle and distance,
// or null if the cut is impossible or the path is blocked.
function evaluateCandidate(target, pi) {
  const cue = balls[0];
  const P = pocketCenters()[pi];
  const T = target.pos;
  const dirTP = Vec.norm(Vec.sub(P, T));
  const ghost = Vec.sub(T, Vec.scale(dirTP, 2 * TABLE.ballRadius));
  const toGhost = Vec.sub(ghost, cue.pos);
  const distCue = Vec.len(toGhost);
  if (distCue < 1) return null;
  const aimDir = Vec.scale(toGhost, 1 / distCue);
  const dot = Vec.dot(aimDir, dirTP);
  if (dot < 0.21) return null; // cut thinner than ~78 degrees is unrealistic
  if (pathBlocked(cue.pos, ghost, [0, target.number])) return null;
  if (pathBlocked(T, P, [0, target.number])) return null;
  return {
    number: target.number,
    pocketIndex: pi,
    aimAngle: Math.atan2(aimDir.y, aimDir.x),
    cutDeg: Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI,
    dist: distCue + Vec.len(Vec.sub(P, T)),
  };
}

// Confirm a candidate by simulating it; keep the lowest-difficulty power that
// actually drops the ball into the intended pocket.
function validateAndScore(c) {
  const diag = Math.hypot(W, H);
  let best = null;
  for (const p of [0.5, 0.8]) {
    const speed = p * MAX_SPEED;
    const vel = { x: Math.cos(c.aimAngle) * speed, y: Math.sin(c.aimAngle) * speed };
    const trails = simulateShot(balls, bounds, vel, 700);
    const tt = trails.find((t) => t.number === c.number);
    const cueT = trails.find((t) => t.number === 0);
    const intoPocket = tt && tt.pocketed &&
      Vec.len(Vec.sub(tt.rest, pocketCenters()[c.pocketIndex])) < TABLE.pocketRadius + 3;
    if (!intoPocket) continue;
    const scratch = !!(cueT && cueT.pocketed);
    const difficulty = (c.cutDeg / 90) * 55 + (c.dist / diag) * 35 + (scratch ? 40 : 0) + p * 8;
    if (!best || difficulty < best.difficulty) {
      best = { ...c, power: p, scratch, difficulty, quality: Math.max(5, Math.round(100 - difficulty)) };
    }
  }
  return best;
}

function computeRecommendations() {
  if (!allStopped(balls)) return;
  const out = [];
  for (const t of legalTargets()) {
    const cands = [];
    for (let pi = 0; pi < 6; pi++) {
      const c = evaluateCandidate(t, pi);
      if (c) cands.push(c);
    }
    cands.sort((a, b) => (a.cutDeg + a.dist * 0.05) - (b.cutDeg + b.dist * 0.05));
    let bestForBall = null;
    for (const c of cands.slice(0, 2)) {
      const s = validateAndScore(c);
      if (s && (!bestForBall || s.difficulty < bestForBall.difficulty)) bestForBall = s;
    }
    if (bestForBall) out.push(bestForBall);
  }
  out.sort((a, b) => a.difficulty - b.difficulty);
  advisor.list = out.slice(0, 5);
  renderShotList();
}

// Run the (heavier) analysis off the critical path so the frame still paints.
function scheduleAdvisor() {
  setTimeout(computeRecommendations, 0);
}

function renderShotList() {
  if (!shotListEl) return;
  if (game.won || game.lost) { shotListEl.innerHTML = "<li>Game over &mdash; press R to rack again.</li>"; return; }
  if (!advisor.list.length) { shotListEl.innerHTML = "<li>No clear pot &mdash; play safe or break up a cluster.</li>"; return; }
  shotListEl.innerHTML = advisor.list.map((s) => {
    const diff = s.cutDeg < 8 ? "straight in" : s.cutDeg < 25 ? "easy cut" : s.cutDeg < 45 ? "moderate cut" : "thin cut";
    const warn = s.scratch ? " &middot; scratch risk" : "";
    return `<li><b>${s.number}-ball</b> &rarr; ${POCKET_NAMES[s.pocketIndex]} <span class="meta">${diff}${warn} &middot; ${s.quality}%</span></li>`;
  }).join("");
}

function renderTips(tips) {
  if (!shotTipsEl) return;
  shotTipsEl.innerHTML = tips.length
    ? tips.map((t) => `<li>${t}</li>`).join("")
    : "<li>Aim to see feedback on your shot.</li>";
}

// Feedback on the line the player is currently aiming, read from the cached
// full-shot prediction plus the ranked recommendations.
function currentShotTips() {
  if (!shotTipsEl) return;
  if (game.won || game.lost) { renderTips(["Game over — press R to rack again."]); return; }
  const pred = state.pred;
  if (!pred) { renderTips([]); return; }

  const tips = [];
  const cueT = pred.find((t) => t.number === 0);
  const scratch = !!(cueT && cueT.pocketed);
  const potted = pred.filter((t) => t.pocketed && t.number !== 0);
  const good = potted.filter((t) => isLegalNumber(t.number)).map((t) => t.number);
  const bad8 = potted.some((t) => t.number === 8) && !isLegalNumber(8);

  if (scratch) tips.push("This line scratches the cue ball — lower the power or change the angle.");
  if (bad8) tips.push("This pots the 8-ball early, which loses the game.");
  if (good.length) tips.push(`Good — this pots the ${good.join(", ")}.`);

  if (advisor.list.length) {
    let nearest = null, nd = Infinity;
    for (const s of advisor.list) {
      const d = angDiff(s.aimAngle, state.aimAngle);
      if (Math.abs(d) < nd) { nd = Math.abs(d); nearest = { s, d }; }
    }
    const degs = nearest.d * 180 / Math.PI;
    if (Math.abs(degs) > 1.2) {
      tips.push(`Rotate about ${Math.abs(degs).toFixed(1)}° ${degs > 0 ? "clockwise" : "counter-clockwise"} to line up the ${nearest.s.number}-ball (${POCKET_NAMES[nearest.s.pocketIndex]}).`);
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

function drawAdvisorBadges() {
  advisor.list.forEach((s, i) => {
    const b = balls.find((x) => x.active && x.number === s.number);
    if (!b) return;
    const bx = b.pos.x;
    const by = b.pos.y - TABLE.ballRadius - 9;
    ctx.beginPath();
    ctx.arc(bx, by, 8, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? "rgba(243,196,61,0.95)" : "rgba(16,24,30,0.9)";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.stroke();
    ctx.fillStyle = i === 0 ? "#1a1a1a" : "#fff";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), bx, by + 0.5);
  });
}

// --- control geometry ------------------------------------------------------

const POWER = { x: 16, w: 14 };
function powerRect() {
  return { x: POWER.x, w: POWER.w, y0: bounds.top + 12, y1: bounds.bottom - 12 };
}
function inPower(p) {
  const r = powerRect();
  return p.x >= r.x - 8 && p.x <= r.x + r.w + 8 && p.y >= r.y0 - 10 && p.y <= r.y1 + 10;
}
function fineDial() {
  const cx = W - TABLE.margin / 2;
  return { cx, cy: H / 2, y0: bounds.top + 12, y1: bounds.bottom - 12 };
}
function inFine(p) {
  const d = fineDial();
  return Math.abs(p.x - d.cx) < 16 && p.y >= d.y0 - 10 && p.y <= d.y1 + 10;
}

// --- table & balls ---------------------------------------------------------

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
  const b = bounds;
  const m = TABLE.margin / 2;
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  for (let i = 1; i <= 7; i++) {
    if (i === 4) continue;
    const x = b.left + (w * i) / 8;
    diamond(x, m);
    diamond(x, H - m);
  }
  for (let i = 1; i <= 3; i++) {
    const y = b.top + (h * i) / 4;
    diamond(m, y);
    diamond(W - m, y);
  }
}

function drawTable() {
  ctx.fillStyle = "#16424c";
  roundRect(0, 0, W, H, 20);
  ctx.fill();
  ctx.fillStyle = "#0d2c33";
  roundRect(7, 7, W - 14, H - 14, 15);
  ctx.fill();

  const fx = bounds.left, fy = bounds.top;
  const fw = bounds.right - bounds.left, fh = bounds.bottom - bounds.top;
  const felt = ctx.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, Math.max(fw, fh) * 0.75);
  felt.addColorStop(0, "#1aa257");
  felt.addColorStop(1, "#0c6e3b");
  roundRect(fx, fy, fw, fh, 8);
  ctx.fillStyle = felt;
  ctx.fill();

  drawDiamonds();

  for (const p of pocketCenters()) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, TABLE.pocketRadius + 3, 0, Math.PI * 2);
    ctx.fillStyle = "#0a1f17";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, TABLE.pocketRadius, 0, Math.PI * 2);
    ctx.fillStyle = "#04120c";
    ctx.fill();
  }
}

function fillCircle(x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawBall(b) {
  const { x, y } = b.pos;
  const r = TABLE.ballRadius;
  const color = BALL_COLORS[b.number];

  ctx.beginPath();
  ctx.ellipse(x + 1.5, y + 2.5, r, r * 0.92, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fill();

  if (isStriped(b.number)) {
    fillCircle(x, y, r, "#f3efe4");
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fillRect(x - r, y - r * 0.55, r * 2, r * 1.1);
    ctx.restore();
  } else {
    fillCircle(x, y, r, color);
  }

  if (b.number > 0) {
    fillCircle(x, y, r * 0.46, "#fbfaf5");
    ctx.fillStyle = "#1a1a1a";
    ctx.font = `bold ${Math.round(r * 0.6)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(b.number), x, y + 0.5);
  }

  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, "rgba(255,255,255,0.55)");
  g.addColorStop(0.45, "rgba(255,255,255,0.06)");
  g.addColorStop(1, "rgba(0,0,0,0.2)");
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();

  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.stroke();
}

// --- prediction, cue, controls ---------------------------------------------

function shotVelocity() {
  const dir = { x: Math.cos(state.aimAngle), y: Math.sin(state.aimAngle) };
  const speed = Math.max(0.06, state.power) * MAX_SPEED;
  return Vec.scale(dir, speed);
}

function ensurePrediction() {
  if (state.predDirty) {
    state.pred = simulateShot(balls, bounds, shotVelocity());
    state.predDirty = false;
    currentShotTips();
  }
}

function strokePath(points, rgba, width) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.strokeStyle = rgba;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

function drawPrediction() {
  const pred = state.pred;
  if (!pred) return;
  for (const t of pred) {
    const isCue = t.number === 0;
    if (!isCue && !t.moved) continue;
    const rgb = isCue ? "255,255,255" : hexRgb(BALL_COLORS[t.number]);

    strokePath(t.points, `rgba(${rgb},${isCue ? 0.85 : 0.6})`, isCue ? 2.2 : 1.8);

    if (ui.showStops.checked) {
      if (t.pocketed) {
        const p = t.rest;
        ctx.strokeStyle = `rgba(${rgb},0.95)`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x - 4, p.y - 4); ctx.lineTo(p.x + 4, p.y + 4);
        ctx.moveTo(p.x + 4, p.y - 4); ctx.lineTo(p.x - 4, p.y + 4);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(t.rest.x, t.rest.y, TABLE.ballRadius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb},0.9)`;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
  }
}

function drawCueStick() {
  const cue = balls[0];
  const aim = { x: Math.cos(state.aimAngle), y: Math.sin(state.aimAngle) };
  const back = Vec.scale(aim, -1);
  const gap = TABLE.ballRadius + 8 + state.power * 46;
  const tip = Vec.add(cue.pos, Vec.scale(back, gap));
  const butt = Vec.add(tip, Vec.scale(back, 195));

  const g = ctx.createLinearGradient(tip.x, tip.y, butt.x, butt.y);
  g.addColorStop(0.0, "#e9e2cf");
  g.addColorStop(0.05, "#2a2a2a");
  g.addColorStop(0.1, "#d2ab5e");
  g.addColorStop(1.0, "#5a3a1a");

  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = g;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(butt.x, butt.y);
  ctx.stroke();
  ctx.restore();
}

function drawPowerMeter() {
  const r = powerRect();
  const h = r.y1 - r.y0;
  const g = ctx.createLinearGradient(0, r.y1, 0, r.y0);
  g.addColorStop(0.0, "#e07a1f");
  g.addColorStop(0.5, "#f3c43d");
  g.addColorStop(1.0, "#d33b30");
  roundRect(r.x, r.y0, r.w, h, 6);
  ctx.fillStyle = g;
  ctx.fill();

  if (state.power < 1) {
    roundRect(r.x, r.y0, r.w, h * (1 - state.power), 6);
    ctx.fillStyle = "rgba(8,20,16,0.62)";
    ctx.fill();
  }

  const ky = r.y1 - state.power * h;
  ctx.fillStyle = state.drag === "power" ? "#4cc2ff" : "#ffffff";
  roundRect(r.x - 3, ky - 3, r.w + 6, 6, 3);
  ctx.fill();
}

function drawFineDial() {
  const d = fineDial();
  line({ x: d.cx, y: d.y0 }, { x: d.cx, y: d.y1 }, "rgba(255,255,255,0.18)", 2);
  ctx.beginPath();
  ctx.arc(d.cx, d.cy, 11, 0, Math.PI * 2);
  ctx.fillStyle = state.drag === "fine" ? "rgba(76,194,255,0.95)" : "rgba(255,255,255,0.85)";
  ctx.fill();
  ctx.strokeStyle = "#0d2c33";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(d.cx - 4, d.cy - 2); ctx.lineTo(d.cx, d.cy - 6); ctx.lineTo(d.cx + 4, d.cy - 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(d.cx - 4, d.cy + 2); ctx.lineTo(d.cx, d.cy + 6); ctx.lineTo(d.cx + 4, d.cy + 2); ctx.stroke();
}

function line(from, to, color, width) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width || 2;
  ctx.stroke();
}

// --- loop & input ----------------------------------------------------------

function render() {
  ctx.clearRect(0, 0, W, H);
  drawTable();

  const moving = !allStopped(balls);
  if (!moving && ui.showGuides.checked) {
    ensurePrediction();
    drawPrediction();
  }
  for (const b of balls) if (b.active) drawBall(b);
  if (!moving && ui.showGuides.checked) {
    drawAdvisorBadges();
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
    state.predDirty = true; // table just settled — recompute for the new turn
    evaluateShot();
    scheduleAdvisor();
  }
  wasMoving = moving;
  render();
  requestAnimationFrame(frame);
}

function toCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (W / rect.width),
    y: (e.clientY - rect.top) * (H / rect.height),
  };
}

function setPowerFromY(y) {
  const r = powerRect();
  state.power = Math.max(0, Math.min(1, (r.y1 - y) / (r.y1 - r.y0)));
  state.predDirty = true;
}

function shoot() {
  if (game.won || game.lost) return;
  game.shotPots = [];
  const cue = balls[0];
  cue.vel = shotVelocity();
  state.predDirty = true;
}

canvas.addEventListener("pointerdown", (e) => {
  if (!allStopped(balls)) return;
  const p = toCanvas(e);
  if (inPower(p)) {
    state.drag = "power";
    setPowerFromY(p.y);
  } else if (inFine(p)) {
    state.drag = "fine";
    state.fineLastY = p.y;
  } else {
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
  if (state.drag === "power") shoot(); // release the power slider to strike
  state.drag = null;
});

window.addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") { newRack(); }
  else if (e.code === "Space") { e.preventDefault(); if (allStopped(balls)) shoot(); }
});

ui.reset.addEventListener("click", newRack);

newRack();
requestAnimationFrame(frame);
