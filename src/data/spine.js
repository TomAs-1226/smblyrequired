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
    body: 'Every season starts with an empty shop and a blank assembly. Months later there is a 120-pound machine that nobody has built before.',
    facts: [
      { value: String(rosterCount), label: 'Students' },
      { value: String(subteams.length), label: 'Subteams' },
      { value: '10+', label: 'Seasons' },
    ],
  },
  {
    shot: 'explode',
    caption: true,
    kicker: 'This season · Numbers',
    title: 'Every part has someone’s *name* on it.',
    specs: [
      { anchor: 'intake', name: 'Intake', value: 'Slides out 300 mm' },
      { anchor: 'floor', name: 'Floor', value: 'Eleven-roller conveyor' },
      { anchor: 'hopper', name: 'Hopper', value: 'Holds 13 FUEL deployed' },
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
    title: 'Designed in CAD.\nBuilt by hand.',
    body: 'The mechanisms subteam turns a game manual into hardware. This shooter went from a sketch to an Onshape assembly to the robot — its hood rides on the flywheel’s own axis, so a single pivot sets every shot.',
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
    body: 'Swerve kinematics, the shot solver that sets the hood from distance, the intake’s deploy — all Java, written by students, running on SystemCore, FIRST’s new generation of robot controller.',
    specs: [
      { anchor: 'swerve', name: 'Swerve', value: 'Each module steers itself' },
      { anchor: 'aim', name: 'Hood', value: 'Angle solved from distance' },
      { anchor: 'deploy', name: 'Intake', value: 'Profiled 300 mm deploy' },
      { anchor: 'shot', name: 'Flywheel', value: 'Four motors, one setpoint' },
    ],
  },
  {
    shot: 'catalyst',
    right: true,
    kicker: 'Open source',
    title: 'We wrote the\nlibrary *too*.',
    body: 'That code runs on FRC Catalyst, the open-source Java library we write: mechanisms, swerve and a state machine for the whole robot. Catalyst 2.0 is built for SystemCore, and Catalyst Console is the dashboard our drivers watch.',
    links: [{ href: '#/catalyst', label: 'Explore Catalyst', primary: true }],
  },
  {
    shot: 'lineage',
    kicker: 'And then we do it again',
    title: 'A new robot,\nevery single year.',
    body: 'Genesis, Exodus, Leviticus, Numbers. One machine a season since 2016, each built by whoever walked into the shop that September.',
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
