// FRC Catalyst — Team 5805's open-source software library (student-built IP,
// owned by the team). A strong technical + knowledge-sharing credential.
export const catalyst = {
  name: 'FRC Catalyst',
  tagline:
    'A Java library of pre-built mechanism building blocks for FRC robots on Phoenix 6 and WPILib 2026.',
  description:
    'An open-source Java library built and maintained by Team 5805 that turns the mechanisms every FRC team rebuilds each season into reusable building blocks — cutting 150+ lines of scaffolding down to about eight.',
  metric: { from: '150+', to: '8', label: 'lines of mechanism setup' },
  features: [
    {
      title: 'Eight mechanism types',
      body: 'Elevators, arms, shooters, intakes, climbers, grippers, differential wrists, and pneumatics — builder-configured.',
      icon: 'cog',
    },
    {
      title: 'Control built in',
      body: 'Motion Magic, gravity feedforward, simulation, and pre-wired SysId routines for every motor.',
      icon: 'cpu',
    },
    {
      title: 'Vision + Kalman filtering',
      body: 'A multi-camera vision subsystem with pose estimation, plus health and temperature monitoring.',
      icon: 'spark',
    },
    {
      title: 'Eight browser tools',
      body: 'Builder form, PID tuner, CAN ID planner, auto builder, and more — zero setup required.',
      icon: 'code',
    },
  ],
  stack: ['Java 17', 'WPILib 2026', 'CTRE Phoenix 6', 'PathPlanner', 'PhotonVision'],
  docsUrl: 'https://tomas-1226.github.io/FrcCatalyst/',
  repoUrl: 'https://github.com/tomas-1226/FrcCatalyst',
}
