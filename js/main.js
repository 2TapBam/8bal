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
        }
        break;
      }
    }
  }
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
  if (e.key === "r" || e.key === "R") { balls = rack(); state.predDirty = true; }
  else if (e.code === "Space") { e.preventDefault(); if (allStopped(balls)) shoot(); }
});

ui.reset.addEventListener("click", () => { balls = rack(); state.predDirty = true; });

balls = rack();
requestAnimationFrame(frame);
