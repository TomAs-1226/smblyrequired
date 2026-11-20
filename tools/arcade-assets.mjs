// Import an arcade asset export (field, FUEL, robots) into public/arcade.
//
//   node tools/arcade-assets.mjs ~/Desktop/assets
//
// The export holds:
//   2026-rebuilt-field.glb   the arena, built from data/field.json's shapes (not FIRST's CAD)
//   fuel.glb                 one FUEL ball (a unit sphere scaled to 0.075 m)
//   robots/<slug>.glb        each robot, with `part:<joint>` nodes sitting on their joint
//                            pivots, a "Simulator capture" clip and one "Joint demo" clip per joint
//   data/robots/<slug>.json  joints, drive, intake, hopper, shooter, climb, shot tables
//   data/field.json          field constants and collision shapes, in a field-centred frame
//   inventory.json           which robots, their names, their order
//
// What lands in public/arcade (everything there ships on deploy):
//   field.glb, fuel.glb, robots/<slug>.glb   meshopt-compressed, names and clips untouched
//   robots/<slug>.json                        the descriptor minus what only the exporter needed
//   field.json                                colliders converted to the game's frame, plus constants
//   index.json                                the roster the robot picker reads
//
// Not copied: skins (none are shipped yet), data/motion (the same captures are the GLBs' clips),
// and 2026-rebuilt-field-playback.glb.
//
// Frames: the export's field frame has its origin at the centre of the field, y up, and z to the right
// seen from the blue wall (right-handed). The game's frame is the same one moved to the blue wall's
// left corner: X = x + L/2, Y = y, Z = z + W/2. Nothing is mirrored, so the model drops in as it is.
// Robot descriptors are in the robot's own frame (x forward, y up, z right) and need no conversion.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: node tools/arcade-assets.mjs <export folder>')
  process.exit(1)
}
const SRC = resolve(arg.replace(/^~/, homedir()))
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'arcade')
mkdirSync(join(OUT, 'robots'), { recursive: true })

const json = (p) => JSON.parse(readFileSync(join(SRC, p), 'utf8'))
const round = (v) => Math.round(v * 1e6) / 1e6

await MeshoptDecoder.ready
await MeshoptEncoder.ready
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder })

async function compress(from, to) {
  const doc = await io.read(join(SRC, from))
  doc.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER })
  await io.write(join(OUT, to), doc)
  const a = statSync(join(SRC, from)).size
  const b = statSync(join(OUT, to)).size
  console.log(`${to.padEnd(40)} ${(a / 1e6).toFixed(2)} MB -> ${(b / 1e6).toFixed(2)} MB`)
  return b
}

// ------------------------------------------------------------------ field
const field = json('data/field.json')
const L = field.dimensions.length
const W = field.dimensions.width
const P = ([x, y, z]) => [round(x + L / 2), round(y), round(z + W / 2)]

function convertShape(s) {
  const k = s.kind
  if (k === 'box') return { kind: 'box', center: P(s.center), size: s.size.map(round) }
  if (k === 'hull') {
    const pts = []
    for (let i = 0; i < s.points.length; i += 3) pts.push(...P([s.points[i], s.points[i + 1], s.points[i + 2]]))
    return { kind: 'hull', points: pts }
  }
  if (k === 'cylinder') {
    const [ax, ay, az] = s.axis || [0, 1, 0]
    return { kind: 'cylinder', center: P(s.center), radius: round(s.radius), length: round(s.length), axis: [ax, ay, az] }
  }
  throw new Error(`unknown shape kind ${k}`)
}

const colliders = []
for (const s of field.shapes) {
  if (s.flat || s.element === 'tape') continue
  colliders.push({
    element: s.element,
    name: s.name,
    alliance: s.alliance ?? null,
    fuelOnly: Boolean(s.fuelOnly),
    hub: Boolean(s.hub),
    ...convertShape(s.shape),
  })
}
for (const door of Object.values(field.doors || {})) {
  for (const part of door.parts) {
    colliders.push({ element: `door-${door.alliance}`, name: part.name, alliance: door.alliance, fuelOnly: false, hub: false, ...convertShape(part.shape) })
  }
}
// The hub nets stop FUEL, not robots: thin slabs along each panel.
for (const n of field.netPanels || []) {
  const corner = (u, v, w) => n.origin.map((o, i) => o + n.eu[i] * u + n.ev[i] * v + n.normal[i] * w)
  const pts = []
  for (const u of [0, n.width]) for (const v of [0, n.height]) for (const w of [-0.01, 0.01]) pts.push(...P(corner(u, v, w)))
  colliders.push({ element: `net-${n.alliance}`, name: n.name, alliance: n.alliance, fuelOnly: true, hub: true, kind: 'hull', points: pts })
}

