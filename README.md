# Trajectory Pool

A standalone billiards **physics & aim simulator** that runs entirely in the
browser. It is a self-contained sandbox on its own table — there is no external
game involved. The point is the maths: elastic ball collisions, cushion
reflections, and ghost-ball aim prediction.

## Run it

No build step and no dependencies. Either:

- Double-click `index.html` to open it in a browser, **or**
- Serve the folder locally, e.g. `python3 -m http.server` then open
  <http://localhost:8000>.

## Controls

| Action | How |
| ------ | --- |
| Aim    | Move the mouse to point the cue ball |
| Power  | Press and hold to charge, release to strike |
| Reset  | Press `R` or click **Re-rack** |
| Toggle guides / bounces | Checkboxes below the table |

## How it works

- **Motion & friction** (`js/physics.js`) — each ball integrates its velocity
  per frame and loses a small fraction to rolling resistance until it stops.
- **Cushion collisions** — perfectly elastic reflections off the inset rails.
- **Ball-to-ball collisions** — equal-mass elastic response: the two balls
  exchange the velocity component along the line connecting their centres, with
  overlap correction so they never stick.
- **Aim prediction** (`js/aim.js`) — a ray is cast from the cue ball and bounced
  off cushions until it reaches the first ball it would strike. At that contact
  it draws the **ghost-ball** position and the resulting paths: the object ball
  along the line of centres, and the cue ball along the perpendicular tangent
  line (the ideal spin-free, equal-mass result).

## Project layout

```
index.html        markup + canvas
css/style.css     styling
js/physics.js     vectors, ball physics, collisions
js/aim.js         trajectory / ghost-ball prediction
js/main.js        rendering, input, game loop
```

## License

See `LICENSE` if present; otherwise free to use and modify for learning.
