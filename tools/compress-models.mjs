// Compress the site's models in place with EXT_meshopt_compression.
//
//   node tools/compress-models.mjs            # every .glb in public/models
//   node tools/compress-models.mjs robot.glb  # just these
//
// The bakes (robot-cad, display-cad, hub-from-field) write plain quantized glTF. Meshopt compression
// packs those same buffers two to three times smaller without touching a node, an accessor's meaning
// or a name, so the manifests and everything that animates by node name stay valid. The site's
// loaders set three's MeshoptDecoder (src/components/robot/robotRig.js, loadModel).
//
// Idempotent: a file that is already compressed is left alone.
import { readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "models");
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

const names = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(dir).filter((f) => f.endsWith(".glb"));
for (const name of names) {
  const file = join(dir, name);
  const before = statSync(file).size;
  const doc = await io.read(file);
  if (doc.getRoot().listExtensionsUsed().some((e) => e.extensionName === "EXT_meshopt_compression")) {
    console.log(`${name}: already compressed (${(before / 1e6).toFixed(2)} MB)`);
    continue;
  }
  /* QUANTIZE: the data is already quantized by the bake, so no lossy filter is applied on top. */
  doc.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await io.write(file, doc);
  const after = statSync(file).size;
  console.log(`${name}: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB`);
}
