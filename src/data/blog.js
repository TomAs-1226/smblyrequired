// Build blog / news posts. Add a post at the top; `slug` drives the URL
// (#/blog/<slug>). `body` is an array of paragraphs. Keep it real.
export const posts = [
  {
    slug: 'numbers-socal-showdown-2026',
    date: '2026-10',
    title: 'Numbers is coming to SoCal Showdown',
    tag: 'Engineering',
    author: 'Team 5805',
    excerpt:
      'Our 2026 offseason robot debuts at SoCal Showdown, October 9–11 — a build of Team 581’s REBUILT design, running Catalyst 2.0 on FIRST’s new Systemcore controller.',
    body: [
      'Numbers is the fourth Book: our build of Team 581’s 2026 REBUILT design. Building another team’s proven robot is the fastest way we know to learn how a great machine works, and every subteam has a piece of it: mechanisms, electrical and programming are bringing it up together for its first event.',
      'It shoots from a 4 in stainless flywheel spun by four Kraken X60s, with a hood that ranges from 13 to 45 degrees. The hopper extends 300 mm with the intake on its front and holds about 60 FUEL.',
      'Under it all is Systemcore, FIRST’s next-generation controller, running FRC Catalyst 2.0 — the library our programmers write. Numbers is our first competition robot built for 2.0.',
      'You can turn it around on the Robots page, and on the home page it takes itself apart. Come and see it run at SoCal Showdown, October 9–11.',
    ],
  },
  {
    slug: 'catalyst-2-and-the-end-of-1x',
    date: '2026-10',
    title: 'FRC Catalyst 2.0 — and the end of 1.x',
    tag: 'Software',
    author: 'Team 5805',
    excerpt:
      'Catalyst 2.0 is where the library lives now. Catalyst 1.x gets no updates after this offseason ends.',
    body: [
      'FRC Catalyst 2.0 is our library rebuilt for Systemcore: a new computer, a new JVM and a new command framework. We kept the API teams already know — 974 of its 986 public methods kept their names — and grew it from a box of mechanisms into a library for the whole robot, with a state machine for the superstructure, autonomy that explains its decisions, and a robot that describes itself to Catalyst Console.',
      'X1, our swerve test drivebase, is where every new feature is driven first, and Numbers, our offseason robot, is built on it. Both run 2.0 builds from the alpha-6 line; 2.0.0-beta.2 is the build any team can install.',
      'That makes this the right time to say it plainly: Catalyst 1.x is being sunset. It will not receive any updates after this offseason is over — no fixes and no new features. 1.12.0 stays installable as it is, so nothing breaks for a robot that depends on it, but every new robot should start on 2.0, and that is where all of our work goes from here.',
      'Install it, read the docs and try the tools from the Catalyst page.',
    ],
  },
  {
    slug: 'catalyst-2-a-robot-that-explains-itself',
    date: '2026-10',
    title: 'Inside Catalyst 2.0: a robot that explains itself',
    tag: 'Software',
    author: 'Team 5805',
    excerpt:
      'Two ideas run through FRC Catalyst 2.0: the robot should refuse what it was never told it could do, and every decision it makes should come with a reason.',
    body: [
      'Catalyst started as a box of mechanisms — elevators, arms, flywheels and rollers, each configured through a builder instead of rewritten every season. Catalyst 2.0 keeps all of that, ten mechanism types in all, and grows it into a library for the whole robot.',
      'The first idea is the superstructure: a state machine for the entire robot. You declare the states — stow, intake, aim, shoot — and the transitions between them, once. Ask for a transition you never declared and it is refused, with the reason. And a state only counts as reached when the mechanisms actually get there: the hopper out, the hood on angle, the flywheel at speed. Not when a timer runs out.',
      'The second is autonomy that explains itself. Catalyst’s autonomy cores read the match, pick the next job and hand back a decision with its reason — line up, collect, score. They command nothing themselves. Every decision is advice the robot acts on, never a lock on the driver.',
      'Around those sit the rest of 2.0: Physics Core, which fuses wheel and IMU velocity with a confidence and scores slip and tipping while never driving anything itself; a solver for shooting on the move; first-class Systemcore support, with five CAN buses planned around their shared controllers; and a robot that declares its own spec sheet, so Catalyst Console can draw it to scale.',
      'The Catalyst page acts both ideas out on Numbers’ CAD — the robot collecting and scoring with its reasons beside it, and the state machine refusing a shot it was never allowed to take.',
    ],
  },
  {
    slug: 'catalyst-console-2',
    date: '2026-09',
    title: 'Catalyst Console 2.0: it reads, it never writes',
    tag: 'Software',
    author: 'Team 5805',
    excerpt:
      'The dashboard our drivers watch is built on three rules: it never controls the robot, nothing it does may impede driving, and it never invents a number.',
    body: [
      'Catalyst Console is the driver-station dashboard that watches a Catalyst robot run. It is a reading, not a control: telemetry comes in, and nothing goes back out.',
      'Three rules shape everything in it. It never controls the robot. Nothing it does may impede driving. And it never invents a number — if the robot did not say it, Console does not show it.',
      'Before a match, Park shows the robot in 3D from its own CAD, posed live from telemetry, with what matters called out. Once the robot enables, Drive takes over: the field, the REBUILT hub schedule worked out from the game manual and FMS, the swerve modules, Physics Core and the shot. Behind them sit live tuning, the CAN bus and readable Driver Station logs, and Systemcore and battery health at a glance.',
      'Console 2.0 runs on Windows and macOS. A robot running Catalyst 2.0 declares its own spec sheet — frame, bumpers, every motor and camera — and Console reads it, so the robot on screen is drawn to the robot’s own numbers.',
    ],
  },
  {
    slug: 'meet-x1',
    date: '2026-09',
    title: 'Meet X1, where Catalyst drives first',
    tag: 'Engineering',
    author: 'Team 5805',
    excerpt:
      'Before a Catalyst feature goes on a competition robot, it runs on X1: a 28 × 26 in swerve drivebase with no mechanisms, on purpose.',
    body: [
      'Catalyst X1 is our test drivebase — a robot, not a product. It is a 28 × 26 in swerve chassis on Falcon 500s and Phoenix 6, with a Systemcore controller and one Limelight 4 at the front.',
      'It is the machine FRC Catalyst 2.x is brought up on. Every feature the library offers a drivebase is wired in — swerve, pose estimation with vision, Physics Core, aiming on the move — and every one of them reports to Catalyst Console. Nothing that needs a mechanism is pretended: X1 has none, so it shows none.',
      'A session at the shop runs the same way every time. A preflight check prints pass, warn or fail for the link, the e-stop, the battery, CAN, the gyro, the camera and more, and nothing enables until the fails are fixed. A recorder turns every enabled stretch into a run file, and a report sets the day’s runs side by side, so a change is judged by numbers rather than by feel.',
      'That loop is why X1 exists. A feature that has been driven, recorded and compared on X1 is one we trust on Numbers.',
    ],
  },
  {
    slug: 'farewell-leviticus',
    date: '2026-09',
    title: 'Retiring Leviticus',
    tag: 'Robots',
    author: 'Team 5805',
    robot: 'leviticus',
    excerpt:
      'Book III carried us through a full REBUILT season — a finalist banner, a State Championship and a leadership award nod. This month we took it apart, so its parts can build what comes next.',
    body: [
      'Leviticus was our 2026 REBUILT robot, and the most ambitious machine we had built: a big dumper with a shooter three and a half balls wide, four Kraken X60s on the flywheels, and a slapdown intake feeding an extendable hopper. It was built to move a lot of FUEL at once, and it did.',
      'It opened the season at the Port Hueneme District as a finalist, the second pick of Alliance 3, playing all the way to the last match. At the Orange County District it made the playoffs again as the second pick of Alliance 3 and fought into the fifth round of the double-elimination bracket with a 3–2 playoff record. That same weekend Andrea was named a FIRST Leadership Award semi-finalist.',
      'Those district points took Leviticus to the FIRST California Southern State Championship, where it ranked 45th of 60 against the strongest teams in Southern California — the toughest field it ever saw, and the one that taught us the most about what our next robot needed to be.',
      'This September we disassembled Leviticus. Its motors, gearboxes, electronics and stock go back into the shop, where they will be reflowed into the robots we build next. A competition robot that sits on a shelf helps nobody; its parts in the hands of the next build do.',
      'Thank you, Leviticus. Book III is closed, and the season it gave us is written into every robot that follows.',
    ],
  },
  {
    slug: 'farewell-exodus',
    date: '2026-09',
    title: 'Retiring Exodus',
    tag: 'Robots',
    author: 'Team 5805',
    robot: 'exodus',
    excerpt:
      'Our 2025 offseason breakout won Beach Blitz and reached the SoCal Showdown final. Exodus has been disassembled, and its parts go back into circulation.',
    body: [
      'Exodus was Book II: the robot we built in the 2025 offseason to play REEFSCAPE again with everything Genesis had taught us. Where Genesis loaded coral from the side, Exodus loaded from the back — a back-loaded cycler with an elevator, built to climb deep.',
      'It became our offseason breakout. Exodus won Beach Blitz, presented by the Gene Haas Foundation, and played its way to the final at SoCal Showdown — two banners’ worth of proof that an offseason is for getting better, not for resting.',
      'This September we disassembled Exodus so its parts could be reflowed into new robots. Before it went, we kept the most complete record of it we could: its CAD now turns on our Robots page in full 3D, cleaned up for display.',
      'Thank you, Exodus. You showed us what a second attempt at the same game can look like.',
    ],
  },
  {
    slug: 'farewell-genesis',
    date: '2026-09',
    title: 'Retiring Genesis',
    tag: 'Robots',
    author: 'Team 5805',
    robot: 'genesis',
    excerpt:
      'The first of the Books, and a Regional Winner. Genesis has been decommissioned and disassembled — here is what it gave us.',
    body: [
      'Genesis was Book I, the robot that started our tradition of naming each machine for a Book of the Bible. It played the 2025 REEFSCAPE season as an elevator-based, side-loaded cycler that could climb deep.',
      'Genesis opened its season at the Orange County Regional, ranked 15th of 47. The next week, at the Ventura County Regional, it won — from the 49th seed, 5–0 through the playoffs. It was our second Regional Winner banner, after Orange County in 2018, and it set the bar for every robot that has come after it: Exodus took its lessons into the offseason, Leviticus into a new game, and Numbers into a new control system.',
      'This September we decommissioned Genesis and disassembled it. Its parts return to the shop to be reflowed into the robots that come next — which is exactly what a first robot should do.',
      'Genesis still lives on our Robots page, in full 3D from its CAD. Thank you, Genesis. Every Book since has been written on top of you.',
    ],
  },
  {
    slug: 'state-championship-2026',
    date: '2026-04',
    title: 'A gritty run at the State Championship',
    tag: 'Competition',
    author: 'Team 5805',
    excerpt:
      'Leviticus closed out 2026 at the FIRST California Southern State Championship — three events, two playoff runs, and a season that pushed us forward.',
    body: [
      'Qualifying for the FIRST California Southern State Championship capped a full district season for Leviticus, our REBUILT robot. We finished the qualification rounds ranked 45th of 60 of the best teams in Southern California — a tough field, and exactly the kind of competition that makes us better.',
      'Reaching States meant stacking a strong enough district season to earn the points. We did it the hard way: a finalist run at Port Hueneme and a deep playoff bracket at Orange County got us there.',
      'Every match at this level is a lesson. We came home with a longer punch-list, a faster pit crew, and a clearer picture of what Numbers — our offseason robot — needs to be.',
    ],
  },
  {
    slug: 'orange-county-district-2026',
    date: '2026-04',
    title: 'Orange County: playoffs and a Leadership Award nod',
    tag: 'Competition',
    author: 'Team 5805',
    excerpt:
      'We made the playoffs as the second pick of Alliance 3 — and Andrea was recognized as a FIRST Leadership Award semi-finalist.',
    body: [
      'At the Orange County District event we qualified for the playoffs as the second pick of Alliance 3 and battled into the fifth round of the double-elimination bracket before being eliminated with a 3–2 playoff record.',
      'Off the field, Andrea was named a semi-finalist for the FIRST Leadership Award — recognition for the kind of student leadership that holds a program like ours together.',
      'Districts reward consistency, and our drive team and scouters earned every point. On to the next one.',
    ],
  },
  {
    slug: 'port-hueneme-finalists-2026',
    date: '2026-03',
    title: 'Finalists to open the 2026 season',
    tag: 'Competition',
    author: 'Team 5805',
    excerpt:
      'Leviticus opened 2026 at the Port Hueneme District as finalists — the second pick of Alliance 3, all the way to the final match.',
    body: [
      'Our first event of the REBUILT season started strong: Leviticus was selected as the second pick of Alliance 3 and rode that alliance all the way to the finals, finishing with a 3–3 playoff record.',
      'A finalist banner in week one set the tone for the season and earned valuable district points toward the State Championship.',
    ],
  },
  {
    slug: 'frc-catalyst-open-source',
    date: '2026-03',
    title: 'FRC Catalyst is now open source',
    tag: 'Engineering',
    author: 'Team 5805',
    excerpt:
      'Our student-built Java library of pre-built mechanism building blocks is now public — free for any FRC team on Phoenix 6 and WPILib 2026.',
    body: [
      'We open-sourced FRC Catalyst, the Java library our programming subteam built to stop re-writing the same mechanism code every season. An elevator with gravity feedforward drops from about 150 lines of setup to about eight, and arms, shooters, intakes and climbers get the same builders, with Motion Magic, simulation and SysId wired in.',
      'It is part of how we try to give back to the community that taught us — in the spirit of the Open Alliance. Fork it, file an issue, or just borrow what you need.',
    ],
  },
  {
    slug: 'ventura-county-champions-2025',
    date: '2025-03',
    title: 'Ventura County Regional Champions',
    tag: 'Competition',
    author: 'Team 5805',
    excerpt:
      'Genesis brought home a Regional Winner banner at the 2025 Ventura County Regional — our second Regional win, after Orange County in 2018.',
    body: [
      'In the 2025 REEFSCAPE season, Genesis earned a Regional Winner banner at the Ventura County Regional — a milestone for the program and proof of how far the team had come since our rookie year in 2016.',
      'That win, plus a Beach Blitz championship and a SoCal Showdown finalist run in the offseason, made 2025 a season to remember.',
    ],
  },
]

export const postBySlug = (slug) => posts.find((p) => p.slug === slug)
