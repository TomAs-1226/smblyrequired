// FRC Catalyst — the library Team 5805 students write, and the tools around it.
//
// Every claim here is checked against the sources, not remembered. When something changes, update it
// from the source, not from this file:
//   library      github.com/TomAs-1226/FrcCatalyst — README on `main` (1.x) and `upgrade/alpha-7` (2.x),
//                docs/versions.md, CHANGELOG, LICENSE
//   Console      github.com/TomAs-1226/CatalystConsole — README, CHANGELOG, src/
//   App          github.com/TomAs-1226/CatalystApp — README, package.json
// Checked 2026-10-02. We write Catalyst, so this page speaks for it plainly — and states only what the
// sources above show, plus the team's own decisions (the 1.x sunset is ours to announce).

export const catalyst = {
  name: 'FRC Catalyst 2.0',
  family: 'FRC Catalyst',
  version: '2.0',
  kicker: 'Systemcore · WPILib 2027 · Commands v3',
  // The 2.0 banner's own line (docs/assets/banner.svg on upgrade/alpha-7).
  motto: 'Different computer, same library.',
  release: { version: '2.0.0-beta.2', note: 'Beta · on JitPack' },
  // The library's own one-line description (README, upgrade/alpha-7), with what 2.0 is for.
  tagline: 'The whole-robot library for FRC, on CTRE Phoenix 6 — rebuilt for Systemcore.',
  description:
    'Mechanisms, swerve, a state machine for the entire robot, physics, autonomy and telemetry — configured through builders, not rewritten every season. We write it, and every team can use it free.',
  license: 'MIT',
  repoUrl: 'https://github.com/TomAs-1226/FrcCatalyst',
  // 2.0 is the line we build on; its docs are the ones to send people to.
  docsUrl: 'https://tomas-1226.github.io/FrcCatalyst/beta/',
  legacyDocsUrl: 'https://tomas-1226.github.io/FrcCatalyst/',
  versionsUrl: 'https://tomas-1226.github.io/FrcCatalyst/versions.html',
}

/* 2.0 in four numbers, each from the sources above: the API audit, the mechanism types in
   frc/lib/catalyst, CANBusPlanner's buses, and the docs site's tools. */
export const catalystGlance = [
  { value: '974 / 986', label: 'public methods kept their names from 1.x' },
  { value: '10', label: 'mechanism types, each configured through a builder' },
  { value: '5', label: 'CAN buses planned around their controllers' },
  { value: '13', label: 'browser tools for 2.0, no install' },
]

/* 1.x is being retired. Shown on the Catalyst page under the hero, and echoed on the 1.x card. */
export const catalystSunset = {
  title: 'Catalyst 1.x is being sunset.',
  lead: 'Still on a roboRIO this season?',
  body: 'Catalyst 1.x gets no updates after this offseason ends — no fixes, no new features. It stays installable as it is, but every new robot should start on 2.0, and everything we build from here is 2.0.',
}

/* What a team can install today: 2.0 first, because that is where Catalyst is going. */
export const catalystLines = [
  {
    id: 'beta',
    label: 'Catalyst 2.0',
    version: '2.0.0-beta.2',
    title: 'FRC Catalyst 2.0, for Systemcore',
    platform: ['Systemcore', 'WPILib 2027 alpha-7', 'Java 25', 'Commands v3', 'Phoenix 6 26.70'],
    note:
      'A new computer, a new JVM and a new command framework — and 974 of 986 public methods kept their names. Our X1 drivebase and Numbers run 2.0 builds from the alpha-6 line; beta.2 is the one to install.',
    vendordep: 'https://tomas-1226.github.io/FrcCatalyst/beta/vendordep/FrcCatalyst.json',
    docs: 'https://tomas-1226.github.io/FrcCatalyst/beta/',
  },
  {
    id: 'stable',
    label: 'Legacy · sunsetting',
    version: '1.12.0',
    title: 'Catalyst 1.x, for the roboRIO',
    platform: ['roboRIO', 'WPILib 2026', 'Java 17', 'Phoenix 6'],
    note: 'For robots still on the roboRIO this season. No updates after this offseason ends — plan the move to 2.0.',
    vendordep: 'https://tomas-1226.github.io/FrcCatalyst/vendordep/FrcCatalyst.json',
    docs: 'https://tomas-1226.github.io/FrcCatalyst/',
  },
]

/* What is in 2.0, by the names the code uses (frc/lib/catalyst on upgrade/alpha-7). */
export const catalystPillars = [
  {
    title: 'Ten mechanism types',
    body: 'Elevators, arms, turrets, flywheels, rollers, winches, claws, differential wrists, pneumatics and servos — with named positions, simulation, telemetry and safety limits built in, and motion profiles on the ones that travel.',
    names: ['LinearMechanism', 'RotationalMechanism', 'TurretMechanism', 'FlywheelMechanism'],
  },
  {
    title: 'Physics Core',
    body: 'Wheel and IMU velocity fused with a confidence, slip scoring, tipping margin and impact detection. Strictly advisory: it informs, it never drives.',
    names: ['PhysicsCore'],
  },
  {
    title: 'Shooting on the move',
    body: 'A solver for where to aim while the robot is moving, and a governor that slows the drive just enough for the shot to land.',
    names: ['AimingSolver', 'AimSpeedGovernor', 'HeadingTracker'],
  },
  {
    title: 'Systemcore, first class',
    body: 'Five CAN buses planned around their shared controllers, the controller reporting its own health, and both IMUs fused.',
    names: ['CatalystCANBus', 'CANBusPlanner', 'SystemCoreStatus', 'DualIMU'],
  },
  {
    title: 'OpModes and the Driver Station',
    body: 'Autos as annotated classes the 2027 Driver Station lists by name, and the robot’s status shown on the Driver Station itself.',
    names: ['CatalystOpMode', 'DriverBoard'],
  },
  {
    title: 'A robot that describes itself',
    body: 'One line declares the robot’s spec sheet, and Catalyst Console reads it: the frame drawn to scale, every motor and camera accounted for.',
    names: ['RobotIdentity'],
  },
]

