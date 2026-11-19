// Cycle Rush 3D — field, robots and match constants.
//
// A simplified take on the 2026 FRC game. Field geometry comes from the team's
// own 2026 robot code (frc.robot.field.RebuiltField / NumbersAiming), which is
// measured against the official welded field layout; the shift schedule from
// frc.robot.hub.FmsUtil. Everything else (rung heights, bump and trench sizes)
// is from the game manual, rounded.
//
// Coordinates: X runs the length of the field from the blue wall (0) to the red
// wall, Z runs across it, Y is up. Metres, seconds, kilograms. The field is
// rotationally symmetric: red's copy of anything is (L - x, W - z).

const IN = 0.0254

export const FIELD = { L: 16.541, W: 8.069 }
export const mirror = (p) => ({ ...p, x: FIELD.L - p.x, z: FIELD.W - p.z })

export const FUEL = {
  r: 0.075, // 5.91 in foam ball
  mass: 0.215,
  // Quadratic air drag as an acceleration: a = -K |v| v, with K = ½ρCdA / m.
  K: (0.5 * 1.2 * 0.47 * Math.PI * 0.075 * 0.075) / 0.215,
}

// The rest of the layout is maple-sim's 2026 arena (Arena2026Rebuilt,
// RebuiltHub, RebuiltOutpost; BSD-3-Clause, Shenzhen Robotics Alliance), which
// agrees with the team's RebuiltField to the millimetre where both have a value.
const HUB_X = 4.625594
const HUB_Z = 4.03463
const HUB_SIZE = 1.1938 // 47 in square
export const HUB = {
  size: HUB_SIZE,
  top: 72 * IN, // the opening fuel drops into (the hub model is 1.83 m tall)
  inner: 41 * IN,
  wall: 0.07,
  blue: { x: HUB_X, z: HUB_Z },
  red: { x: FIELD.L - HUB_X, z: FIELD.W - HUB_Z },
  // Scored fuel leaves through four exits on the neutral-zone side: 0.5 m below the
  // goal, 15° down, at 2 m/s, fanned ±11.25° and ±33.75° (RebuiltHub.blueShootPoses).
  exits: [
    { dz: 0.447675, yaw: 33.75 },
    { dz: 0.149225, yaw: 11.25 },
    { dz: -0.149225, yaw: -11.25 },
    { dz: -0.447675, yaw: -33.75 },
  ],
  exitOut: 0.5969 - 0.0282, // from the hub centre, toward the neutral zone
  exitY: 1.5748 - 0.5,
}

// The hub line is closed off by a bump on each side of the hub (73 in long),
// then a 12 in trench wall, then the trench lane against the field wall.
const BUMP_LEN = 73 * IN
const TRENCH_WALL_Z = 1.43113 // centre of the wall, from the side wall
const TRENCH_WALL_T = 12 * IN
export const TRENCH = {
  width: TRENCH_WALL_Z - TRENCH_WALL_T / 2, // the lane under the roof
  depth: 47 * IN,
  clearance: 22.25 * IN,
  roof: 0.2,
  wall: { z: TRENCH_WALL_Z, t: TRENCH_WALL_T, x: 4.61769 },
}
export const BUMP = {
  depth: 44.4 * IN,
  height: 6.5 * IN,
  top: 16 * IN,
  // z spans on blue's line; red's are mirrored
  spans: [
    [HUB_Z - HUB_SIZE / 2 - BUMP_LEN, HUB_Z - HUB_SIZE / 2],
    [HUB_Z + HUB_SIZE / 2, HUB_Z + HUB_SIZE / 2 + BUMP_LEN],
  ],
}
export const LANES = {
  trench: [TRENCH.width / 2, FIELD.W - TRENCH.width / 2],
  bump: BUMP.spans.map(([a, b]) => (a + b) / 2),
}

// The tower: two uprights 33.75 in apart, 1.06 m off the alliance wall, with
// three rungs between them. A climb starts from the box in front of it.
const UPRIGHT_X = 1.06204
const UPRIGHT_Z = 3.31524
const UPRIGHT_GAP = 33.75 * IN
export const TOWER = {
  blue: { x: UPRIGHT_X, z: UPRIGHT_Z + UPRIGHT_GAP / 2 },
  red: { x: FIELD.L - UPRIGHT_X, z: FIELD.W - UPRIGHT_Z - UPRIGHT_GAP / 2 },
  gap: UPRIGHT_GAP,
  upright: { x: 3.5 * IN, z: 1.5 * IN, h: 1.9 },
  width: UPRIGHT_GAP,
  rungs: [27 * IN, 45 * IN, 63 * IN], // L1, L2, L3
  zone: { from: 0.05, depth: 1.35, width: 2.8 }, // measured from the uprights toward the field
}

