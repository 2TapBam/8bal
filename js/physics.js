"use strict";

// ---------------------------------------------------------------------------
// physics.js — 2D vector helpers and billiard ball physics.
// No dependencies. Loaded before aim.js and main.js.
// ---------------------------------------------------------------------------

const Vec = {
  add:   (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub:   (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s }),
  dot:   (a, b) => a.x * b.x + a.y * b.y,
  len:   (a)    => Math.hypot(a.x, a.y),
  norm:  (a)    => {
    const l = Math.hypot(a.x, a.y) || 1;
    return { x: a.x / l, y: a.y / l };
  },
};

// Table geometry and physics constants (all in canvas pixels).
const TABLE = {
  width: 900,
  height: 500,
  margin: 46,        // rail thickness; the playfield is inset by this
  ballRadius: 12.5,  // a touch larger so numbers read clearly
  pocketRadius: 21,  // capture radius (forgiving; gameplay)
  pocketMouth: 16.5, // visible opening drawn on the felt (smaller = less cartoonish)
  friction: 0.991,   // per-frame velocity multiplier (rolling resistance)
  stopSpeed: 0.06,   // speeds below this snap to zero
};

// The rectangle the ball *centers* can travel within is further inset by the
// ball radius; cushion/pocket math accounts for that where needed.
function playfield() {
  return {
    left: TABLE.margin,
    top: TABLE.margin,
    right: TABLE.width - TABLE.margin,
    bottom: TABLE.height - TABLE.margin,
  };
}

function pocketCenters() {
  const b = playfield();
  const midX = (b.left + b.right) / 2;
  return [
    { x: b.left,  y: b.top },
    { x: midX,    y: b.top },
    { x: b.right, y: b.top },
    { x: b.left,  y: b.bottom },
    { x: midX,    y: b.bottom },
    { x: b.right, y: b.bottom },
  ];
}

class Ball {
  constructor(x, y, number) {
    this.pos = { x, y };
    this.vel = { x: 0, y: 0 };
    this.number = number;   // 0 = cue ball; 1-15 object balls
    this.active = true;
  }
}

// Advance every ball one frame. Motion and collisions are sub-stepped so fast
// balls move smoothly and never tunnel through each other or the cushions;
// friction is applied once per frame so the stopping distance is unchanged.
function stepPhysics(balls, bounds, substeps) {
  const k = substeps || 4;
  for (let s = 0; s < k; s++) {
    for (const b of balls) {
      if (!b.active) continue;
      b.pos.x += b.vel.x / k;
      b.pos.y += b.vel.y / k;
      collideCushions(b, bounds);
    }
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        if (balls[i].active && balls[j].active) collideBalls(balls[i], balls[j]);
      }
    }
  }
  for (const b of balls) {
    if (!b.active) continue;
    b.vel.x *= TABLE.friction;
    b.vel.y *= TABLE.friction;
    if (Vec.len(b.vel) < TABLE.stopSpeed) { b.vel.x = 0; b.vel.y = 0; }
  }
}

// Reflect a ball off the table cushions (perfectly elastic). Inside a pocket's
// mouth the rail "opens", so a ball heading for a pocket rolls in instead of
// bouncing back out before the per-frame capture check can grab it.
function collideCushions(b, bounds) {
  const r = TABLE.ballRadius;
  const mouth = TABLE.pocketRadius + TABLE.ballRadius; // rail opening near a pocket
  for (const p of pocketCenters()) {
    if (Vec.len(Vec.sub(b.pos, p)) < mouth) return; // heading into the pocket
  }
  if (b.pos.x < bounds.left + r)   { b.pos.x = bounds.left + r;   b.vel.x = Math.abs(b.vel.x); }
  if (b.pos.x > bounds.right - r)  { b.pos.x = bounds.right - r;  b.vel.x = -Math.abs(b.vel.x); }
  if (b.pos.y < bounds.top + r)    { b.pos.y = bounds.top + r;    b.vel.y = Math.abs(b.vel.y); }
  if (b.pos.y > bounds.bottom - r) { b.pos.y = bounds.bottom - r; b.vel.y = -Math.abs(b.vel.y); }
  // absolute safety so a ball can never escape the felt
  b.pos.x = Math.max(bounds.left, Math.min(bounds.right, b.pos.x));
  b.pos.y = Math.max(bounds.top, Math.min(bounds.bottom, b.pos.y));
}

// Equal-mass elastic collision: the two balls exchange the velocity component
// along the line connecting their centers. Overlap is corrected first so balls
// never stick together.
function collideBalls(a, b) {
  const delta = Vec.sub(b.pos, a.pos);
  const dist = Vec.len(delta);
  const minDist = TABLE.ballRadius * 2;
  if (dist === 0 || dist >= minDist) return;

  const normal = Vec.scale(delta, 1 / dist);
  const overlap = minDist - dist;
  a.pos = Vec.sub(a.pos, Vec.scale(normal, overlap / 2));
  b.pos = Vec.add(b.pos, Vec.scale(normal, overlap / 2));

  const relVel = Vec.sub(a.vel, b.vel);
  const sepSpeed = Vec.dot(relVel, normal);
  if (sepSpeed <= 0) return; // already separating

  const impulse = Vec.scale(normal, sepSpeed);
  a.vel = Vec.sub(a.vel, impulse);
  b.vel = Vec.add(b.vel, impulse);
}

// True once every active ball has come to rest.
function allStopped(balls) {
  return balls.every((b) => !b.active || (b.vel.x === 0 && b.vel.y === 0));
}
