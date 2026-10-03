// Bake any robot's Onshape glTF export into a light, static display model for the website.
//
//   node tools/display-cad.mjs <in.gltf> --name genesis [--budget 260000] [--min-size 0.004]
//        [--drop <regex>]... [--drop-node <name | path | node:N | #N>]... [--config tools/display-cad/<robot>.json]
//        [--up +z] [--forward +x] [--max-mb 5] [--out public/models]
//   node tools/display-cad.mjs <in.gltf> --list        # every instance, its path and what would happen to it
//
// Writes <out>/<name>.glb and <out>/<name>.json. Unlike robot-cad.mjs this knows nothing about any one
// robot: no mechanisms, no pivots, nothing moves. It places every instance, drops fasteners and parts
// too small to read, simplifies to a triangle budget, turns the robot into the site's frame (y up,
// +x forward, origin on the floor under the drivetrain centre) and merges everything into one node with
// one primitive per material class, so a whole robot is a handful of draw calls on a turntable.
//
// --drop matches a regex (case-insensitive) against each part's name and its instance path.
// --drop-node removes a node and everything under it:
//   "CAGE (GE-25231) <1>"            any node of exactly that name (an "occurrence of X" wrapper also answers to X)
//   "Manipulator <1> / Coral"        a run of consecutive node names along an instance's chain
//   node:1359                        the glTF node with that index, for twins whose names and paths are identical
//   #42                              instance 42 as --list numbers it
// --config reads { drop, dropNode, orientation: { cadUp, cadForward } } from a JSON file; flags add to it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";

import { MATERIAL_CLASSES, baseName, classifyPart, colourTone, materialColour, partName } from "./robot-cad/classify.mjs";
import { creaseNormals, determinant3, multiply, normalize, principalAxes, transformDirection, transformPoint } from "./robot-cad/geometry.mjs";
import { listInstances, readGltfFile } from "./robot-cad/gltf-read.mjs";
import { readMeshFaces, weldFaces } from "./robot-cad/mesh.mjs";
import { simplify, simplifierReady } from "./robot-cad/simplify.mjs";
import { writeGlb } from "./robot-cad/write-glb.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INCH = 0.0254;

/* A 190 MB export parsed as one JSON string does not fit the default heap; rerun with room. */
if (v8.getHeapStatistics().heap_size_limit < 7e9 && !process.env.DISPLAY_CAD_CHILD) {
  const r = spawnSync(process.execPath, ["--max-old-space-size=8192", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, DISPLAY_CAD_CHILD: "1" },
  });
  process.exit(r.status ?? 1);
}

/* One material per class, named exactly by class: the site restyles by material name (robotRig.js).
   The look is what the part is made of, not the colour the CAD happened to give it. */
const LOOK = {
  aluminium: { colour: [196, 200, 206], metallic: 0.75, roughness: 0.38 },
  steel: { colour: [150, 152, 156], metallic: 0.9, roughness: 0.32 },
  black: { colour: [34, 35, 38], metallic: 0.25, roughness: 0.5 },
  motor: { colour: [28, 28, 30], metallic: 0.4, roughness: 0.45 },
  poly: { colour: [226, 232, 238], metallic: 0, roughness: 0.1, alpha: 0.4, doubleSided: true },
  print: { colour: null, metallic: 0, roughness: 0.75 }, // the CAD's own colour: teams print in their colours
  belt: { colour: [24, 24, 27], metallic: 0, roughness: 0.85 },
  tread: { colour: [22, 23, 25], metallic: 0, roughness: 0.92 },
  electronics: { colour: [40, 41, 45], metallic: 0.1, roughness: 0.6 },
  other: { colour: null, metallic: 0.1, roughness: 0.6 },
};
const BUMPER_LOOK = { metallic: 0, roughness: 0.95 }; // Cordura over pool noodle

/* Hardware the shared rules miss because Onshape glues a part number on with "_" (a word character). */
const EXTRA_DROPS = [["fastener", /(SHCS|BHCS|FHCS|SHSS)(_|\b)|locknut|\bscrew\b|\bnut\b|\brivet/i]];
/* Near-white parts are bare aluminium in Onshape's default palette; only these names make them clear. */
const POLY_NAME = /\bpoly|lexan|polycarb|funnel|shield|window|guard|\bcover\b/i;

