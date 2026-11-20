// Loading the arcade's imported assets in the browser (see tools/arcade-assets.mjs).
//
// One GLTFLoader with the meshopt decoder (the same one the robot page uses);
// each model is fetched once and every robot on the field gets its own copy of
// the scene graph (geometry shared), with its own mechanism rig.
import { modelLoader, rigRobot, studioEnvironment } from '../../components/robot/robotRig'
import { specFromDescriptor, numbersSpec } from './robots.js'
import { rigDescriptorRobot, rigNumbers } from './rig.js'

export function createAssets(base) {
  const arcade = `${base}arcade/`
  const models = `${base}models/`
  const loader = modelLoader()
  const gltfs = new Map()
  const load = (url) => {
    if (!gltfs.has(url)) gltfs.set(url, loader.loadAsync(url))
    return gltfs.get(url)
  }
  const json = (url) => fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: ${r.status}`)
    return r.json()
  })

  /** Everything the game needs before the first match: the field's colliders and every robot's spec. */
  async function roster() {
    const [field, index, numbers] = await Promise.all([
      json(`${arcade}field.json`),
      json(`${arcade}index.json`),
      json(`${models}robot.json`).catch(() => null),
    ])
    const descriptors = await Promise.all(index.robots.map((e) => json(`${arcade}${e.descriptor}`)))
    const specs = index.robots.map((e, i) => ({ ...specFromDescriptor(descriptors[i], e), entry: e }))
    if (numbers) specs.unshift({ ...numbersSpec(numbers), entry: null, manifest: numbers })
    return { field, specs }
  }

  return {
    roster,
    /** Something for metal to reflect: without it every aluminium part renders near black. */
    environment: (renderer) => studioEnvironment(renderer),
    field: () => load(`${arcade}field.glb`),
    fuel: () => load(`${arcade}fuel.glb`),
    /** A fresh, rigged copy of a robot. `clips` are kept for previews. */
    async robot(spec) {
      if (spec.source === 'numbers') {
        const gltf = await load(`${models}robot-preview.glb`)
        const root = gltf.scene.clone(true)
        const rig = rigRobot(root, spec.manifest, { glassy: false })
        return { root, clips: gltf.animations, rig: rigNumbers(rig, root, spec), raw: rig }
      }
      const gltf = await load(`${arcade}${spec.model}`)
      const root = gltf.scene.clone(true)
      return { root, clips: gltf.animations, rig: rigDescriptorRobot(root, spec, gltf.animations) }
    },
  }
}
