// Real robot problems, for players who want them: a battery that sags under load
// and browns out, intakes that break when they take a hit, shooter jams, radio
// drops, and drive motors that get hot. Off by default for anyone who just wants
// to play.
//
// The battery is a voltage source behind an internal resistance: V = Voc − I·R.
// Current comes from what the robot is doing: four drive motors (most of all when
// they are pushing and not moving: a stall), the shooter spinning up and firing,
// the intake running. Below 6.8 V the roboRIO browns out and cuts the motors until
// the voltage recovers, exactly the failure pushing matches cause on a real field.

export const REALISM = {
  off: { label: 'Off', blurb: 'Nothing breaks. Just play.' },
  real: {
    label: 'Realistic',
    blurb: 'Battery sag and brownouts; a hard hit can break an intake; the odd jam or radio drop.',
    resistance: [0.014, 0.019], // ohms, battery + wiring (a fresh battery to a tired one)
    driveLimit: 160, // amps: four drive motors at a 40 A supply limit, as the descriptors set them
    hitBreak: 0.05, // chance a really hard hit breaks a deployed intake
    breakPerMin: 0.006, // and the odd mechanism failure with no hit at all
    jamPerShot: 0.003,
    commsPerMin: 0.05,
    heat: 0.6,
  },
  brutal: {
    label: 'Brutal',
    blurb: 'Old batteries, fragile intakes, jams and radio drops. Good luck.',
    resistance: [0.02, 0.025],
    driveLimit: 210, // looser limits on an older battery
    hitBreak: 0.16,
    breakPerMin: 0.02,
    jamPerShot: 0.01,
    commsPerMin: 0.2,
    heat: 1.2,
  },
}

const BROWNOUT_V = 6.8
const CAPACITY_AH = 18
const HIT_SPEED = 1.5 // m/s of sudden horizontal velocity change in one step: a real collision

export function initHealth(level, rng) {
  const cfg = REALISM[level] || REALISM.off
  const on = level !== 'off' && Boolean(cfg.resistance)
  const [lo, hi] = cfg.resistance || [0.02, 0.02]
  return {
    on,
    cfg,
    soc: 1,
    resistance: lo + (hi - lo) * rng(),
    volts: 12.7,
    amps: 0,
    minVolts: 12.7,
    brownout: 0,
    brownouts: 0,
    intakeBroken: false,
    jam: 0,
    comms: 0,
    heat: 0,
    hot: false,
    spinUp: 0,
    wasLoaded: false,
    backoff: 0,
  }
}

function report(sim, r, type, text) {
  // The same problem on the same robot is reported once every few seconds, not every time.
  const last = sim.faultLog.findLast?.((f) => f.id === r.id && f.type === type)
  if (last && sim.clock - last.at < 4) return
  sim.faultLog.push({ at: sim.clock, id: r.id, label: r.a.label, team: r.team, player: Boolean(r.isPlayer), type, text })
}

/** A collision, from the change in velocity across one step. Called after physics. */
export function noteImpact(sim, r, jump) {
  const h = r.health
  if (!h.on || h.intakeBroken || jump < HIT_SPEED) return
  if (r.intakeOut < 0.5 || r.climb.state !== 'none') return
  const severity = Math.min(1, (jump - HIT_SPEED) / 2 + 0.25)
  if (sim.rng() < h.cfg.hitBreak * severity) breakIntake(sim, r, 'took a hit and broke its intake')
}

function breakIntake(sim, r, why) {
  const h = r.health
  h.intakeBroken = true
  // It hangs where it broke, half in.
  r.intakeOut = Math.min(r.intakeOut, 0.45)
  report(sim, r, 'intake', why)
}

/** A shot left the robot: maybe the next one jams. */
export function noteShot(sim, r) {
  const h = r.health
  if (!h.on) return
  if (sim.rng() < h.cfg.jamPerShot) {
    h.jam = 1.8 + sim.rng() * 2.2
    report(sim, r, 'jam', 'jammed its shooter')
  }
}

/**
 * One step of battery, heat, radio and random failures. `drive` is how hard the
 * drivetrain is working this step: { cmd: 0..1 asked, speed: 0..1 of top speed,
 * accel: 0..1 of its acceleration limit }. Returns what the robot may do.
 */
export function faultStep(sim, r, dt, drive) {
  const h = r.health
  if (!h.on) return { drive: 1, shoot: true, intake: true, disabled: false }
  const cfg = h.cfg

  // --- current draw
  const stall = Math.max(0, drive.cmd - drive.speed) // pushing without moving
  const iDrive = drive.cmd > 0.05 ? 8 + Math.min(cfg.driveLimit, 30 * drive.speed + 120 * drive.accel + 200 * stall) : 2
  const loaded = r.carry > 0
  if (loaded && !h.wasLoaded) h.spinUp = 0.8
  h.wasLoaded = loaded
  h.spinUp = Math.max(0, h.spinUp - dt)
  const iShooter = (loaded ? 14 : 0) + (h.spinUp > 0 ? 55 : 0) + (r.firing > 0 ? 22 : 0)
  const iIntake = r.intakeOn && !h.intakeBroken && r.carry < r.a.capacity ? 12 : 0
  const amps = 3 + iDrive + iShooter + iIntake
  h.amps = amps

  // --- battery
  h.soc = Math.max(0, h.soc - (amps * dt) / (CAPACITY_AH * 3600))
  const voc = 12.25 + 0.55 * h.soc
  h.volts = voc - amps * h.resistance
  h.minVolts = Math.min(h.minVolts, h.volts)
  h.backoff = Math.max(0, h.backoff - dt)
  if (h.brownout > 0) {
    h.brownout = Math.max(0, h.brownout - dt)
  } else if (h.volts < BROWNOUT_V) {
    h.brownout = 0.5
    // Robot code backs the drive off after a brownout, or it would brown out again at once.
    h.backoff = 3
    h.brownouts++
    report(sim, r, 'brownout', `browned out (${h.volts.toFixed(1)} V)`)
  }
  // The motors are cut for the brownout, which lets the battery recover.
  const browned = h.brownout > 0

  // --- drive motors heat with the square of their current, and cool slowly
  h.heat = Math.max(0, h.heat + dt * (cfg.heat * (iDrive / 160) ** 2 * 0.09 - 0.012))
  if (!h.hot && h.heat > 1) {
    h.hot = true
    report(sim, r, 'heat', 'drive motors are hot: power limited')
  } else if (h.hot && h.heat < 0.55) {
    h.hot = false
  }

  // --- radio drops and the odd mechanism failure
  h.comms = Math.max(0, h.comms - dt)
  if (h.comms === 0 && sim.rng() < (cfg.commsPerMin / 60) * dt) {
    h.comms = 1.5 + sim.rng() * 2.5
    report(sim, r, 'comms', 'lost its radio link')
  }
  if (!h.intakeBroken && sim.rng() < (cfg.breakPerMin / 60) * dt) breakIntake(sim, r, 'had its intake fail')
  h.jam = Math.max(0, h.jam - dt)

  // Voltage sag on its own also costs a little drive power before a full brownout.
  const sag = h.volts < 9 ? Math.max(0.35, (h.volts - BROWNOUT_V) / 2.2) : 1
  const disabled = browned || h.comms > 0
  return {
    drive: disabled ? 0 : (h.hot ? 0.65 : 1) * (h.backoff > 0 ? 0.5 : 1) * Math.min(1, sag),
    shoot: !disabled && h.jam === 0,
    intake: !h.intakeBroken && !disabled,
    disabled,
  }
}
