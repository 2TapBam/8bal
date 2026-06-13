"use strict";

// ---------------------------------------------------------------------------
// main.js — canvas rendering, input, and the game loop.
// Styled to resemble a classic 8-ball table (felt, ornate rails, glossy
// numbered balls, a cue stick, and a side power meter). Still a fully
// self-contained sandbox: nothing here connects to any external game.
// ---------------------------------------------------------------------------

const canvas = document.getElementById("table");
const ctx = canvas.getContext("2d");
const bounds = playfield();

const W = TABLE.width;
const H = TABLE.height;

// Crisp rendering on high-DPI screens: scale the backing store, draw in
// logical (W x H) coordinates.
const dpr = Math.max(1, Math.min(3, Math.floor(window.devicePixelRatio || 1)));
canvas.width = W * dpr;
canvas.height = H * dpr;
ctx.scale(dpr, dpr);

const MAX_DRAG = 230;   // pixels of pull for full power
const MAX_SPEED = 19;   // resulting cue-ball speed at full power
const MAX_BOUNCES = 3;  // cushion reflections shown in the aim guide

const ui = {
  showGuides: document.getElementById("showGuides"),
  showBounce: document.getElementById("showBounce"),
  reset: document.getElementById("reset"),
};

const mouse = { x: W / 2, y: H / 2, charging: false };
let balls = [];

// Authentic-ish 8-ball colours. Numbers 1-7 are solids, 9-15 are stripes of
// the same hue, 8 is black. Index 0 is the white cue ball.
const BALL_COLORS = {
  0: "#f6f4ee",
  1: "#f3c43d", 2: "#1f59c4", 3: "#d33b30", 4: "#7b2d96",
  5: "#e07a1f", 6: "#1f8a4c", 7: "#8a2d2d", 8: "#16181c",
  9: "#f3c43d", 10: "#1f59c4", 11: "#d33b30", 12: "#7b2d96",
  13: "#e07a1f", 14: "#1f8a4c", 15: "#8a2d2d",
};
const isStriped = (n) => n >= 9 && n <= 15;

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
  const list = [new Ball(TABLE.width * 0.26, TABLE.height / 2, 0)];
  const apexX = TABLE.width * 0.6;
  const apexY = TABLE.height / 2;
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
          // Scratch: return the cue ball to the kitchen instead of removing it.
          b.pos = { x: TABLE.width * 0.26, y: TABLE.height / 2 };
          b.vel = { x: 0, y: 0 };
        } else {
          b.active = false;
        }
        break;
      }
    }
  }
}

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
  const b = bounds;
  const m = TABLE.margin / 2;
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  for (let i = 1; i <= 7; i++) {
    if (i === 4) continue; // skip the middle pockets
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
  // outer rail (teal wood)
  ctx.fillStyle = "#16424c";
  roundRect(0, 0, W, H, 20);
  ctx.fill();
  ctx.fillStyle = "#0d2c33";
  roundRect(7, 7, W - 14, H - 14, 15);
  ctx.fill();

  // felt with a soft centre glow
  const fx = bounds.left, fy = bounds.top;
  const fw = bounds.right - bounds.left, fh = bounds.bottom - bounds.top;
  const felt = ctx.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, Math.max(fw, fh) * 0.75);
  felt.addColorStop(0, "#1aa257");
  felt.addColorStop(1, "#0c6e3b");
  roundRect(fx, fy, fw, fh, 8);
  ctx.fillStyle = felt;
  ctx.fill();

  drawDiamonds();

  // pockets
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

