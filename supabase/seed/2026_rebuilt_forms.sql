-- =============================================================================
-- 2026 REBUILT scouting forms.
--
-- Replaces the generic starter forms with the actual game. Sourced from the
-- 2026 game manual, not from memory:
--
--   FUEL is the game piece; it scores in the HUB (through the top opening and
--   the sensor array) for 1 point, the SAME in auto and teleop.
--
--   TOWER climb   AUTO  Level 1 = 15 pts (max 2 robots per alliance)
--                 TELEOP Level 1 = 10, Level 2 = 20, Level 3 = 30
--                 L1 = off the carpet/tower base
--                 L2 = bumpers fully above the LOW RUNG
--                 L3 = bumpers fully above the MID RUNG
--
--   Ranking points  ENERGIZED    100 FUEL
--                   SUPERCHARGED 360 FUEL
--                   TRAVERSAL    50 TOWER points
--
--   The HUB mechanic that most affects scouting: whichever alliance scores MORE
--   fuel in AUTO has their own HUB deactivated during ALLIANCE SHIFTS 1 and 3.
--   So raw fuel counts are not comparable between teams without knowing which
--   shifts they could actually score in — hence the shift fields below.
--
-- Safe to re-run. Paste into Supabase -> SQL Editor.
--
-- THREE KEYS ARE LOAD-BEARING and must survive any edit:
--   total_score, broke, no_show — read BY NAME by team_event_stats, the pick
--   list, the comparison view, and every AI summary.
-- =============================================================================

begin;

update public.scout_forms set is_active = false where season = 2026 and is_active;

-- --- MATCH -------------------------------------------------------------------
insert into public.scout_forms (season, kind, name, description, is_active, fields) values (
  2026, 'match', 'REBUILT — match scouting',
  'One entry per team per match. Fuel counts are what they SCORED, not attempted.',
  true,
  $json$[
    {"key":"h_auto","label":"Autonomous (20s)","type":"heading","section":"Auto"},
    {"key":"auto_start","label":"Starting position","type":"select","section":"Auto",
     "options":["Left","Centre","Right"],"required":true},
    {"key":"auto_preload","label":"Preloaded fuel","type":"counter","section":"Auto",
     "min":0,"max":48,"help":"Robots may preload up to 48"},
    {"key":"auto_fuel","label":"Fuel scored in auto","type":"counter","section":"Auto",
     "min":0,"max":99,"required":true,"help":"1 point each"},
    {"key":"auto_source","label":"Fuel collected from","type":"multiselect","section":"Auto",
     "options":["Preload only","Depot","Outpost chute","Neutral zone"]},
    {"key":"auto_tower_l1","label":"Climbed Tower L1 in auto","type":"boolean","section":"Auto",
     "help":"15 points, max 2 robots per alliance"},

    {"key":"h_teleop","label":"Teleop (2:20)","type":"heading","section":"Teleop"},
    {"key":"teleop_fuel","label":"Fuel scored in teleop","type":"counter","section":"Teleop",
     "min":0,"max":300,"required":true},
    {"key":"teleop_missed","label":"Fuel missed / dropped","type":"counter","section":"Teleop",
     "min":0,"max":300,"help":"Accuracy matters more than raw volume for picks"},
    {"key":"hub_active_shifts","label":"Shifts their hub was ACTIVE","type":"multiselect",
     "section":"Teleop","options":["Transition","Shift 1","Shift 2","Shift 3","Shift 4"],
     "help":"The auto-winning alliance loses their hub in Shifts 1 and 3. Without this, fuel counts are not comparable between teams."},
    {"key":"cycle_time","label":"Rough cycle time (s)","type":"number","section":"Teleop",
     "min":0,"max":120},
    {"key":"intake_ground","label":"Ground intake","type":"boolean","section":"Teleop"},
    {"key":"defence_played","label":"Played defence","type":"boolean","section":"Teleop"},
    {"key":"defence_rating","label":"Defence quality","type":"rating","section":"Teleop","max":5,
     "help":"Only if they actually played it"},
    {"key":"was_defended","label":"Was defended against","type":"boolean","section":"Teleop"},

    {"key":"h_end","label":"End game","type":"heading","section":"Endgame"},
    {"key":"climb_level","label":"Tower climb reached","type":"select","section":"Endgame",
     "options":["None","Attempted, failed","Level 1 (10)","Level 2 (20)","Level 3 (30)"],
     "required":true},
    {"key":"climb_time","label":"Climb took (s)","type":"number","section":"Endgame","min":0,"max":60,
     "help":"A 30-point climb that takes 40 seconds costs cycles"},
    {"key":"climb_assisted","label":"Helped a partner climb","type":"boolean","section":"Endgame"},

    {"key":"h_sum","label":"Summary","type":"heading","section":"Summary"},
    {"key":"total_score","label":"Points this robot contributed","type":"number",
     "section":"Summary","min":0,"required":true,
     "help":"Fuel + tower. Drives every ranking, comparison and pick list — estimate it even if unsure."},
    {"key":"driver_rating","label":"Driver skill","type":"rating","section":"Summary","max":5},
    {"key":"broke","label":"Broke down or was disabled","type":"boolean","section":"Summary"},
    {"key":"no_show","label":"Never showed up","type":"boolean","section":"Summary"}
  ]$json$::jsonb
);

