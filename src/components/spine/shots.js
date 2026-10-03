// The spine's choreography as data: what each panel's shot frames, how the robot comes apart, where
// each callout points, and the two mechanism programs. The engine (engine.js) interprets these; the
// copy that goes with them lives in src/data/spine.js.
//
// Robot frame throughout: x forward, y up, z right, metres, the floor under the swerve modules'
// centre at the origin (public/models/robot.json, `frame`).

/* ── shots ─────────────────────────────────────────────────────────────────
   A shot says what the camera looks at (`look`) and how big it is (`R`, the radius that encloses
   it), never where the camera is. Distance is solved from the screen: the subject is made `fill` of
   the free column wide and at most `fillH` of the height. That is what makes it scale — a 1280 laptop
   and a 1900 monitor get the same composition, not the same metres.

   side     -1 robot left of the copy, 0 centred, 1 right
   yaw      the robot's turn; negative shows its front, positive its back
   el       camera elevation, radians
   explode  0..1, the teardown
   dim      per assembly, how lit it stays (1 = fully)
   show     per assembly, how present it is: 0 has lifted it up and away out of frame. It moves
            rather than fades — fading switched whole assemblies to transparent mid-scroll, which
            recompiled shaders (a hitch) and broke depth sorting (a pop).
   prog     0..1, the mechanisms run the way the code drives them
   drive    0..1, the ending: drive off, shoot at the HUB, drive home
   labelSide 'far' sends every callout to the side away from the copy
   worldLook `look` is a world point rather than a robot one */
export const SHOTS = {
  title: { side: 0, yaw: -0.62, el: 0.2, look: [0, 0.28, 0], R: 0.56, fill: 0.62, fillH: 0.6 },
  team: { side: 1, yaw: -0.85, el: 0.18, look: [0, 0.28, 0], R: 0.56, fill: 0.78, fillH: 0.66 },
  explode: { side: 0, yaw: -0.5, el: 0.22, look: [0.14, 0.8, 0], R: 1.08, fill: 0.8, fillH: 0.92, explode: 1 },
  /* The shooter on its own: intake, hopper and floor lift out, the drive base stays as a dimmed
     plinth, and the robot turns to show its back. */
  mech: {
    side: 1, yaw: 2.25, el: 0.24, look: [-0.17, 0.32, -0.02], R: 0.42, fill: 0.72, fillH: 0.7,
    labelSide: 'far', show: { intake: 0, hopper: 0, floor: 0 }, dim: { drive: 0.3 },
  },
  /* Front to the right, back to the left: the battery's label goes one way and the PDP and
     breaker's the other, so no hairline has to cross the deck. */
  elec: {
    side: -1, yaw: 0.12, el: 1.0, look: [-0.01, 0.06, 0], R: 0.4, fill: 0.96, fillH: 0.74, explode: 1,
    show: { intake: 0, hopper: 0, floor: 0, shooter: 0, hood: 0 },
  },
  /* Nearly head-on, so the intake deploys toward the reader and every part the code moves sits on
     the far side, where its label goes. */
  prog: { side: 1, yaw: -1.2, el: 0.24, look: [0.06, 0.3, 0], R: 0.62, fill: 0.82, fillH: 0.68, prog: 1, labelSide: 'far' },
  catalyst: { side: -1, yaw: 0.55, el: 0.21, look: [0, 0.29, 0], R: 0.6, fill: 0.7, fillH: 0.66, prog: 1 },
  /* Framed in the world, not on the robot: it takes in the robot's home and the HUB. */
  lineage: {
    side: 1, yaw: -0.72, el: 0.26, look: [0.85, 0.62, -1.95], worldLook: true, R: 1.7, fill: 0.98, fillH: 0.9, drive: 1,
    /* A phone's band is about square: stand further back and look down more, so the HUB and the robot's
       whole run fit, the HUB's funnel included. */
    narrow: { el: 0.52, R: 1.95, look: [1.25, 0.38, -2.55] },
  },
}

export const GROUPS = ['drive', 'floor', 'hopper', 'intake', 'shooter', 'hood']
export const groupOfNode = (n) =>
  n === 'assembly-floor' ? 'floor'
    : n === 'assembly-hopper' ? 'hopper'
      : n === 'intake' || n === 'assembly-intake' ? 'intake'
        : n === 'assembly-shooter' ? 'shooter'
          : n === 'hood' ? 'hood'
            : 'drive'

/* ── the teardown ──────────────────────────────────────────────────────────
   assembly-drive and the swerve modules never move: the bake splits a module three ways for
   steering, so its gearbox sits in assembly-drive and moving `module-*` tears the wheel off its own
   gears.

   It comes apart top first and goes back bottom first, the order the bolts come out. Each layer
   starts earlier and travels further than the one under it, so at every point of the scroll a layer
   is above the one it sits on — peeling the floor before the hopper drove one through the other, and
   on the way back landed the hood inside a shooter still in the air. */
export const LAYERS = {
  hood: { dir: [0, 1, 0], d: 1.08, at: 0.0 },
  'assembly-shooter': { dir: [0, 1, 0], d: 0.8, at: 0.12 },
  intake: { dir: [1, 0, 0], d: 0.52, at: 0.14 },
  'assembly-intake': { dir: [1, 0, 0], d: 0.34, at: 0.2 },
  'assembly-hopper': { dir: [0, 1, 0], d: 0.5, at: 0.24 },
  'assembly-floor': { dir: [0, 1, 0], d: 0.24, at: 0.36 },
}

