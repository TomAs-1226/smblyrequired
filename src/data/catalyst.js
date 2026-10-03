// FRC Catalyst — the library Team 5805 students write, and the tools around it.
//
// Every claim here is checked against the sources, not remembered. When something changes, update it
// from the source, not from this file:
//   library      github.com/TomAs-1226/FrcCatalyst — README on `main` (1.x) and `upgrade/alpha-7` (2.x),
//                docs/versions.md, CHANGELOG, LICENSE
//   Console      github.com/TomAs-1226/CatalystConsole — README, CHANGELOG, src/
//   App          github.com/TomAs-1226/CatalystApp — README, package.json
// Checked 2026-10-02. Catalyst 2.x has not been driven on a competition robot yet, and the library says
// so itself; do not claim otherwise here until it has.

export const catalyst = {
  name: 'FRC Catalyst',
  // The library's own one-line description (README, upgrade/alpha-7).
  tagline: 'The whole-robot library for FRC, on CTRE Phoenix 6.',
  description:
    'Mechanisms, swerve, a state machine for the entire robot, physics, autonomy and telemetry — configured through builders instead of rewritten every season. Written by Team 5805 students, free for any team.',
  license: 'MIT',
  repoUrl: 'https://github.com/TomAs-1226/FrcCatalyst',
  docsUrl: 'https://tomas-1226.github.io/FrcCatalyst/',
  betaDocsUrl: 'https://tomas-1226.github.io/FrcCatalyst/beta/',
  versionsUrl: 'https://tomas-1226.github.io/FrcCatalyst/versions.html',
}

/* The two lines a team can install today. */
export const catalystLines = [
  {
    id: 'stable',
    label: 'Stable',
    version: '1.12.0',
    title: 'The competition line',
    platform: ['roboRIO', 'WPILib 2026', 'Java 17', 'Phoenix 6'],
    note: 'Competing this season? This is the one the library itself tells you to use.',
    vendordep: 'https://tomas-1226.github.io/FrcCatalyst/vendordep/FrcCatalyst.json',
    docs: 'https://tomas-1226.github.io/FrcCatalyst/',
  },
  {
    id: 'beta',
    label: 'Beta',
    version: '2.0.0-beta.2',
    title: 'Catalyst 2.0, for Systemcore',
    platform: ['Systemcore', 'WPILib 2027 alpha-7', 'Java 25', 'Commands v3', 'Phoenix 6 26.70'],
    note:
      'A new computer, a new JVM and a new command framework — and 974 of 986 public methods kept their names. Tested in simulation, on the bench and on our X1 test drivebase; not yet driven on a competition robot.',
    vendordep: 'https://tomas-1226.github.io/FrcCatalyst/beta/vendordep/FrcCatalyst.json',
    docs: 'https://tomas-1226.github.io/FrcCatalyst/beta/',
  },
]

/* What is in 2.0, by the names the code uses (frc/lib/catalyst on upgrade/alpha-7). */
export const catalystPillars = [
  {
    title: 'Ten mechanism types',
    body: 'Elevators, arms, turrets, flywheels, rollers, winches, claws, differential wrists, pneumatics and servos — each with motion profiles, named positions, simulation, telemetry and safety limits built in.',
    names: ['LinearMechanism', 'RotationalMechanism', 'TurretMechanism', 'FlywheelMechanism'],
  },
  {
    title: 'A state machine for the whole robot',
    body: 'Transitions you did not declare are refused, with a reason. Arrival is measured, not assumed. It can explain what it is doing and why.',
    names: ['Superstructure', 'StateGraph'],
  },
  {
    title: 'Physics Core',
    body: 'Wheel and IMU velocity fused with a confidence, slip scoring, tipping margin and impact detection. Strictly advisory: it informs, it never drives.',
    names: ['PhysicsCore'],
  },
  {
    title: 'Autonomy 2.0',
    body: 'Cores that read the match and return a decision with a reason — and command nothing themselves, so a driver is always in charge.',
    names: ['Situation', 'CycleCore', 'TaskArbiter'],
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

/* The README's quick start (upgrade/alpha-7), unedited apart from layout. */
export const catalystExample = {
  caption: 'From the README. Most of these have defaults — this is what the builder can carry, not what it needs.',
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
  lede: 'Single-file tools on the docs site, no install: eleven for 1.x, thirteen for 2.0 — a mechanism builder, PID and motion-profile tuners, CAN ID and wiring planners, an auto builder and more.',
  url: 'https://tomas-1226.github.io/FrcCatalyst/beta/tools/',
}