/* ---- arguments ---- */

function parseArgs(argv) {
  const out = { input: null, name: null, budget: 260000, maxBytes: 5e6, minSize: 0.004, crease: 35, drop: [], dropNode: [], up: null, forward: null, outDir: join(root, "public", "models"), list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") out.name = argv[++i];
    else if (a === "--budget") out.budget = Number(argv[++i]);
    else if (a === "--max-mb") out.maxBytes = Number(argv[++i]) * 1e6;
    else if (a === "--min-size") out.minSize = Number(argv[++i]);
    else if (a === "--crease") out.crease = Number(argv[++i]);
    else if (a === "--drop") out.drop.push(new RegExp(argv[++i], "i"));
    else if (a === "--drop-node") out.dropNode.push(argv[++i]);
    else if (a === "--up") out.up = parseAxis(argv[++i]);
    else if (a === "--forward") out.forward = parseAxis(argv[++i]);
    else if (a === "--out") out.outDir = resolve(argv[++i]);
    else if (a === "--list") out.list = true;
    else if (a === "--config") {
      const path = resolve(argv[++i]);
      const config = JSON.parse(readFileSync(path, "utf8"));
      out.config = path;
      for (const re of config.drop ?? []) out.drop.push(new RegExp(re, "i"));
      for (const q of config.dropNode ?? []) out.dropNode.push(q);
      if (config.orientation?.cadUp && !out.up) out.up = vectorAxis(config.orientation.cadUp);
      if (config.orientation?.cadForward && !out.forward) out.forward = vectorAxis(config.orientation.cadForward);
    }
    else if (!a.startsWith("--")) out.input = resolve(a);
    else throw new Error(`unknown option ${a}`);
  }
  if (!out.input) throw new Error("usage: node tools/display-cad.mjs <in.gltf> --name <name> [options]");
  if (!out.list && !/^[a-z0-9][a-z0-9-]*$/i.test(out.name ?? "")) throw new Error("--name must be a plain file stem, e.g. genesis");
  if (!(out.budget > 1000)) throw new Error("--budget must be a triangle count above 1000");
  return out;
}

/** "+x", "-z" → { axis: 0..2, sign: ±1 }, a direction in the CAD's own frame. */
function parseAxis(s) {
  const m = /^([+-]?)([xyz])$/i.exec(String(s ?? ""));
  if (!m) throw new Error(`axis must be one of +x -x +y -y +z -z, not "${s}"`);
  return { axis: "xyz".indexOf(m[2].toLowerCase()), sign: m[1] === "-" ? -1 : 1 };
}
/** [0, -1, 0] → { axis: 1, sign: -1 }; principal axes only. */
function vectorAxis(v) {
  const k = v.findIndex((x) => Math.abs(x) > 0.5);
  if (k < 0 || v.filter((x) => Math.abs(x) > 1e-6).length !== 1) throw new Error(`orientation vector ${JSON.stringify(v)} is not a principal axis`);
  return { axis: k, sign: Math.sign(v[k]) };
}
const axisName = (d) => `${d.sign < 0 ? "-" : "+"}${"xyz"[d.axis]}`;
const axisVector = (d) => [0, 1, 2].map((k) => (k === d.axis ? d.sign : 0));

/**
 * Whether --drop-node `query` removes this instance: `node:N` if node N is on its chain, `#N` if it is
 * instance N, otherwise if the query's "/"-separated names match a run of consecutive nodes on the
 * chain exactly (case and spacing aside). "occurrence of X" also answers to "X".
 */