/* Where a removed assembly goes: up and away from the camera in world terms, so it leaves the frame
   whichever way the robot is turned — straight up would fly into the camera on the top-down
   electrical shot. Groups higher in the stack leave first. */
export const REMOVE_W = [0, 2.6, -3.2]
export const REMOVE_ORDER = { hood: 0, shooter: 0.08, hopper: 0.12, intake: 0.16, floor: 0.22 }

/* ── callout anchors ───────────────────────────────────────────────────────
   A node and a point in the robot's frame at rest. Never a roller: an anchor on a spinning node
   orbits its axle and drags the hairline round with it. The battery, PDP 2.0, 120 A breaker, MPMs and
   shooter Krakens are named parts in the source CAD (Assembly 1.gltf); it has no controller part, so
   nothing points at one. */
export const ANCHORS = {
  intake: ['intake', [0.31, 0.395, 0.22]],
  floor: ['assembly-floor', [0.12, 0.3, 0.27]],
  hopper: ['assembly-hopper', [0.16, 0.42, 0.368]],
  shooter: ['assembly-shooter', [-0.3, 0.3, 0.33]],
  hood: ['hood', [-0.1, 0.555, -0.26]],
  drive: ['module-fr', [0.279, 0.1, 0.298]],
  flywheel: ['assembly-shooter', [-0.3, 0.53, 0.22]],
  mhood: ['hood', [-0.085, 0.552, 0.22]],
  feeder: ['assembly-shooter', [-0.1, 0.37, 0.22]],
  battery: ['assembly-drive', [0.22, 0.108, 0.05]],
  breaker: ['assembly-drive', [-0.277, 0.131, 0.0]],
  pdp: ['assembly-drive', [-0.195, 0.069, 0.07]],
  mpm: ['assembly-drive', [0.036, 0.062, -0.215]],
  swerve: ['module-fl', [0.279, 0.01, -0.298]], // on the steering axis, so steering never swings it
  aim: ['hood', [-0.1, 0.555, -0.22]],
  deploy: ['intake', [0.31, 0.395, -0.22]],
  shot: ['assembly-shooter', [-0.303, 0.254, -0.293]], // a shooter Kraken X60
}

/* ── the routine the Programming shot runs ─────────────────────────────────
   A robot does not oscillate; it runs a routine. Targets change in steps and then hold. */
export const ROUTINE = [
  // seconds into a 12 s loop → what the code asks for from then on
  { t: 0.0, drive: 'fwd', wheel: 1, intake: 1, hood: 15, fly: 0, feed: 0 },
  { t: 1.9, drive: 'strafe' },
  { t: 3.6, drive: 'spin', wheel: 0.8 },
  { t: 5.2, drive: 'x', wheel: 0, hood: 34, fly: 1 }, // lock the modules, aim, spin up
  { t: 6.7, feed: 1 }, // shoot
  { t: 8.0, feed: 0, hood: 15, fly: 0 },
  { t: 8.6, drive: 'crab', wheel: 1, intake: 0 },
  { t: 10.6, drive: 'fwd', wheel: 0 },
]
export const ROUTINE_LOOP = 12
export const HEADING = { fwd: 0, strafe: Math.PI / 2, crab: -0.6 }

/* ── the ending ────────────────────────────────────────────────────────────
   The field the last shot frames, in world metres; the robot's home is the origin. What the robot does
   on it — collect, score, collect again — is the behaviour in autonomy.js. */
export const HUB_AT = [1.55, 0, -4.9]
/* The FUEL it starts with: a straight row — four rows of two, inside the intake's width — just right
   of home, so the first pass is one clean line. */
export const FUEL_START = (() => {
  const a = [1.0, -0.4]
  const b = [1.65, -1.25]
  const L = Math.hypot(b[0] - a[0], b[1] - a[1])
  const ux = (b[0] - a[0]) / L
  const uz = (b[1] - a[1]) / L
  const out = []
  for (let r = 0; r < 4; r++) for (const side of [-0.12, 0.12]) out.push([a[0] + ux * r * 0.3 - uz * side, a[1] + uz * r * 0.3 + ux * side])
  return out
})()
/* Where scored FUEL rolls out to and stops, a different row each cycle. Both are measured to sit in the
   last shot's frame at 1440x900, clear of the copy column (which ends at 513 px) and away from the arc
   the robot shoots from, so every pass is a real drive across the carpet. */
export const FUEL_ROWS = [
  [[1.7, -3.4], [1.85, -1.95]], // deep, right of the HUB
  [[0.9, -0.85], [2.0, -0.5]], // near, toward the camera
]
/* Where it fires from, one per cycle in turn: a bearing about the HUB (radians, atan2(dz, dx)) and a
   distance. All on the home side of the HUB and left of the paths FUEL rolls out along, so a rolling
   ball never crosses the robot; different each cycle, so the solved hood angle visibly changes. */
export const SHOT_SPOTS = [
  { bearing: 2.1, range: 2.7 },
  { bearing: 1.95, range: 3.0 },
  { bearing: 2.05, range: 2.45 },
]
