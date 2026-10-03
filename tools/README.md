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