-- --- PIT ---------------------------------------------------------------------
-- Deliberately specific about drivetrain hardware. "Swerve" alone tells you
-- almost nothing: an MK4i on Krakens and a first-year kit swerve on NEOs behave
-- completely differently under defence, and that difference decides picks.
insert into public.scout_forms (season, kind, name, description, is_active, fields) values (
  2026, 'pit', 'REBUILT — pit scouting',
  'Once per team at their pit. Photos are captured separately in the app.',
  true,
  $json$[
    {"key":"h_drive","label":"Drivetrain","type":"heading","section":"Drivetrain"},
    {"key":"drivetrain","label":"Drivetrain type","type":"select","section":"Drivetrain",
     "options":["Swerve","Tank / West Coast","Mecanum","Butterfly","Other"],"required":true},
    {"key":"swerve_module","label":"Swerve module","type":"select","section":"Drivetrain",
     "options":["SDS MK4","SDS MK4i","SDS MK4n","SDS MK4c","WCP SwerveX","WCP SwerveXS","WCP SwerveX2",
                "REV MAXSwerve","Thrifty Swerve","AndyMark Swerve","Custom / in-house","Not swerve"],
     "help":"Ask them — most teams are proud of this and will tell you unprompted"},
    {"key":"drive_motor","label":"Drive motor","type":"select","section":"Drivetrain",
     "options":["Kraken X60","Kraken X44","Falcon 500","NEO Vortex","NEO V1.1","CIM","Other"]},
    {"key":"steer_motor","label":"Steer / turn motor","type":"select","section":"Drivetrain",
     "options":["Kraken X60","Falcon 500","NEO 550","NEO Vortex","NEO V1.1","Other","N/A"]},
    {"key":"gear_ratio","label":"Drive gearing","type":"text","section":"Drivetrain",
     "help":"e.g. L2, 6.75:1 — free speed matters for cycle time"},
    {"key":"top_speed","label":"Claimed top speed (ft/s)","type":"number","section":"Drivetrain",
     "min":0,"max":30},
    {"key":"encoder_type","label":"Absolute encoders","type":"select","section":"Drivetrain",
     "options":["CANcoder","Thrifty absolute","REV through-bore","Analog","Unknown","N/A"]},

    {"key":"h_power","label":"Power & electrical","type":"heading","section":"Power"},
    {"key":"battery_count","label":"Batteries they brought","type":"counter","section":"Power",
     "min":0,"max":12,
     "help":"Fewer than 3 at a two-day event usually means brownouts by Saturday afternoon"},
    {"key":"battery_condition","label":"Battery condition","type":"select","section":"Power",
     "options":["New this season","Good","Mixed / ageing","Visibly old"]},
    {"key":"has_battery_beak","label":"Tests batteries (beak/analyser)","type":"boolean","section":"Power"},
    {"key":"brownout_history","label":"Reported brownouts","type":"boolean","section":"Power"},

    {"key":"h_cap","label":"Capability","type":"heading","section":"Capability"},
    {"key":"fuel_capacity","label":"Fuel capacity on board","type":"counter","section":"Capability",
     "min":0,"max":60},
    {"key":"intake_type","label":"Intake","type":"multiselect","section":"Capability",
     "options":["Ground","Outpost chute","Depot","Human player","None"]},
    {"key":"max_climb","label":"Highest tower level they can reach","type":"select",
     "section":"Capability","options":["None","Level 1","Level 2","Level 3"]},
    {"key":"auto_routines","label":"Auto routines","type":"counter","section":"Capability","min":0,"max":15},
    {"key":"auto_best_fuel","label":"Best auto fuel count they claim","type":"number",
     "section":"Capability","min":0,"max":99},

    {"key":"h_soft","label":"Software","type":"heading","section":"Software"},
    {"key":"language","label":"Language","type":"select","section":"Software",
     "options":["Java","C++","Python","LabVIEW","Other"]},
    {"key":"vision","label":"Vision system","type":"multiselect","section":"Software",
     "options":["Limelight","PhotonVision","OpenSight","Custom","None"]},
    {"key":"has_odometry","label":"Field-relative odometry / pose estimation","type":"boolean",
     "section":"Software"},
    {"key":"path_planning","label":"Path planning","type":"select","section":"Software",
     "options":["PathPlanner","Choreo","WPILib trajectory","Hand-tuned","None"]},

    {"key":"h_assess","label":"Assessment","type":"heading","section":"Assessment"},
    {"key":"total_score","label":"Expected points per match","type":"number",
     "section":"Assessment","min":0,
     "help":"Your estimate from talking to them. Keeps pit data comparable with match data."},
    {"key":"build_quality","label":"Build quality","type":"rating","section":"Assessment","max":5},
    {"key":"broke","label":"Known reliability problems","type":"boolean","section":"Assessment"},
    {"key":"no_show","label":"Pit empty / would not talk","type":"boolean","section":"Assessment"},
    {"key":"notes_pit","label":"Anything notable","type":"textarea","section":"Assessment"}
  ]$json$::jsonb
);

