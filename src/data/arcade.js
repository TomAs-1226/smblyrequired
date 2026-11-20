// Arcade page copy. The game's numbers live in src/lib/arcade3d/config.js; the
// words people read about it live here.

export const arcade = {
  eyebrow: 'Arcade',
  title: 'Cycle Rush',
  lead:
    'A simplified take on the 2026 game, in 3D with real physics, on the full field. Drive one of 22 ' +
    'real robots, ours included: a 2:40 match three-on-three, a solo match, a one-minute skills run, or practice.',
  lock: {
    title: 'Enter this week’s code',
    text: 'The arcade is for the team. Ask a mentor for the code: it changes every Monday.',
    placeholder: 'ABC-123',
    button: 'Unlock',
    checking: 'Checking…',
    offline: 'The arcade’s server can’t be reached right now, so codes can’t be checked.',
    retry: 'Try again',
  },
  facts: [
    { value: '22', label: 'real robots, ours included' },
    { value: '504', label: 'FUEL on the full field' },
    { value: '2:40', label: 'match, auto to endgame' },
    { value: '4', label: 'ways to play' },
  ],
  problems: {
    title: 'Real robot problems',
    intro: 'Turn on Realistic or Brutal before a match and robots fail the way they do at events. Leave it Off to just play.',
    items: [
      ['Battery', 'The battery sags under load. Push another robot while your shooter spins up and it can drop under 6.8 V: a brownout cuts your motors for half a second.'],
      ['Intake', 'A hard hit with the intake out can break it, and it stays broken for the rest of the match.'],
      ['Jams', 'Now and then a ball jams the shooter for a couple of seconds.'],
      ['Radio', 'The odd radio drop stops the robot dead for a few seconds.'],
      ['Heat', 'Push hard for long enough and the drive motors get hot and lose power until they cool.'],
    ],
  },
  modes: {
    match: 'Three-on-three, 2:40, hub shifts. Your partners and opponents drive themselves.',
    solo: 'Just your robot, the full match and shifts. Every point is yours.',
    skills: 'One minute, hub always live. How much can you score?',
    practice: 'No clock, hub always live. R puts you back at the start.',
  },
  difficulties: [
    { id: 'rookie', label: 'Rookie', blurb: 'Slow red robots, wide misses.' },
    { id: 'regional', label: 'Regional', blurb: 'A fair match.' },
    { id: 'einstein', label: 'Einstein', blurb: 'Fast, accurate, and one of them plays defense on you.' },
  ],
  rules: [
    { label: 'Auto', text: 'The first 20 seconds, and you drive them. Whoever scores more fuel here has their hub go dark first.' },
    { label: 'Fuel', text: '1 point for each ball through your hub’s opening while the hub is lit.' },
    { label: 'Shifts', text: 'After a 10-second transition, the hubs take turns: four 25-second shifts. The alliance that scored more in auto goes dark first. Fuel into a dark hub scores nothing, so collect then, and shoot when it lights.' },
    { label: 'Crossing', text: 'Your zone is walled off by the hub line. Drive over a bump, or under a trench if your robot is short enough.' },
    { label: 'Endgame', text: 'The last 30 seconds: both hubs are lit. Park in the dashed box in front of your tower and climb: 10, 20 or 30 points for L1, L2 or L3.' },
  ],
  controls: {
    keyboard: [
      ['W A S D', 'Drive'],
      ['Q E / ← →', 'Turn'],
      ['Space', 'Shoot: hold it. The robot aims itself and fires when it is lined up'],
      ['Shift', 'Intake: hold it to pick fuel up'],
      ['X', 'Special: climb at your tower in the endgame, otherwise pass fuel home'],
      ['V', 'Camera: behind the robot, fixed, overhead, driver station'],
      ['R', 'Practice: back to the start'],
      ['Esc / P', 'Pause'],
    ],
    touch: [
      ['Left thumb', 'Drive'],
      ['Right thumb', 'Turn'],
      ['Buttons', 'Shoot, Intake (a switch) and Special'],
    ],
  },
  credits:
    'Robot and field models from the arcade asset export; field layout cross-checked ' +
    'against maple-sim’s 2026 arena (BSD-3-Clause) and our own robot code. Numbers is our CAD.',
  aiming:
    'Hold Space and the robot aims itself, the way real ones do: a turret turns its turret, anything else ' +
    'turns the whole robot until its shooter faces the hub. A wide shooter feeds each of its lanes on ' +
    'its own, so fuel pours out across its width. Every ball then flies on its own, with gravity and ' +
    'drag, and can rattle out off the rim. Shooting on the move is a skill of the robot, not only of ' +
    'the driver: each one has its own speed it shoots well at (it is on the robot’s card), and the ' +
    'faster you go past it, the more of its shots miss. A bump from another robot throws the aim off ' +
    'for a moment too, less on a robot built low and wide.',
}
