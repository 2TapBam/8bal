"use strict";

// ---------------------------------------------------------------------------
// aim.js — trajectory prediction (the "aim guide").
//
// Casts a ray from the cue ball along the aim direction. The ray bounces off
// cushions until it reaches the first ball it would strike. At that contact it
// reports the ghost-ball position and the resulting directions of both balls:
//   - object ball travels along the line of centres (ghost -> object)
//   - cue ball deflects along the perpendicular ("tangent line") for an ideal
//     equal-mass, spin-free collision.
// ---------------------------------------------------------------------------

// Distance along ray `origin + t*d` at which it first touches another ball.
// Solves |(origin - B) + t*d|^2 = (2r)^2 for the smaller positive root.
function firstBallHit(origin, d, balls, cue) {
  const diameter = TABLE.ballRadius * 2;
  let best = null;
  for (const b of balls) {
    if (!b.active || b === cue) continue;
    const f = Vec.sub(origin, b.pos);
    const proj = Vec.dot(f, d);
    const c = Vec.dot(f, f) - diameter * diameter;
    const disc = proj * proj - c;
    if (disc < 0) continue;                 // ray misses this ball
    const t = -proj - Math.sqrt(disc);      // entry point (smaller root)
    if (t < 1e-6) continue;                 // behind or at the origin
    if (!best || t < best.t) best = { t, ball: b };
  }
  return best;
}

// Distance to the first cushion the ray reaches, plus the reflected direction.
function cushionHit(origin, d, bounds) {
  const r = TABLE.ballRadius;
  const left = bounds.left + r, right = bounds.right - r;
  const top = bounds.top + r, bottom = bounds.bottom - r;
  let best = null;

  const consider = (t, normal) => {
    if (t <= 1e-6) return;
    if (best && t >= best.t) return;
    const point = Vec.add(origin, Vec.scale(d, t));
    const dn = Vec.dot(d, normal);
    const reflect = Vec.sub(d, Vec.scale(normal, 2 * dn));
    best = { t, point, reflect };
  };

  if (d.x > 1e-9)       consider((right - origin.x) / d.x, { x: 1, y: 0 });
  else if (d.x < -1e-9) consider((left - origin.x) / d.x,  { x: 1, y: 0 });
  if (d.y > 1e-9)       consider((bottom - origin.y) / d.y, { x: 0, y: 1 });
  else if (d.y < -1e-9) consider((top - origin.y) / d.y,    { x: 0, y: 1 });

  return best;
}

// Build the predicted path. Returns { segments, contact } where `segments` are
// line pieces to draw and `contact` (if any) describes the ball that is struck.
function predictTrajectory(cue, balls, dir, bounds, maxBounces) {
  const result = { segments: [], contact: null };
  let origin = { x: cue.pos.x, y: cue.pos.y };
  let d = Vec.norm(dir);

  for (let bounce = 0; bounce <= maxBounces; bounce++) {
    const ball = firstBallHit(origin, d, balls, cue);
    const cushion = cushionHit(origin, d, bounds);

    if (ball && (!cushion || ball.t <= cushion.t)) {
      const ghost = Vec.add(origin, Vec.scale(d, ball.t));
      const objDir = Vec.norm(Vec.sub(ball.ball.pos, ghost));
      const along = Vec.scale(objDir, Vec.dot(d, objDir));
      const cueResidual = Vec.sub(d, along);
      result.segments.push({ from: origin, to: ghost });
      result.contact = {
        ghost,
        objDir,
        cueDir: Vec.norm(cueResidual),
        hasCueDeflection: Vec.len(cueResidual) > 1e-3,
      };
      return result;
    }

    if (cushion) {
      result.segments.push({ from: origin, to: cushion.point });
      origin = cushion.point;
      d = cushion.reflect;
    } else {
      result.segments.push({ from: origin, to: Vec.add(origin, Vec.scale(d, 4000)) });
      return result;
    }
  }
  return result;
}