-- --- STRATEGY ----------------------------------------------------------------
insert into public.scout_forms (season, kind, name, description, is_active, fields) values (
  2026, 'strategy', 'REBUILT — strategy notes',
  'Free-form observations for drive team and strategy leads.',
  true,
  $json$[
    {"key":"context","label":"Context","type":"select","section":"Note",
     "options":["Pre-match","Post-match","Alliance selection","Scouting the field","General"]},
    {"key":"observation","label":"What you saw","type":"textarea","section":"Note","required":true},
    {"key":"strength","label":"Biggest strength","type":"text","section":"Note"},
    {"key":"weakness","label":"Exploitable weakness","type":"text","section":"Note"},
    {"key":"pair_well_with","label":"Pairs well with","type":"text","section":"Note",
     "help":"e.g. a strong L3 climber pairs with a fuel specialist"},
    {"key":"total_score","label":"Impact estimate","type":"number","section":"Note","min":0,
     "help":"Optional — leave blank if this note is not about scoring"},
    {"key":"broke","label":"Reliability concern","type":"boolean","section":"Note"},
    {"key":"no_show","label":"Did not compete","type":"boolean","section":"Note"}
  ]$json$::jsonb
);

commit;

select season, kind, name, is_active, jsonb_array_length(fields) as fields
  from public.scout_forms where season = 2026 and is_active order by kind;
