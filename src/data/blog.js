// Build blog / news posts. Add a post at the top; `slug` drives the URL
// (#/blog/<slug>). `body` is an array of paragraphs. Keep it real.
export const posts = [
  {
    slug: 'numbers-socal-showdown-2026',
    date: '2026-10',
    title: 'Numbers is ready for SoCal Showdown',
    tag: 'Engineering',
    author: 'Team 5805',
    excerpt:
      'Our 2026 offseason robot debuts at SoCal Showdown, October 9–11 — a build of Team 581’s REBUILT design, running Catalyst 2.0 on FIRST’s new Systemcore controller.',
    body: [
      'Numbers is the fourth Book: our build of Team 581’s 2026 REBUILT design. Building another team’s proven robot is the fastest way we know to learn how a great machine works, and every subteam had a piece of it — mechanisms cut, assembled and tuned it, electrical planned and wired it, programming brought it up.',
      'It shoots from a 4 in stainless flywheel spun by four Kraken X60s, with a hood that ranges from 13 to 45 degrees. The hopper extends 300 mm with the intake on its front and holds 13 FUEL.',
      'Under it all is Systemcore, FIRST’s next-generation controller, running FRC Catalyst 2.0 — the library our programmers write. Numbers is our first competition robot on 2.0.',
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
      'It runs on X1, our swerve test drivebase, where every new feature is driven first, and on Numbers, our offseason robot.',
      'That makes this the right time to say it plainly: Catalyst 1.x is being sunset. It will not receive any updates after this offseason is over — no fixes and no new features. 1.12.0 stays installable as it is, so nothing breaks for a robot that depends on it, but every new robot should start on 2.0, and that is where all of our work goes from here.',
      'Install it, read the docs and try the tools from the Catalyst page.',
    ],
  },
  {
    slug: 'retiring-genesis-exodus-leviticus',
    date: '2026-09',
    title: 'Making room: Genesis, Exodus and Leviticus come apart',
    tag: 'Engineering',
    author: 'Team 5805',
    excerpt:
      'Genesis has been decommissioned and disassembled, and Exodus and Leviticus have been taken apart so their parts can go back into circulation.',
    body: [
      'A robot that sits on a shelf is a pile of motors, gearboxes and electronics nobody can use. So with Numbers on the way, we took three of our robots apart.',
      'Genesis, our 2025 REEFSCAPE robot and Ventura County Regional winner, has been decommissioned and disassembled. Exodus, our 2025 offseason robot, and Leviticus, our 2026 REBUILT robot, have been disassembled as well, so their parts can be reflowed into the robots that come next.',
      'The machines are gone, but they are not forgotten: the Robots page keeps each of them, with Genesis and Exodus in full 3D from their CAD.',
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
      'We open-sourced FRC Catalyst, the Java library our programming subteam built to stop re-writing the same mechanism code every season. Elevators, arms, shooters, intakes, climbers and more drop from 150+ lines of setup to about eight, with Motion Magic, simulation, and SysId wired in.',
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
