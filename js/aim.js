"use strict";

// ---------------------------------------------------------------------------
// aim.js — full-shot prediction.
//
// Instead of only finding the first ball struck, this clones the table and
// plays the entire shot forward at the chosen power: the cue ball travels,
// bounces off cushions, strikes balls, those balls move and strike others, and
// so on until everything comes to rest. It returns one trail per ball — the
// path it follows and where it finally stops (or which pocket it falls into).
// ---------------------------------------------------------------------------

function simulateShot(balls, bounds, cueVel, maxSteps) {
  maxSteps = maxSteps || 1100;

  // Clone the active balls (order preserved, cue ball stays index 0).
  const sim = balls.filter((b) => b.active).map((b) => new Ball(b.pos.x, b.pos.y, b.number));
  if (sim.length === 0) return { trails: [], firstContact: null };
  sim[0].vel = { x: cueVel.x, y: cueVel.y };

  const trails = sim.map((b) => ({
    number: b.number,
    points: [{ x: b.pos.x, y: b.pos.y }],
    moved: false,
    pocketed: false,
    rest: { x: b.pos.x, y: b.pos.y },
  }));

  const pockets = pocketCenters();
  let firstContact = null; // { x, y, ball } — where the cue first strikes a ball

  for (let s = 0; s < maxSteps && !allStopped(sim); s++) {
    stepPhysics(sim, bounds);

    // The first object ball to gain velocity marks the cue's first contact;
    // the cue's position at that moment is the ghost-ball point.
    if (!firstContact) {
      for (let i = 1; i < sim.length; i++) {
        const b = sim[i];
        if (b.active && (b.vel.x !== 0 || b.vel.y !== 0)) {
          firstContact = { x: sim[0].pos.x, y: sim[0].pos.y, ball: b.number };
          break;
        }
      }
    }

    for (let i = 0; i < sim.length; i++) {
      const b = sim[i];
      if (!b.active) continue;

      // pocket capture
      let dropped = false;
      for (const p of pockets) {
        if (Vec.len(Vec.sub(b.pos, p)) < TABLE.pocketRadius) {
          b.active = false;
          const t = trails[i];
          t.pocketed = true;
          t.moved = true;
          t.points.push({ x: p.x, y: p.y });
          t.rest = { x: p.x, y: p.y };
          dropped = true;
          break;
        }
      }
      if (dropped) continue;

      // sample the path when the ball has moved far enough to matter
      const t = trails[i];
      const last = t.points[t.points.length - 1];
      if (Math.hypot(b.pos.x - last.x, b.pos.y - last.y) > 3) {
        t.points.push({ x: b.pos.x, y: b.pos.y });
        t.moved = true;
      }
    }
  }

  // record final resting positions for balls still on the table
  for (let i = 0; i < sim.length; i++) {
    if (sim[i].active) {
      trails[i].rest = { x: sim[i].pos.x, y: sim[i].pos.y };
      trails[i].points.push({ x: sim[i].pos.x, y: sim[i].pos.y });
    }
  }

  return { trails, firstContact };
}