const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
function dropNodeMatches(query, part) {
  const q = query.trim();
  if (/^node:\d+$/i.test(q)) return part.chainIndices.includes(Number(q.slice(5)));
  if (/^#\d+$/.test(q)) return Number(q.slice(1)) === part.index;
  const want = q.split("/").map(norm).filter(Boolean);
  const names = part.chainNames.map((n) => [norm(n), norm(String(n ?? "").replace(/^occurrence of\s*/i, ""))]);
  for (let s = 0; s + want.length <= names.length; s++) {
    if (want.every((w, i) => names[s + i].includes(w))) return true;
  }
  return false;
}

/* ---- small helpers ---- */

const log = (...args) => console.log(...args);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const round = (v, digits = 4) => (Array.isArray(v) ? v.map((x) => round(x, digits)) : Number(v.toFixed(digits)));

function writeAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** World-space box of a part from its faces' local vertices (exact, not the transformed local box). */
function worldBox(part) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const m = part.world;
  for (const f of part.faces) {
    const p = f.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      for (let k = 0; k < 3; k++) {
        const v = m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  return { min, max };
}

/* ---- main ---- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.input)) throw new Error(`no CAD export at ${args.input}`);
  const started = Date.now();
  const inputBytes = statSync(args.input).size;
  log(`reading ${args.input} (${(inputBytes / 1e6).toFixed(1)} MB)`);
  const gltf = readGltfFile(args.input);
  const { json } = gltf;

  /* ---- every placed instance ---- */
  const faceCache = new Map();
  const facesOf = (mesh) => {
    if (!faceCache.has(mesh)) faceCache.set(mesh, readMeshFaces(gltf, mesh));
    return faceCache.get(mesh);
  };
  const parts = listInstances(gltf, multiply).map((inst, index) => {
    const chain = inst.chain.map((i) => json.nodes[i]);
    const leaf = chain[chain.length - 1];
    const occurrence = chain.length > 1 ? chain[chain.length - 2] : null;
    const name = partName(leaf.name, occurrence?.name);
    const assemblies = chain.slice(0, -1).filter((n) => !/^occurrence of /i.test(n.name ?? ""));
    const path = [...assemblies.map((n) => String(n.name ?? "").trim()), name || "(unnamed)"].join(" / ");
    const top = assemblies.length > 1 ? baseName(assemblies[1].name) : "";
    const faces = facesOf(inst.mesh);
    const byColour = new Map();
    let triangles = 0;
    for (const f of faces) {
      const c = materialColour(json.materials?.[f.material]).join(",");
      byColour.set(c, (byColour.get(c) || 0) + f.area);
      triangles += f.indices.length / 3;
    }
    const colour = [...byColour].sort((a, b) => b[1] - a[1])[0]?.[0].split(",").map(Number) ?? [200, 200, 200];
    const part = { index, node: inst.node, chainIndices: inst.chain, chainNames: chain.map((n) => n.name), name, path, top, mesh: inst.mesh, world: inst.world, faces, colour, triangles };
    part.box = worldBox(part);
    part.size = Math.hypot(...part.box.max.map((v, k) => v - part.box.min[k]));
    return part;
  });
  const sourceTriangles = parts.reduce((s, p) => s + p.triangles, 0);
  log(`  ${parts.length} instances of ${json.meshes.length} meshes, ${fmt(sourceTriangles)} triangles placed`);

  /* ---- what to keep, and what it is made of ---- */
  for (const p of parts) {
    const byNode = args.dropNode.find((q) => dropNodeMatches(q, p));
    const byRegex = args.drop.find((re) => re.test(p.name) || re.test(p.path));
    if (byNode) Object.assign(p, { keep: false, reason: `--drop-node "${byNode}"` });
    else if (byRegex) Object.assign(p, { keep: false, reason: `--drop ${byRegex.source}` });
    else {
      const extra = EXTRA_DROPS.find(([, re]) => re.test(p.name));
      const decision = extra ? { keep: false, reason: extra[0] } : classifyPart({ name: p.name, path: p.path.split(" / "), colour: p.colour, size: p.size }, { minSize: args.minSize });
      Object.assign(p, { keep: decision.keep, cls: decision.cls ?? null, reason: decision.reason ?? null });
      if (p.keep) {
        const tone = colourTone(p.colour);
        const namedPoly = /\bpoly(carbonate)?\b|\blexan\b|\bOD x\b/i.test(p.name);
        /* classify.mjs reads near-white as polycarbonate; most CAD draws bare aluminium near-white. */
        if (p.cls === "poly" && !namedPoly) p.cls = POLY_NAME.test(p.name) ? "poly" : "aluminium";
        else if (p.cls === "aluminium" && POLY_NAME.test(p.name) && tone.value >= 0.85) p.cls = "poly";
        /* Neutral greys that no rule named: light is machined metal, dark is anodised or black plastic. */
        if (p.cls === "other" && tone.saturation < 0.15) p.cls = tone.value >= 0.45 ? "aluminium" : "black";
      }
    }
  }

  if (args.list) {
    for (const p of parts) log(`#${p.index}\tnode:${p.chainIndices.at(-2) ?? p.node}\t${p.keep ? p.cls : `DROP ${p.reason}`}\t${fmt(p.triangles)} tris\t${(p.size * 1000).toFixed(0)} mm\t${p.path}`);
    return;
  }

  const kept = parts.filter((p) => p.keep);
  const evidence = [];

  /* ---- up: the axis along which the wheels sit on the floor ---- */
  const treads = kept.filter((p) => p.cls === "tread");
  let up = args.up;
  if (up) evidence.push(`up ${axisName(up)} (CAD) given by ${args.config ? "--up or --config" : "--up"}`);
  else {
    let best = null;
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [1, -1]) {
        const low = (p) => (sign > 0 ? p.box.min[axis] : -p.box.max[axis]);
        const floor = Math.min(...kept.map(low));
        const onFloor = treads.filter((p) => low(p) - floor < 0.01);
        const score = onFloor.length;
        if (!best || score > best.score) best = { axis, sign, score, onFloor };
      }
    }
    if (!best || best.score < 3) throw new Error(`could not find the wheels on the floor (${treads.length} wheel/tread parts); pass --up`);
    up = { axis: best.axis, sign: best.sign };
    evidence.push(`up ${axisName(up)} (CAD): ${best.score} wheel/tread parts touch the lowest plane along it (${[...new Set(best.onFloor.map((p) => baseName(p.name)))].join(", ")}), no other direction has as many`);
  }
  const upV = axisVector(up);
  const along = (p, d) => p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
  const lowAlong = (p) => (up.sign > 0 ? p.box.min[up.axis] : -p.box.max[up.axis]);
  const floor = Math.min(...kept.map(lowAlong));
  const wheels = treads.filter((p) => lowAlong(p) - floor < 0.01);
  if (wheels.length < 3) throw new Error(`only ${wheels.length} wheels touch the floor along ${axisName(up)}`);

  /* The drivetrain centre: the middle of the wheels' footprint. */
  const wmin = [Infinity, Infinity, Infinity], wmax = [-Infinity, -Infinity, -Infinity];
  for (const w of wheels) for (let k = 0; k < 3; k++) {
    wmin[k] = Math.min(wmin[k], w.box.min[k]);
    wmax[k] = Math.max(wmax[k], w.box.max[k]);
  }
  /* Each wheel's own box is centred on its axle whatever way its module points; average those. */
  const hubs = wheels.map((w) => w.box.min.map((v, k) => (v + w.box.max[k]) / 2));
  const centre = [0, 1, 2].map((k) => (k === up.axis ? (up.sign > 0 ? floor : -floor) : hubs.reduce((s, h) => s + h[k], 0) / hubs.length));
  const span = (k) => Math.max(...hubs.map((h) => h[k])) - Math.min(...hubs.map((h) => h[k]));
  const driveTop = new Set(wheels.map((w) => w.top));
  evidence.push(`origin: floor at the wheels' lowest point, centred on the mean of the ${wheels.length} floor wheels' centres (wheel centres span ${round(span((up.axis + 1) % 3) * 1000, 0)} x ${round(span((up.axis + 2) % 3) * 1000, 0)} mm in CAD ${"xyz"[(up.axis + 1) % 3]} x ${"xyz"[(up.axis + 2) % 3]})`);

  /* ---- bumpers: a saturated red/blue ring round the drivetrain, low down ---- */
  const horizontal = [0, 1, 2].filter((k) => k !== up.axis);
  for (const p of kept) {
    const tone = colourTone(p.colour);
    const [r, g, b] = p.colour;
    const height = p.box.max[up.axis] - p.box.min[up.axis];
    const encloses = horizontal.every((k) => p.box.min[k] <= wmin[k] && p.box.max[k] >= wmax[k]);
    const low = lowAlong(p) - floor < 0.15 && height > 0.05 && height < 0.25;
    /* FRC bumpers are red or blue: one channel well above both others. */
    const teamColour = tone.saturation > 0.35 && ((r > 1.6 * g && r > 1.6 * b) || (b > 1.3 * r && b > 1.1 * g));
    if (/\bbumper/i.test(p.name) || (encloses && low && teamColour)) {
      p.cls = "other";
      p.bumper = true;
      evidence.push(`bumper: "${p.path}" (rgb ${p.colour.join(",")}, encloses the wheels, ${round(height * 1000, 0)} mm tall)`);
    }
  }

  /* ---- forward ---- */
  let forward = args.forward;
  const candidates = [];
  for (const axis of horizontal) for (const sign of [1, -1]) candidates.push({ axis, sign });
  if (forward) {
    if (forward.axis === up.axis) throw new Error("--forward cannot be along --up");
    evidence.push(`forward ${axisName(forward)} (CAD) given by ${args.config ? "--forward or --config" : "--forward"}`);
  } else {
    const centroidOf = (list) => {
      const c = [0, 0, 0];
      for (const p of list) for (let k = 0; k < 3; k++) c[k] += (p.box.min[k] + p.box.max[k]) / 2 / list.length;
      return c;
    };
    const front = kept.filter((p) => /\bfront\b/i.test(p.path));
    const back = kept.filter((p) => /\b(back|rear)\b/i.test(p.path));
    if (front.length || back.length) {
      const f = front.length ? centroidOf(front) : centre;
      const b = back.length ? centroidOf(back) : centre;
      const d = horizontal.map((k) => f[k] - b[k]);
      const k = Math.abs(d[0]) >= Math.abs(d[1]) ? 0 : 1;
      forward = { axis: horizontal[k], sign: Math.sign(d[k]) || 1 };
      evidence.push(`forward ${axisName(forward)} (CAD): parts named Front (${front.length}) / Back or Rear (${back.length}) lie that way round`);
    } else {
      /* The scoring side: the direction the mechanisms reach furthest past the drivetrain. */
      const mech = kept.filter((p) => !p.bumper && !driveTop.has(p.top));
      const reach = candidates.map((d) => {
        const edge = (p) => (d.sign > 0 ? p.box.max[d.axis] : -p.box.min[d.axis]);
        const wheelEdge = d.sign > 0 ? wmax[d.axis] : -wmin[d.axis];
        let best = -Infinity, who = null;
        for (const p of mech) if (edge(p) > best) { best = edge(p); who = p; }
        return { d, past: best - wheelEdge, who };
      }).sort((a, b) => b.past - a.past);
      forward = reach[0].d;
      const margin = reach[0].past - reach[1].past;
      evidence.push(`forward ${axisName(forward)} (CAD): no Front/Back part names, so the scoring side — mechanisms reach ${round(reach[0].past * 1000, 0)} mm past the wheels that way ("${reach[0].who?.path}"), ${round(margin * 1000, 0)} mm more than any other side (${reach.map((r) => `${axisName(r.d)} ${round(r.past * 1000, 0)}`).join(", ")} mm). Override with --forward if the drive's front differs`);
    }
  }

  /* CAD → site: x = forward, y = up, z = x × y; then the origin moves to the drivetrain centre. */
  const fx = axisVector(forward), uy = upV;
  const zz = [fx[1] * uy[2] - fx[2] * uy[1], fx[2] * uy[0] - fx[0] * uy[2], fx[0] * uy[1] - fx[1] * uy[0]];
  const t = [-along(centre, fx), -along(centre, uy), -along(centre, zz)];
  /* Column-major, rows fx / uy / zz. */
  const toSite = [fx[0], uy[0], zz[0], 0, fx[1], uy[1], zz[1], 0, fx[2], uy[2], zz[2], 0, t[0], t[1], t[2], 1];

  /* ---- simplification, searched to fit the budget ---- */
  await simplifierReady;
  const welded = new Map();
  for (const p of kept) {
    if (welded.has(p.mesh)) continue;
    const mesh = weldFaces(p.faces);
    const pa = mesh.indices.length ? principalAxes(mesh.positions, mesh.indices) : null;
    /* A hollow tube's thinnest feature is its wall, not its outside: FRC rectangular tube is 1/16 in wall. */
    const wall = /\btube\b/i.test(p.name) && !/\bOD x\b/i.test(p.name) ? 0.0625 * INCH : Infinity;
    welded.set(p.mesh, { mesh, thickness: Math.min(pa ? pa.axes[0].extent : 0, wall), size: p.size, cache: new Map(), shaded: new Map() });
  }
  const errorFor = (w, global) => Math.max(0.00005, Math.min(global, 0.03 * w.size, 0.8 * Math.max(w.thickness, 0.0005)));
  const simplified = (w, global) => {
    const k = errorFor(w, global).toFixed(7);
    if (!w.cache.has(k)) w.cache.set(k, simplify(w.mesh, Number(k)));
    return w.cache.get(k);
  };
  const countAt = (global) => kept.reduce((s, p) => s + simplified(welded.get(p.mesh), global).indices.length / 3, 0);
  mkdirSync(args.outDir, { recursive: true });
  const glbPath = join(args.outDir, `${args.name}.glb`);
  const tmpGlb = `${glbPath}.tmp-${process.pid}`;
  /* One bake at a triangle budget: search the error, merge by class, write the temporary GLB. */
  const bake = async (budget) => {
    let lo = 0.0001, hi = 0.02, chosen = hi;
    if (countAt(lo) <= budget) chosen = lo;
    else {
      for (let i = 0; i < 14; i++) {
        const mid = Math.sqrt(lo * hi);
        if (countAt(mid) <= budget) hi = chosen = mid;
        else lo = mid;
      }
    }
    log(`simplifying: error ${(chosen * 1000).toFixed(3)} mm (capped per part at 3% of its size and 80% of its thickness) -> ${fmt(countAt(chosen))} triangles`);

    /* ---- merge by material class ---- */
    const keyOf = (p) => (p.cls === "other" ? `other|${p.colour.join(",")}` : p.cls);
    const groups = new Map(); // key -> { chunks: [{ positions, normals, indices, count }] }
    const colourArea = new Map(); // key -> Map(colour -> triangles), for classes that keep the CAD colour
    let mirrored = 0;
    for (const p of kept) {
      const w = welded.get(p.mesh);
      const ek = errorFor(w, chosen).toFixed(7);
      if (!w.shaded.has(ek)) {
        const s = simplified(w, chosen);
        w.shaded.set(ek, s.indices.length ? creaseNormals(s.positions, s.indices, args.crease) : null);
      }
      const shaded = w.shaded.get(ek);
      if (!shaded) continue;
      const m = multiply(toSite, p.world);
      const flip = determinant3(m) < 0;
      if (flip) mirrored++;
      const key = keyOf(p);
      const tally = colourArea.get(key) ?? new Map();
      tally.set(p.colour.join(","), (tally.get(p.colour.join(",")) || 0) + shaded.indices.length / 3);
      colourArea.set(key, tally);
      const g = groups.get(key) ?? { chunks: [] };
      groups.set(key, g);
      const n = shaded.positions.length / 3;
      let chunk = g.chunks[g.chunks.length - 1];
      if (!chunk || chunk.count + n > 65535) g.chunks.push((chunk = { positions: [], normals: [], indices: [], count: 0 }));
      for (let i = 0; i < n; i++) {
        const q = transformPoint(m, [shaded.positions[i * 3], shaded.positions[i * 3 + 1], shaded.positions[i * 3 + 2]]);
        /* M n stays the outward normal under a mirror (M is orthogonal); only the winding flips. */
        const nn = normalize(transformDirection(m, [shaded.normals[i * 3], shaded.normals[i * 3 + 1], shaded.normals[i * 3 + 2]]));
        chunk.positions.push(q[0], q[1], q[2]);
        chunk.normals.push(nn[0], nn[1], nn[2]);
      }
      for (let i = 0; i < shaded.indices.length; i += 3) {
        const a = shaded.indices[i] + chunk.count, b = shaded.indices[i + 1] + chunk.count, c = shaded.indices[i + 2] + chunk.count;
        if (flip) chunk.indices.push(a, c, b);
        else chunk.indices.push(a, b, c);
      }
      chunk.count += n;
    }

    /* ---- materials ---- */
    const materials = new Map();
    const bumperKeys = new Set(kept.filter((p) => p.bumper).map(keyOf));
    for (const key of groups.keys()) {
      const cls = key.split("|")[0];
      if (!MATERIAL_CLASSES.includes(cls)) throw new Error(`class ${cls} is not in the site's vocabulary`);
      const look = LOOK[cls];
      const dominant = [...(colourArea.get(key) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0].split(",").map(Number) ?? [200, 200, 200];
      const bumper = bumperKeys.has(key);
      materials.set(key, {
        name: cls,
        colour: look.colour ?? dominant,
        metallic: bumper ? BUMPER_LOOK.metallic : look.metallic,
        roughness: bumper ? BUMPER_LOOK.roughness : look.roughness,
        alpha: look.alpha,
        doubleSided: look.doubleSided,
        extras: bumper ? { class: cls, bumper: true } : { class: cls },
      });
    }

    /* ---- write ---- */
    const primitives = [];
    const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const [key, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const c of g.chunks) {
        const positions = Float32Array.from(c.positions);
        for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
          bbox.min[k] = Math.min(bbox.min[k], positions[i + k]);
          bbox.max[k] = Math.max(bbox.max[k], positions[i + k]);
        }
        primitives.push({ material: key, positions, normals: Float32Array.from(c.normals), indices: Uint32Array.from(c.indices) });
      }
    }
    const written = await writeGlb(tmpGlb, { name: args.name, primitives }, materials, {
      generator: `smblyrequired display-cad from "${basename(args.input)}" (${json.asset?.generator ?? "unknown"})`,
      extras: { frame: "y up, +x forward, origin on the floor under the drivetrain centre" },
    });
    return { written, chosen, bbox, mirrored, materials };
  };
  /* Crease splits make vertex count, and so bytes, run ahead of triangles: shrink the budget until it fits. */
  let budget = args.budget;
  let result = await bake(budget);
  for (let attempt = 0; attempt < 4 && result.written.bytes > args.maxBytes; attempt++) {
    budget = Math.floor(budget * (args.maxBytes / result.written.bytes) * 0.98);
    log(`  ${(result.written.bytes / 1e6).toFixed(2)} MB is over --max-mb ${args.maxBytes / 1e6}; rebaking at ${fmt(budget)} triangles`);
    result = await bake(budget);
  }
  const { written, chosen, bbox, mirrored, materials } = result;
  renameSync(tmpGlb, glbPath);

  const dropped = new Map();
  for (const p of parts.filter((q) => !q.keep)) {
    const k = `${baseName(p.name) || "(unnamed)"}|${p.reason}`;
    const row = dropped.get(k) ?? { name: baseName(p.name) || "(unnamed)", reason: p.reason, count: 0 };
    row.count++;
    dropped.set(k, row);
  }
  const size = bbox.max.map((v, k) => v - bbox.min[k]);
  const manifest = {
    name: args.name,
    source: { file: basename(args.input), triangles: sourceTriangles, bytes: inputBytes },
    triangles: written.triangles,
    bytes: written.bytes,
    frame: { length: round(size[0]), width: round(size[2]), height: round(size[1]) },
    bbox: { min: round(bbox.min), max: round(bbox.max) },
    materials: [...materials.values()].map((m) => ({ name: m.name, colour: m.colour, bumper: !!m.extras.bumper })),
    dropped: [...dropped.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    orientation: {
      up: axisName(up),
      forward: axisName(forward),
      cad: "axes are the export's own; frame is y up, +x forward, origin on the floor under the drivetrain centre",
      evidence,
    },
    bake: { budget: args.budget, bakedAt: budget, maxMb: args.maxBytes / 1e6, minSize: args.minSize, errorMm: round(chosen * 1000, 3), config: args.config ? basename(args.config) : null, drop: args.drop.map((r) => r.source), dropNode: args.dropNode, mirroredInstances: mirrored },
  };
  writeAtomic(join(args.outDir, `${args.name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);

  log(`wrote ${glbPath}: ${fmt(written.triangles)} triangles, ${(written.bytes / 1e6).toFixed(2)} MB, ${written.primitives} primitives, ${materials.size} materials`);
  log(`  frame ${manifest.frame.length} x ${manifest.frame.width} x ${manifest.frame.height} m (length x width x height)`);
  for (const e of evidence) log(`  ${e}`);
  log(`  dropped ${parts.length - kept.length} of ${parts.length} instances; ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
