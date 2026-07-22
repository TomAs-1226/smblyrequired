-- =============================================================================
-- 0012 — A configurable detection model for the vision pipeline.
--
-- 0011 shipped the pipeline with a GENERIC detector (COCO-SSD) hard-wired in. It
-- proved the plumbing but it cannot tell a robot from a referee — COCO has no
-- such class. This migration makes the model a SETTING, not a constant, so a lead
-- can point the pipeline at a real FRC-trained detector (a YOLO model exported to
-- TensorFlow.js — the format PhotonVision, Roboflow and Ultralytics all produce,
-- i.e. what other teams actually train and deploy) hosted anywhere reachable.
--
-- Null url  => the built-in generic model, honestly labelled as such.
-- Set url   => that model runs on-device instead, and every session/observation
--              it produces is attributed to it (vision_sessions.model, 0011), so
--              the honesty guarantee survives the swap: old rows keep the model
--              that actually made them.
--
-- Lives on the scout_settings singleton (0010): member+ reads it (an operator's
-- phone must load the model), lead+ writes it. Same lever pattern as the active
-- event and the scouting window.
-- =============================================================================

alter table public.scout_settings
  -- URL to a TF.js Graph model's `model.json` (its weight shards must sit beside
  -- it, as a tfjs export lays them out). Null = use the built-in generic model.
  add column if not exists vision_model_url    text,
  -- A human name for the roster UI, e.g. "FRC 2024 robots v3".
  add column if not exists vision_model_name   text,
  -- Class names, index-aligned to the model's output channels. For a YOLO export
  -- this is the `names:` list from training. Empty => fall back to "class N".
  add column if not exists vision_model_labels jsonb not null default '[]'::jsonb,
  -- The square input size the model was exported at (YOLO default 640). Frames
  -- are letterboxed to this before inference.
  add column if not exists vision_model_size   integer not null default 640;

-- Guardrails a careless setting cannot get past. A model at 0px or with 100k
-- classes is a typo, not a config, and better rejected here than as a cryptic
-- WebGL failure on a scout's phone at a competition.
alter table public.scout_settings
  drop constraint if exists scout_settings_vision_model_size_ck;
alter table public.scout_settings
  add constraint scout_settings_vision_model_size_ck
  check (vision_model_size between 64 and 2048);

alter table public.scout_settings
  drop constraint if exists scout_settings_vision_model_labels_ck;
alter table public.scout_settings
  add constraint scout_settings_vision_model_labels_ck
  check (jsonb_typeof(vision_model_labels) = 'array' and jsonb_array_length(vision_model_labels) <= 1000);