// --- balls -----------------------------------------------------------------

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

  // drop shadow
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

  // numbered balls carry a white spot with the number
  if (b.number > 0) {
    fillCircle(x, y, r * 0.46, "#fbfaf5");
    ctx.fillStyle = "#1a1a1a";
    ctx.font = `bold ${Math.round(r * 0.6)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(b.number), x, y + 0.5);
  }

  // glossy highlight
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

// --- aim, cue, power -------------------------------------------------------

function line(from, to, color, width, dash) {
  ctx.beginPath();
  ctx.setLineDash(dash || []);
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width || 2;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawCue(cue, aimDir, power) {
  const aim = Vec.norm(aimDir);
  const back = Vec.scale(aim, -1);
  const gap = TABLE.ballRadius + 8 + power * 46; // pulls back as power charges
  const tip = Vec.add(cue.pos, Vec.scale(back, gap));
  const butt = Vec.add(tip, Vec.scale(back, 195));

  const g = ctx.createLinearGradient(tip.x, tip.y, butt.x, butt.y);
  g.addColorStop(0.0, "#e9e2cf");  // tip / ferrule
  g.addColorStop(0.05, "#2a2a2a");
  g.addColorStop(0.1, "#d2ab5e"); // shaft start
  g.addColorStop(1.0, "#5a3a1a");  // butt

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

function drawPowerMeter(power) {
  const x = 18, w = 12;
  const y0 = bounds.top + 6, y1 = bounds.bottom - 6;
  const h = y1 - y0;

  const g = ctx.createLinearGradient(0, y1, 0, y0);
  g.addColorStop(0.0, "#e07a1f");
  g.addColorStop(0.5, "#f3c43d");
  g.addColorStop(1.0, "#d33b30");
  roundRect(x, y0, w, h, 6);
  ctx.fillStyle = g;
  ctx.fill();

  // dim the portion above the current charge
  if (power < 1) {
    roundRect(x, y0, w, h * (1 - power), 6);
    ctx.fillStyle = "rgba(8,20,16,0.6)";
    ctx.fill();
  }

  // knob at the charge level
  const ky = y1 - power * h;
  ctx.fillStyle = "#ffffff";
  roundRect(x - 3, ky - 3, w + 6, 6, 3);
  ctx.fill();
}

function drawAim() {
  const cue = balls[0];
  const dir = Vec.sub(mouse, cue.pos);
  if (Vec.len(dir) < 1) return;

  const power = mouse.charging ? Math.min(Vec.len(dir), MAX_DRAG) / MAX_DRAG : 0;

  drawCue(cue, dir, power);

  const maxBounces = ui.showBounce.checked ? MAX_BOUNCES : 0;
  const path = predictTrajectory(cue, balls, dir, bounds, maxBounces);

  for (const seg of path.segments) line(seg.from, seg.to, "rgba(255,255,255,0.9)", 2);

  if (path.contact) {
    const c = path.contact;
    ctx.beginPath();
    ctx.arc(c.ghost.x, c.ghost.y, TABLE.ballRadius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    line(c.ghost, Vec.add(c.ghost, Vec.scale(c.objDir, 130)), "rgba(243,196,61,0.95)", 2);
    if (c.hasCueDeflection) {
      line(c.ghost, Vec.add(c.ghost, Vec.scale(c.cueDir, 80)), "rgba(76,194,255,0.85)", 2, [5, 5]);
    }
  }

  drawPowerMeter(power);
}

// --- loop & input ----------------------------------------------------------

function render() {
  ctx.clearRect(0, 0, W, H);
  drawTable();
  for (const b of balls) if (b.active) drawBall(b);
  if (allStopped(balls) && ui.showGuides.checked) drawAim();
}

function frame() {
  if (!allStopped(balls)) {
    stepPhysics(balls, bounds);
    pocketBalls();
  }
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

canvas.addEventListener("pointermove", (e) => {
  const p = toCanvas(e);
  mouse.x = p.x;
  mouse.y = p.y;
});

canvas.addEventListener("pointerdown", (e) => {
  if (!allStopped(balls)) return;
  mouse.charging = true;
  const p = toCanvas(e);
  mouse.x = p.x;
  mouse.y = p.y;
});

window.addEventListener("pointerup", () => {
  if (!mouse.charging) return;
  mouse.charging = false;
  const cue = balls[0];
  const dir = Vec.sub(mouse, cue.pos);
  const dist = Vec.len(dir);
  if (dist < 2) return;
  const power = Math.min(dist, MAX_DRAG) / MAX_DRAG;
  cue.vel = Vec.scale(Vec.norm(dir), power * MAX_SPEED);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") balls = rack();
});

ui.reset.addEventListener("click", () => { balls = rack(); });

balls = rack();
requestAnimationFrame(frame);
