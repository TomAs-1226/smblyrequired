// The landing page's opening: the words that scroll past the robot.
//
// Each panel names a `shot` — what the robot does while that panel is read (see
// src/components/spine/shots.js). Edit the words freely; changing or adding a shot is a design job.
//
// `title` is one string: a line break is "\n", and *a word* in asterisks is set in the gold accent.
// `specs` become the callouts that point at the robot on wide screens and a plain list on phones.
// Each `anchor` names a point on the robot in shots.js, so a spec can be reworded but not re-aimed here.

import { rosterCount } from './roster'
import { subteams } from './subteams'

export const spineTitle = {
  pre: 'FIRST Robotics Competition',
  number: '5805',
  name: 'SMbly Required',
}

export const spinePanels = [
  { shot: 'title' },
  {
    shot: 'team',
    kicker: 'Built by students',
    title: `${numberWord(rosterCount)} people\nmade this.`,
    body: 'Every season starts with an empty shop. Months later there is a machine on the field that students built, wired and programmed — and drove.',
    facts: [
      { value: String(rosterCount), label: 'Students' },
      { value: String(subteams.length), label: 'Subteams' },
      { value: '10', label: 'Seasons' },
    ],
  },
  {
    shot: 'explode',
    caption: true,
    kicker: 'Offseason 2026 · Numbers',
    title: 'Every part has someone’s *name* on it.',
    specs: [
      { anchor: 'intake', name: 'Extending hopper', value: 'Slides out 300 mm, intake in front' },
      { anchor: 'floor', name: 'Floor', value: 'Eleven-roller conveyor' },
      { anchor: 'hopper', name: 'Hopper', value: 'Holds about 60 FUEL' },
      { anchor: 'shooter', name: 'Shooter', value: 'Four Krakens, one flywheel' },
      { anchor: 'hood', name: 'Hood', value: 'Aims from 13° to 45°' },
      { anchor: 'drive', name: 'Drive base', value: 'Four swerve modules' },
    ],
  },
  {
    shot: 'mech',
    tight: true,
    kicker: 'Mechanisms',
    index: '01',
    title: 'Built by hand.\nUnderstood to the bolt.',
    body: 'Numbers is our build of Team 581’s 2026 design — the best way we know to learn how a great robot works. The mechanisms subteam cut, assembled and tuned it, down to a hood that rides on the flywheel’s own axis, so one pivot sets every shot.',
    specs: [
      { anchor: 'flywheel', name: 'Flywheel', value: '4 in stainless, 552 mm wide' },
      { anchor: 'mhood', name: 'Hood', value: 'Pivots on the flywheel axis' },
      { anchor: 'feeder', name: 'Feeder', value: 'Three-roller stack' },
    ],
  },
  {
    shot: 'elec',
    right: true,
    tight: true,
    kicker: 'Electrical',
    index: '02',
    title: 'Lift the lid.',
    body: 'Under the superstructure is what makes it a robot rather than a sculpture: the battery, the main breaker, power distribution, and the CAN network that carries every motor’s commands. The electrical subteam plans and wires all of it.',
    specs: [
      { anchor: 'battery', name: 'Battery', value: '12 V, the only source on board' },
      { anchor: 'breaker', name: 'Main breaker', value: '120 A — and the on switch' },
      { anchor: 'pdp', name: 'Power distribution', value: 'Feeds every motor' },
      { anchor: 'mpm', name: 'Power modules', value: 'Fused low-current rails' },
    ],
  },
  {
    shot: 'prog',
    tight: true,
    kicker: 'Programming',
    index: '03',
    title: 'Nothing moves until someone writes it.',
    body: 'Swerve kinematics, the shot solver that sets the hood from distance, the hopper’s extension — rebuilt in Java on our own library, for Systemcore, FIRST’s new generation of robot controller.',
    specs: [
      { anchor: 'swerve', name: 'Swerve', value: 'Each module steers itself' },
      { anchor: 'aim', name: 'Hood', value: 'Angle solved from distance' },
      { anchor: 'deploy', name: 'Hopper', value: 'Profiled 300 mm extension' },
      { anchor: 'shot', name: 'Flywheel', value: 'Four motors, one setpoint' },
    ],
  },
  {
    shot: 'catalyst',
    right: true,
    kicker: 'Open source',
    title: 'We wrote the\nlibrary *too*.',
    body: 'That code runs on FRC Catalyst 2.0, the open-source Java library we write for Systemcore: mechanisms, swerve and a state machine for the whole robot. Catalyst Console is the dashboard our drivers watch.',
    links: [{ href: '#/catalyst', label: 'Explore Catalyst', primary: true }],
  },
  {
    shot: 'lineage',
    kicker: 'And then we do it again',
    title: 'A new robot,\nevery single year.',
    body: 'A robot every competition season since 2016, each built by whoever walked into the shop that year. Since 2025: Genesis, Exodus, Leviticus, Numbers.',
    links: [
      { href: '#/join', label: 'Join the team', primary: true },
      { href: '#/sponsor', label: 'Sponsor us' },
    ],
  },
]

function numberWord(n) {
  const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen', 'Twenty',
    'Twenty-one', 'Twenty-two', 'Twenty-three', 'Twenty-four', 'Twenty-five', 'Twenty-six', 'Twenty-seven',
    'Twenty-eight', 'Twenty-nine', 'Thirty']
  return words[n] ?? String(n)
}
