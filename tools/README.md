# tools/robot-cad

The robot bake, forked from Catalyst Console (`scripts/robot-cad.mjs`).

    node tools/robot-cad.mjs "~/Downloads/Assembly 1.gltf" \
      --budget 600000 --min-size 0.004 --out public/models

Takes an Onshape glTF export of the season's robot and writes `public/models/robot.glb`
plus `robot.json`, a manifest of pivots, axes, roller centres and frame dimensions.

## Why it is forked rather than imported

Console merges the whole chassis into one `static` node, because it only needs the
robot to drive around a field. The website needs it to come APART: with the merge,
305,480 of 456,726 triangles — 67% of the machine — sat in a single node that could
never move, so an "exploded view" could only lift the rollers and modules off a solid
block.

The fork emits each CAD top-level assembly as its own node (`assembly-drive`,
`assembly-floor`, `assembly-hopper`, `assembly-shooter`, `assembly-intake`), so every
triangle belongs to a body that can be animated. `groupOf` still answers `"static"`,
so only node assignment changed and the rest of the pipeline is untouched.

Keeping it as a fork was a deliberate call: Console's own rendering must not change
underneath a robot that is driving. The cost is that the two copies will drift — if
Console's bake gains a fix worth having, port it across by hand.

## Each season

Export the flagship robot from Onshape as glTF, run the command above, and update
`src/data/robot.js`. Nothing else should need to change.

## `hub-from-field.mjs` — the HUB for the landing page's ending

```bash
node tools/hub-from-field.mjs ~/dev/CatalystConsole/src/vendor/field.glb public/models/hub.glb
```

Cuts the blue HUB out of the decimated REBUILT field that Catalyst Console bakes from FIRST's KOP
field CAD: every instance inside the HUB's footprint, welded, simplified to 1 mm and turned y-up
(23k triangles). Never copy the whole field into `public/` — everything there is published on deploy.

The HUB is FIRST's geometry, not ours. Console deliberately does not commit its `field.glb`; whether
the website may ship this one piece is a decision to make before deploying, not after.

## `display-cad.mjs` — any robot as a static display model

```bash
node tools/display-cad.mjs ~/Downloads/Robot.gltf --name genesis \
  --drop-node "Manipulator <1> / Coral" --out public/models
node tools/display-cad.mjs "~/Downloads/Assembly 1 (1).gltf" --name exodus \
  --config tools/display-cad/exodus.json --out public/models
```

For the robots that only need to be looked at — the lineage on `/robots`, a turntable. It knows nothing
about any one machine: it places every instance, drops fasteners, bearings, spacers and anything under
`--min-size` (4 mm), simplifies to `--budget` (260k triangles) and then lower until the file fits
`--max-mb` (5 MB), and merges the lot into one node with one material per class. The materials are named
exactly by class (`aluminium`, `steel`, `black`, `motor`, `poly`, `print`, `belt`, `tread`,
`electronics`, `other`), because the site restyles by name; a bumper found in the CAD is `other` in its
own colour, flagged `extras.bumper`.

The output is in the site's frame: y up, +x forward, origin on the floor under the middle of the wheels.
Up is the direction along which the most wheels touch the lowest plane. Forward is the side with parts
named Front/Back if there are any, otherwise the side the mechanisms reach furthest past the wheels —
the scoring side, which is a guess, so `<name>.json` records the evidence under `orientation` and
`--forward -y` (a CAD axis) overrides it.

Anything stuck to the robot that is not the robot — a game piece, a field element mated in for a check,
a belt that ended up on no pulleys — comes off with `--drop <regex>` (part name or path) or
`--drop-node`, which removes a node and everything under it by exact name, by a run of names along the
path (`"Manipulator <1> / Coral"`), or by glTF index (`node:1359`) when two twins share a name and path.
`--list` prints every instance with its index, node and what would happen to it. A robot whose drops and
orientation need explaining keeps them in `tools/display-cad/<name>.json`, read with `--config`.

Check the result by eye before committing it: wrong-way-up and a floating cage both pass every number.

## `compress-models.mjs` — after any bake

```bash
node tools/compress-models.mjs
```

Packs every `.glb` in `public/models` with `EXT_meshopt_compression`, about half the size (the
landing robot goes from 9.8 MB to 5.0 MB) with no change to nodes, names or accessors, so the
manifests stay valid. Idempotent. The site's loaders read it through `modelLoader()` in
`src/components/robot/robotRig.js`; a new loader that skips it will fail on these files.

