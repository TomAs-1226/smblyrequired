// Arcade page copy. The game's numbers live in src/lib/arcade3d/config.js; the
// words people read about it live here.

export const arcade = {
  eyebrow: 'Arcade',
  title: 'Cycle Rush',
  lead:
    'A simplified take on the 2026 game, in 3D with real physics. Pick a robot, play a full ' +
    '2:40 match three-on-three, and time your shots to the hub shifts. Your two partners drive themselves.',
  difficulties: [
    { id: 'rookie', label: 'Rookie', blurb: 'Slow red robots, wide misses.' },
    { id: 'regional', label: 'Regional', blurb: 'A fair match.' },
    { id: 'einstein', label: 'Einstein', blurb: 'Fast, accurate, and one of them plays defense on you.' },
  ],
  rules: [
    { label: 'Auto', text: 'The first 20 seconds. Your robot runs its own routine; take over at teleop.' },
    { label: 'Fuel', text: '1 point for each ball through your hub’s opening while the hub is lit.' },
    { label: 'Shifts', text: 'After a 10-second transition, the hubs take turns: four 25-second shifts. The alliance that scored more in auto goes dark first. Fuel into a dark hub scores nothing, so collect then, and shoot when it lights.' },
    { label: 'Crossing', text: 'Your zone is walled off by the hub line. Drive over a bump, or under a trench if your robot is short enough.' },
    { label: 'Endgame', text: 'The last 30 seconds: both hubs are lit. Park in the dashed box in front of your tower and climb: 10, 20 or 30 points for L1, L2 or L3.' },
  ],
  controls: {
    keyboard: [
      ['W A S D', 'Drive, relative to the camera'],
      ['Mouse', 'Point the robot'],
      ['← →', 'Turn without a mouse'],
      ['Shift or ↑', 'Face your hub'],
      ['Click / Space', 'Shoot (hold to keep firing)'],
      ['C', 'Climb, in the endgame, in front of your tower'],
      ['V', 'Camera: driver station, chase, overhead'],
      ['Esc / P', 'Pause'],
    ],
    touch: [
      ['Left thumb', 'Drive'],
      ['Right thumb', 'Point; push to the edge to shoot'],
      ['Climb button', 'Appears when you can climb'],
    ],
  },
  aiming:
    'Shooters range themselves off distance, as real ones do, but the ball flies with gravity and drag. ' +
    'A turret leads its shot while moving. A fixed shooter throws wherever the robot points, and its ' +
    'own speed carries the ball sideways: stop and face the hub.',
}