// Starting fuel (Arena2026Rebuilt.placeGamePiecesOnField, full mode): a 12 × 30
// block across midfield and a 4 × 6 depot on each alliance wall, balls almost
// touching. The outposts hold 24 more each, fed in by the human player.
const PITCH_X = 5.991 * IN
const PITCH_Z = 5.95 * IN
export const LAYOUT = {
  pitch: { x: PITCH_X, z: PITCH_Z },
  centre: { x: 7.35737, z: 1.724406, nx: 12, nz: 30 },
  depots: {
    blue: { x: 0.02, z: 5.53, nx: 4, nz: 6 },
    red: { x: 16.0274, z: 1.646936, nx: 4, nz: 6 },
  },
}
export const DEPOT = {
  blue: { x: 0.02 + (1.5 * PITCH_X), z: 5.53 + 2.5 * PITCH_Z },
  red: { x: 16.0274 + 1.5 * PITCH_X, z: 1.646936 + 2.5 * PITCH_Z },
  w: 4 * PITCH_X + 0.05,
  d: 6 * PITCH_Z + 0.05,
}
export const OUTPOST = {
  blue: { x: 0, z: 0.665988 },
  red: { x: FIELD.L, z: 7.403338 },
  holds: 24,
  feedEvery: 0.15, // seconds per ball from the human player
  reach: 1.15, // robot centre within this of the chute, intake toward the wall
}

// ------------------------------------------------------------- match
// Match time in seconds from the start of auto (FmsUtil, without the 3 s
// auto→teleop pause, which a browser game does not need).
export const MATCH = {
  countdown: 3,
  auto: 20,
  transition: 30, // auto + 10 s, both hubs live
  shifts: [30, 55, 80, 105], // four 25 s shifts, alternating
  endgame: 130, // last 30 s, both hubs live
  total: 160,
}

export const POINTS = {
  fuel: 1,
  climb: [10, 20, 30],
}

// ------------------------------------------------------------- robots
// len × wid includes bumpers. `height` decides who fits under a trench.
// hood: launch angle above horizontal. exit: the fastest the shooter can throw.
export const ARCHETYPES = {
  turret: {
    label: 'Turret',
    blurb: 'Aims itself and shoots on the move. Too tall for the trench.',
    len: 0.86, wid: 0.86, height: 0.72, mass: 56,
    speed: 4.4, accel: 9, yawRate: 7,
    capacity: 30, fireRate: 7, hood: 62, exit: 12.5, turret: true,
    intake: 0.72, climb: 2, climbTime: 4.5,
  },
  trench: {
    label: 'Trench runner',
    blurb: 'Low and quick under the trench. Fixed shooter: face the hub to score.',
    len: 0.82, wid: 0.82, height: 0.5, mass: 50,
    speed: 4.9, accel: 10, yawRate: 8,
    capacity: 22, fireRate: 9, hood: 60, exit: 12, turret: false,
    intake: 0.78, climb: 1, climbTime: 2.5,
  },
  hopper: {
    label: 'Hopper',
    blurb: 'Holds 50 and dumps them fast, but slow and short-ranged.',
    len: 0.9, wid: 0.9, height: 0.66, mass: 62,
    speed: 3.7, accel: 7, yawRate: 5.5,
    capacity: 50, fireRate: 13, hood: 70, exit: 8.6, turret: false,
    intake: 0.88, climb: 1, climbTime: 3,
  },
  bruiser: {
    label: 'Bruiser',
    blurb: 'Heavy, low, fast. Small hopper. Climbs to the top rung.',
    len: 0.84, wid: 0.84, height: 0.55, mass: 68,
    speed: 4.6, accel: 12, yawRate: 7,
    capacity: 12, fireRate: 5, hood: 62, exit: 12, turret: false,
    intake: 0.5, climb: 3, climbTime: 5,
  },
}
export const ARCHETYPE_IDS = Object.keys(ARCHETYPES)
export const PRELOAD = 8

export const DIFFICULTY = {
  rookie: { speed: 0.7, spreadSpeed: 0.045, spreadYaw: 0.06, react: 0.5, defend: false },
  regional: { speed: 0.85, spreadSpeed: 0.025, spreadYaw: 0.03, react: 0.25, defend: false },
  einstein: { speed: 0.97, spreadSpeed: 0.012, spreadYaw: 0.014, react: 0.1, defend: true },
}
export const PARTNER = { speed: 0.85, spreadSpeed: 0.022, spreadYaw: 0.028, react: 0.25, defend: false }
export const PLAYER_SPREAD = { spreadSpeed: 0.01, spreadYaw: 0.01 }
