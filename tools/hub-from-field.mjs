// Cut the HUB out of the official field model, for the landing page's last shot.
//
//   node tools/hub-from-field.mjs <field.glb> [out.glb]
//
// The input is the decimated REBUILT field Catalyst Console bakes from FIRST's KOP field CAD
// (CatalystConsole/src/vendor/field.glb). That file is FIRST's model and is deliberately not committed
// there; this keeps only the one structure the site needs.
//
// The field is made of instanced meshes shared by both halves, so the HUB is not a node: it is every
// instance whose bounds sit inside the blue HUB's footprint. Each is baked to plain geometry, the lot is
// moved so the HUB stands on the origin, and turned from the file's z-up to glTF's y-up.

import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MeshoptSimplifier } from "meshoptimizer";

/* The HUB is backdrop for one shot: 1 mm of simplification error is invisible at that distance. */
const ERROR_M = 0.001;

// GLTFExporter reads its own Blob back through FileReader, which Node does not have.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then((b) => { this.result = `data:${blob.type};base64,${Buffer.from(b).toString("base64")}`; this.onloadend?.(); }); }
};

const [input, output = "public/models/hub.glb"] = process.argv.slice(2);
if (!input) { console.error("usage: node tools/hub-from-field.mjs <field.glb> [out.glb]"); process.exit(1); }

/* The blue HUB, in the field file's own frame (z up, field centre at the origin): 4.03 m from the
   centre line toward the blue wall, on the long axis, 1.19 m square. Found by locating the instances
   that rise to the 1.83 m opening there; the margin takes in the hood that overhangs it. */
const CENTRE = [-3.65, 0], HALF = 0.7, TOP = 2.4, FLOOR = 0.012;

const buf = readFileSync(input);
const gltf = await new Promise((ok, fail) =>
  /* Textures are skipped: the HUB is painted by material colour, and decoding images needs a browser. */
  new GLTFLoader().register(() => ({ name: "skip_textures", loadTexture: () => Promise.resolve(null) })).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", ok, fail));
gltf.scene.updateMatrixWorld(true);

const byMaterial = new Map();
const keep = (geometry, matrix, material) => {
  /* Positions arrive quantized (KHR_mesh_quantization, normalized int16). Transforming them in place
     writes field-scale metres back into a ±1 range and clamps every vertex, so unpack to floats first. */
  const src = geometry.attributes.position, xyz = new Float32Array(src.count * 3);
  for (let i = 0; i < src.count; i++) { xyz[i * 3] = src.getX(i); xyz[i * 3 + 1] = src.getY(i); xyz[i * 3 + 2] = src.getZ(i); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(xyz, 3));
  if (geometry.index) g.setIndex(geometry.index.clone());
  g.applyMatrix4(matrix);
  /* Kept per triangle, not per piece: much of the HUB's body is in meshes that also carry the other
     HUB or field-wide parts, so a whole-piece bounds test threw the body away and kept only the funnel.
     A triangle stays when it lies wholly inside the HUB's volume, off the carpet. */
  const flat = g.index ? g.toNonIndexed() : g, p = flat.attributes.position.array, kept = [];
  /* Every vertex inside, not just the centre: a big field triangle (a net, a ramp) can have its centre
     in the footprint and still run metres outside it. */
  const inVol = (i) => Math.abs(p[i] - CENTRE[0]) <= HALF && Math.abs(p[i + 1] - CENTRE[1]) <= HALF && p[i + 2] > FLOOR && p[i + 2] < TOP;
  for (let t = 0; t < p.length; t += 9) if (inVol(t) && inVol(t + 3) && inVol(t + 6)) for (let k = 0; k < 9; k++) kept.push(p[t + k]);
  if (!kept.length) return;
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(new Float32Array(kept), 3));
  const list = byMaterial.get(material) ?? [];
  list.push(out);
  byMaterial.set(material, list);
};

const m = new THREE.Matrix4();
gltf.scene.traverse((o) => {
  if (o.isInstancedMesh) for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); keep(o.geometry, m.premultiply(o.matrixWorld), o.material); m.identity(); }
  else if (o.isMesh) keep(o.geometry, o.matrixWorld, o.material);
});

const scene = new THREE.Scene();
const hub = new THREE.Group(); hub.name = "hub"; scene.add(hub);
let triangles = 0;
for (const [material, list] of byMaterial) {
  let merged = mergeVertices(mergeGeometries(list, false), 1e-5);
  merged.translate(-CENTRE[0], -CENTRE[1], 0);
  merged.rotateX(-Math.PI / 2);                         // z-up → y-up
  await MeshoptSimplifier.ready;
  const [index] = MeshoptSimplifier.simplify(Uint32Array.from(merged.index.array), merged.attributes.position.array,
    3, 0, ERROR_M, ["ErrorAbsolute"]);
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  /* Creased normals: flat panels stay flat, rounded tube stays round. */
  merged = mergeVertices(toCreasedNormals(merged, 35 * Math.PI / 180), 1e-5);   // re-index after creasing
  triangles += (merged.index ? merged.index.count : merged.attributes.position.count) / 3;
  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
    name: material.name, color: material.color, metalness: material.metalness ?? 0, roughness: material.roughness ?? 0.8 }));
  hub.add(mesh);
}
const box = new THREE.Box3().setFromObject(hub);
console.log(`hub: ${byMaterial.size} materials, ${triangles} triangles, ` +
  `size ${box.getSize(new THREE.Vector3()).toArray().map((v) => v.toFixed(2)).join(" x ")} m, top ${box.max.y.toFixed(2)} m`);

const glb = await new GLTFExporter().parseAsync(scene, { binary: true });
writeFileSync(output, Buffer.from(glb));
console.log(`wrote ${output} (${(glb.byteLength / 1024).toFixed(0)} KB)`);
