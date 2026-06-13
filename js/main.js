"use strict";

// ---------------------------------------------------------------------------
// main.js — canvas rendering, input, and the game loop.
// ---------------------------------------------------------------------------

const canvas = document.getElementById("table");
const ctx = canvas.getContext("2d");
const bounds = playfield();

const MAX_DRAG = 230;   // pixels of pull for full power
const MAX_SPEED = 19;   // resulting cue-ball speed at full power
const MAX_BOUNCES = 3;  // cushion reflections shown in the aim guide

const ui = {
  showGuides: document.getElementById("showGuides"),
  showBounce: document.getElementById("showBounce"),
  reset: document.getElementById("reset"),
};

const mouse = { x: TABLE.width / 2, y: TABLE.height / 2, charging: false };
let balls = [];

const BALL_COLORS = [
  "#f4c430", "#1f6feb", "#e5484d", "#8957e5", "#e8772e",
  "#2da44e", "#7a3b2e", "#111418", "#f4c430", "#1f6feb",
  "#e5484d", "#8957e5", "#e8772e", "#2da44e", "#7a3b2e",
];

// Cue ball plus a tight 15-ball triangle rack, apex pointing at the cue ball.
function rack() {
  const r = TABLE.ballRadius;
  const list = [new Ball(TABLE.width * 0.26, TABLE.height / 2, "#f5f5f5", "")];

  const apexX = TABLE.width * 0.6;
  const apexY = TABLE.height / 2;
  const rowDx = 2 * r * Math.cos(Math.PI / 6) + 0.6;
  let n = 0;
  for (let col = 0; col < 5; col++) {
    for (let i = 0; i <= col; i++) {
      const x = apexX + col * rowDx;
      const y = apexY + (i - col / 2) * (2 * r + 0.6);
      list.push(new Ball(x, y, BALL_COLORS[n], String(n + 1)));
      n++;
    }
  }
  return list;
}

function pocketBalls() {
  for (const b of balls) {
    if (!b.active) continue;
    for (const p of pocketCenters()) {
      if (Vec.len(Vec.sub(b.pos, p)) < TABLE.pocketRadius) {
        if (b.label === "") {
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

// --- rendering -------------------------------------------------------------

function drawTable() {
  ctx.fillStyle = "#5a3b22"; // rail / frame
  roundRect(0, 0, TABLE.width, TABLE.height, 14);
  ctx.fill();

  ctx.fillStyle = "#0f7a43"; // felt
  roundRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, 6);
  ctx.fill();

  ctx.fillStyle = "#06160d"; // pockets
  for (const p of pocketCenters()) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, TABLE.pocketRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBall(b) {
  ctx.beginPath();
  ctx.arc(b.pos.x, b.pos.y, TABLE.ballRadius, 0, Math.PI * 2);
  ctx.fillStyle = b.color;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.stroke();
  if (b.label) {
    ctx.fillStyle = b.color === "#111418" ? "#fff" : "rgba(0,0,0,0.7)";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(b.label, b.pos.x, b.pos.y);
  }
}

function line(from, to, color, dash) {
  ctx.beginPath();
  ctx.setLineDash(dash || []);
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawAim() {
  const cue = balls[0];
  const dir = Vec.sub(mouse, cue.pos);
  if (Vec.len(dir) < 1) return;

  const maxBounces = ui.showBounce.checked ? MAX_BOUNCES : 0;
  const path = predictTrajectory(cue, balls, dir, bounds, maxBounces);

  for (const seg of path.segments) line(seg.from, seg.to, "rgba(255,255,255,0.85)", [6, 6]);

  if (path.contact) {
    const c = path.contact;
    // ghost ball outline at the contact position
    ctx.beginPath();
    ctx.arc(c.ghost.x, c.ghost.y, TABLE.ballRadius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // predicted object-ball path (line of centres)
    line(c.ghost, Vec.add(c.ghost, Vec.scale(c.objDir, 120)), "rgba(244,196,48,0.9)");
    // predicted cue-ball deflection (tangent line)
    if (c.hasCueDeflection) {
      line(c.ghost, Vec.add(c.ghost, Vec.scale(c.cueDir, 80)), "rgba(76,194,255,0.9)");
    }
  }

  // power meter while charging
  if (mouse.charging) {
    const power = Math.min(Vec.len(dir), MAX_DRAG) / MAX_DRAG;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    roundRect(bounds.left + 8, bounds.bottom - 22, 120, 12, 6);
    ctx.fill();
    ctx.fillStyle = power > 0.8 ? "#e5484d" : "#4cc2ff";
    roundRect(bounds.left + 8, bounds.bottom - 22, 120 * power, 12, 6);
    ctx.fill();
  }
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawTable();
  for (const b of balls) if (b.active) drawBall(b);
  if (allStopped(balls) && ui.showGuides.checked) drawAim();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// --- loop & input ----------------------------------------------------------

function frame() {
  if (!allStopped(balls)) {
    stepPhysics(balls, bounds);
    pocketBalls();
  }
  render();
  requestAnimationFrame(frame);
}

// Map a pointer event to canvas coordinates (canvas is scaled by CSS width).
function toCanvas(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
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
  const v = Vec.scale(Vec.norm(dir), power * MAX_SPEED);
  cue.vel = v;
});

window.addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") balls = rack();
});

ui.reset.addEventListener("click", () => { balls = rack(); });

balls = rack();
requestAnimationFrame(frame);