/* The two capabilities shown live on the page, run on Numbers (src/components/catalyst/demos.js). */
export const catalystDemos = {
  autonomy: {
    kicker: 'Autonomy 2.0 · Situation, CycleCore, TaskArbiter',
    title: 'It decides — and tells you why.',
    body: 'Catalyst’s autonomy reads the match, picks the next job and hands back a decision with its reason: line up, collect, score. Here it is acted out on Numbers’ CAD — one clean pass through the FUEL, then firing on the move with the hood solved from range. Every decision is advice the robot acts on, never a lock on the driver.',
    note: 'A simulation drawn on Numbers’ CAD, acting out how the autonomy decides. The FUEL it scores rolls back out of the HUB and lands somewhere new each cycle.',
  },
  states: {
    kicker: 'Superstructure · a state machine for the whole robot',
    title: 'Nothing moves until the robot agrees.',
    body: 'Declare the states and the transitions between them once. Ask for one you never declared and it is refused, with the reason. A state counts as reached when the mechanisms get there — the hopper out, the hood on angle, the flywheel at speed — not when a timer runs out.',
  },
}

/* The README's quick start (upgrade/alpha-7), trimmed: two of its named positions are left out. */
export const catalystExample = {
  caption: 'From the README, trimmed. Most of these have defaults — this is what the builder can carry, not what it needs.',
  code: `LinearMechanism elevator = new LinearMechanism(
    LinearMechanism.Config.builder()
        .name("Elevator")
        .motor(13)
        .follower(14, true)
        .motorType(MotorType.KRAKEN_X60)
        .gearRatio(10.0)
        .drumRadius(0.0254) // 1 inch
        .stages(2) // 2-stage cascade
        .range(0.0, 1.2) // meters
        .mass(5.0) // kg
        .pid(50, 0, 0.5)
        .gravityGain(0.35)
        .motionMagic(2.0, 4.0, 20.0)
        .currentLimit(40)
        .reverseLimitSwitch(0, true) // DIO 0, auto-zero
        .maxTemperature(70) // safety cutoff
        .position("STOW", 0.0)
        .position("HIGH", 1.1)
        .build()
);

elevator.setDefaultCommand(elevator.holdPosition());
operatorController.a().onTrue(elevator.goTo("HIGH"));`,
}

/* Catalyst Console — the dashboard. Screenshots are the real app on its own demo data. */
export const catalystConsole = {
  name: 'Catalyst Console',
  version: '2.0.0',
  platforms: 'Windows x64 · macOS',
  lede: 'The driver-station dashboard that watches a Catalyst robot run — built on three rules: it never controls the robot, nothing it does may impede driving, and it never invents a number.',
  shots: [
    {
      src: 'photos/catalyst/console-park.jpg',
      alt: 'Catalyst Console’s Park view: Team 5805’s robot on a studio stage with callouts for vision and drivetrain, battery voltage, and match, autonomous, health and pre-match check cards.',
      caption: 'Park — the robot before a match, drawn from its own CAD, with what matters called out.',
    },
    {
      src: 'photos/catalyst/console-field.jpg',
      alt: 'Catalyst Console’s Drive dashboard mid-autonomous: the robot on the field, match timer, hub activation, swerve module speeds, Physics Core, shooter and battery tiles.',
      caption: 'Drive — once the robot enables: the field, the hub schedule, the drive, Physics Core and the shot.',
    },
  ],
  features: [
    'The robot in 3D from its own CAD, posed live from telemetry',
    'REBUILT hub activation, worked out from the game manual and FMS',
    'Live tuning, CAN bus and Driver Station log views',
    'Physics Core, Systemcore and battery health at a glance',
  ],
  note: 'Screens show the app’s built-in demo data. The gear letters top left — D A T U — are Disabled, Autonomous, Teleop and Utility.',
  url: 'https://github.com/TomAs-1226/CatalystConsole/releases/latest',
}

export const catalystApp = {
  name: 'Catalyst App',
  version: '2.8.0',
  platforms: 'Windows · macOS',
  lede: 'Installs Catalyst into a WPILib project and carries the design-time tools offline: Builder, PID Tuner, Motion Magic, Wiring, CAN IDs, Aiming, Auto, State Machine and more — plus an MCP server so coding agents can read a project, and write only when a team allows it.',
  url: 'https://github.com/TomAs-1226/CatalystApp/releases/latest',
}

export const catalystTools = {
  name: 'Browser tools',
  lede: 'Thirteen single-file tools for 2.0 on the docs site, no install — a mechanism builder, PID and motion-profile tuners, CAN ID and wiring planners, an auto builder and more.',
  url: 'https://tomas-1226.github.io/FrcCatalyst/beta/tools/',
}
