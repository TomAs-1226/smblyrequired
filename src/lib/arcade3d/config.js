// Cycle Rush 3D — field, robots and match constants.
//
// A simplified take on the 2026 FRC game. Field geometry comes from the team's
// own 2026 robot code (frc.robot.field.RebuiltField / NumbersAiming), which is
// measured against the official welded field layout; the shift schedule from
// frc.robot.hub.FmsUtil. Everything else (rung heights, bump and trench sizes)
// is from the game manual, rounded.
//
// Coordinates: X runs the length of the field from the blue wall (0) to the red
// wall, Y is up, and Z runs across it to the RIGHT as seen from the blue driver
// station. That makes (X, Y, Z) right-handed, which is what three.js draws and
// what the robot and field models are built in; a WPILib field position (x, y)
// is (x, W - y) here. Getting this backwards draws the whole field mirrored.
// Metres, seconds, kilograms. The field is rotationally symmetric: red's copy of
// anything is (L - x, W - z).

const IN = 0.0254

export const FIELD = { L: 16.541, W: 8.069 }
export const mirror = (p) => ({ ...p, x: FIELD.L - p.x, z: FIELD.W - p.z })
/** A WPILib field y as this file's z. */
const fromY = (y) => FIELD.W - y

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
const HUB_Z = fromY(4.03463)
const HUB_SIZE = 1.1938 // 47 in square
export const HUB = {
  size: HUB_SIZE,
  top: 72 * IN, // the rim of the funnel (field.json: hub.rimHeight 1.8288)
  inner: 41 * IN,
  // The funnel narrows to a throat; fuel through it is scored (field.json hub.*).
  throat: 0.603504,
  throatY: 1.433576,
  boxTop: 0.765048,
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
  exitY: (0.765048 + 0.9906) / 2, // between hub.exitBottom and hub.exitTop
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
  blue: { x: UPRIGHT_X, z: fromY(UPRIGHT_Z + UPRIGHT_GAP / 2) },
  red: { x: FIELD.L - UPRIGHT_X, z: FIELD.W - fromY(UPRIGHT_Z + UPRIGHT_GAP / 2) },
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
// Each block is given by the centre of its ball with the lowest x and z. maple-sim
// gives the block's outer corner with the lowest WPILib y: a ball radius in from
// that, and the far end of the block in z.
const block = (x, y, nx, nz) => ({ x: x + FUEL.r, z: fromY(y + FUEL.r + (nz - 1) * PITCH_Z), nx, nz })
export const LAYOUT = {
  pitch: { x: PITCH_X, z: PITCH_Z },
  centre: block(7.35737, 1.724406, 12, 30),
  depots: {
    blue: block(0.02, 5.53, 4, 6),
    red: block(16.0274, 1.646936, 4, 6),
  },
}
export const DEPOT = {
  blue: { x: LAYOUT.depots.blue.x + 1.5 * PITCH_X, z: LAYOUT.depots.blue.z + 2.5 * PITCH_Z },
  red: { x: LAYOUT.depots.red.x + 1.5 * PITCH_X, z: LAYOUT.depots.red.z + 2.5 * PITCH_Z },
  w: 4 * PITCH_X + 0.05,
  d: 6 * PITCH_Z + 0.05,
}
export const OUTPOST = {
  blue: { x: 0, z: fromY(0.665988) },
  red: { x: FIELD.L, z: fromY(7.403338) },
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
// Robots come from their descriptors (robots.js). What is left here is how hard
// the computer drives them.
export const PRELOAD = 8

// spreadScale multiplies each robot's own measured shot spread.
export const DIFFICULTY = {
  rookie: { speed: 0.7, spreadSpeed: 0.04, spreadYaw: 0.05, spreadScale: 3, react: 0.5, defend: false },
  regional: { speed: 0.85, spreadSpeed: 0.02, spreadYaw: 0.025, spreadScale: 1.6, react: 0.25, defend: false },
  einstein: { speed: 0.97, spreadSpeed: 0.008, spreadYaw: 0.01, spreadScale: 1, react: 0.1, defend: true },
}
export const PARTNER = { speed: 0.85, spreadSpeed: 0.02, spreadYaw: 0.025, spreadScale: 1.5, react: 0.25, defend: false }
export const PLAYER_SPREAD = { spreadSpeed: 0, spreadYaw: 0 }

// ------------------------------------------------------------- modes
// total: seconds (null: no clock). shifts: the hub schedule (else always live).
export const MODES = {
  match: { label: 'Match', blueRobots: 3, redRobots: 3, total: MATCH.total, shifts: true, climb: true },
  solo: { label: 'Solo match', blueRobots: 1, redRobots: 0, total: MATCH.total, shifts: true, climb: true },
  skills: { label: 'Skills', blueRobots: 1, redRobots: 0, total: 60, shifts: false, climb: true },
  practice: { label: 'Practice', blueRobots: 1, redRobots: 0, total: null, shifts: false, climb: true },
}
