// Arcade page copy. The game's rules live in src/lib/arcade/engine.js; the words
// people read about it live here.

export const arcade = {
  eyebrow: 'Arcade',
  title: 'Cycle Rush',
  lead:
    'Drive 5805 on a two-minute match. Pick up cells, shoot them into the blue hub, ' +
    'and get back to the dock before the buzzer. Your partner B2 drives itself; R1 and R2 are coming for the win.',
  difficulties: [
    { id: 'rookie', label: 'Rookie', blurb: 'Slow red robots, wide misses.' },
    { id: 'regional', label: 'Regional', blurb: 'A fair match.' },
    { id: 'einstein', label: 'Einstein', blurb: 'Fast, accurate, and one of them plays defense.' },
  ],
  rules: [
    { label: 'Auto', text: 'The first 15 seconds score double.' },
    { label: 'Cells', text: '1 point for every cell in your hub. Scored cells come back out of the chutes at midfield.' },
    { label: 'Contact', text: 'Hit a robot hard enough and it drops a cell. So can you.' },
    { label: 'Endgame', text: 'The last 20 seconds: each robot in its dock at the buzzer is worth 6.' },
  ],
  controls: {
    keyboard: [
      ['W A S D', 'Drive (field-relative swerve)'],
      ['Mouse', 'Aim'],
      ['Arrow keys', 'Aim without a mouse'],
      ['Click / Space', 'Shoot (hold to keep firing)'],
      ['Shift', 'Snap aim to your hub'],
      ['Esc / P', 'Pause'],
    ],
    touch: [
      ['Left thumb', 'Drive'],
      ['Right thumb', 'Aim; push to the edge to shoot'],
    ],
  },
}
