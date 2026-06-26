// Build blog / news posts. Add a post at the top; `slug` drives the URL
// (#/blog/<slug>). `body` is an array of paragraphs. Keep it real.
export const posts = [
  {
    slug: 'state-championship-2026',
    date: '2026-04',
    title: 'A gritty run at the State Championship',
    tag: 'Competition',
    author: 'Team 5805',
    excerpt:
      'Leviticus closed out 2026 at the FIRST California Southern State Championship — three events, one playoff alliance, and a season that pushed us forward.',
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
      'We made the playoffs as the second pick of Alliance 3 — and Rey Freeman was recognized as a FIRST Leadership Award semi-finalist.',
    body: [
      'At the Orange County District event we qualified for the playoffs as the second pick of Alliance 3 and battled into the fifth round of the double-elimination bracket before being eliminated with a 3–2 playoff record.',
      'Off the field, junior Rey Freeman was named a semi-finalist for the FIRST Leadership Award — recognition for the kind of student leadership that holds a program like ours together.',
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
    date: '2025-04',
    title: 'Ventura County Regional Champions',
    tag: 'Competition',
    author: 'Team 5805',
    excerpt:
      'Genesis brought home a Regional Winner banner at the 2025 Ventura County Regional — our biggest in-season win yet.',
    body: [
      'In the 2025 REEFSCAPE season, Genesis earned a Regional Winner banner at the Ventura County Regional — a milestone for the program and proof of how far the team had come since our rookie year in 2016.',
      'That win, plus a Beach Blitz championship and a SoCal Showdown finalist run in the offseason, made 2025 a season to remember.',
    ],
  },
]

export const postBySlug = (slug) => posts.find((p) => p.slug === slug)