const c = field.constants
const fieldOut = {
  source: 'data/field.json',
  frame: 'X along the field from the blue wall, Y up, Z across to the right seen from the blue wall (right-handed); metres',
  length: L,
  width: W,
  fuel: c.X,
  hub: c.Y,
  bump: c.c,
  trench: c.P,
  tower: c.D,
  depot: c.m,
  outpost: c.j,
  timing: c.e,
  points: c.W,
  robotLimits: c.$,
  startingLine: c.i,
  colliders,
}
writeFileSync(join(OUT, 'field.json'), JSON.stringify(fieldOut))
console.log(`field.json: ${colliders.length} colliders`)

let total = 0
total += await compress('2026-rebuilt-field.glb', 'field.glb')
total += await compress('fuel.glb', 'fuel.glb')

// ------------------------------------------------------------------ robots
const inventory = json('inventory.json')
const ranked = inventory.rankedNumbers || []
const KEEP = [
  'number', 'name', 'robotName', 'region', 'colors', 'joints', 'frame', 'bumper', 'mass', 'drive', 'hull',
  'reach', 'intake', 'hopper', 'feed', 'shooter', 'spin', 'brain', 'climb', 'trenchCut', 'shownAs',
]
const TRENCH_CLEAR = c.P.clearHeight
const index = []
for (const r of inventory.robots) {
  const slug = r.model.replace(/^robots\//, '').replace(/\.glb$/, '')
  if (!existsSync(join(SRC, r.model))) { console.warn(`missing ${r.model}`); continue }
  const d = json(r.descriptor)
  const slim = Object.fromEntries(KEEP.filter((k) => k in d).map((k) => [k, d[k]]))
  // The bumper cloth in each alliance's colour (the model is exported blue).
  slim.cloth = d.look?.cloth ?? null
  // Keep only the drive fields a game reads.
  slim.drive = {
    modules: d.drive.modules, wheelRadius: d.drive.wheelRadius, maxSpeed: d.drive.maxSpeed,
    restSteer: d.drive.restSteer, feel: d.drive.feel, wheelMu: d.drive.wheelMu,
  }
  writeFileSync(join(OUT, 'robots', `${slug}.json`), JSON.stringify(slim))
  total += await compress(r.model, `robots/${slug}.glb`)
  const top = Math.max(...d.hull.map((h) => h.centre[1] + h.half[1]))
  index.push({
    id: r.id,
    slug,
    number: r.shownAs?.number ?? d.number,
    version: r.shownAs?.version ?? null,
    team: r.team,
    robot: r.robot,
    publicRoster: r.publicRoster !== false,
    rank: ranked.includes(r.id) ? ranked.indexOf(r.id) + 1 : null,
    model: `robots/${slug}.glb`,
    descriptor: `robots/${slug}.json`,
    colors: d.colors,
    turret: Boolean(d.shooter?.turret),
    twinTurret: Boolean(d.shooter?.turret?.twin),
    shootsBack: Math.abs((d.shooter?.yawDeg ?? 0)) > 90,
    climb: d.climb?.level ?? 0,
    capacity: d.hopper?.capacity ?? 0,
    fireRate: d.shooter?.fireRate ?? 0,
    maxSpeed: d.drive?.feel?.maxSpeed ?? d.drive?.maxSpeed ?? 4,
    height: round(top),
    trench: top < TRENCH_CLEAR - 0.005 || Boolean(d.trenchCut),
    mass: d.mass?.mass,
    clips: r.jointDemos ?? null,
  })
}
index.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.number - b.number)
writeFileSync(join(OUT, 'index.json'), JSON.stringify({ source: 'arcade asset export', robots: index }, null, 1))
console.log(`index.json: ${index.length} robots, ${(total / 1e6).toFixed(1)} MB of models`)
