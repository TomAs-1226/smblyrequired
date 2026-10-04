// =============================================================================
// Cloud Functions for the Team 5805 portal.
//
// The portal is a static bundle that talks to Firestore and Storage directly,
// with the security rules as the access boundary. These functions are the few
// things a browser must not do:
//
//   change a role or remove a member     setMemberRole, deleteMember
//   hold an API key                      tbaProxy, nexusProxy, ai
//   (and cache a public API politely)    statboticsProxy
//   keep what SQL kept with views,       onScoutEntryWritten, onRobotPhotoWritten,
//   triggers and foreign keys            onKnowledgeDocUpdated, onFileDeleted
//
// This file is only the list. Each function's reasoning lives with its code in
// src/, and docs/FIREBASE.md is the contract they all follow.
//
// On CORS: the old backend kept an allow-list of origins. A callable needs none.
// The caller's identity is an ID token the portal's own script attaches to each
// request, not a cookie the browser sends by itself, so another website cannot
// make a signed-in student's browser call these with their identity attached.
// =============================================================================

import { onDocumentDeleted, onDocumentUpdated, onDocumentWritten } from 'firebase-functions/firestore'
import { onCall } from 'firebase-functions/https'

import { handleAi } from './src/ai.js'
import { NEXUS_KEY, OPENAI_API_KEY, REGION, TBA_KEY } from './src/config.js'
import { cascadeFileDelete } from './src/files.js'
import { snapshotKnowledgeDoc } from './src/knowledge.js'
import { deleteMember as removeMember, setMemberRole as changeRole } from './src/members.js'
import { handleNexus } from './src/nexus.js'
import { guarded } from './src/roles.js'
import { handleStatbotics } from './src/statbotics.js'
import { refreshStatsFor } from './src/statsTriggers.js'
import { handleTba } from './src/tba.js'

export { REGION }

// ---- callable ---------------------------------------------------------------
// Each answers with its data directly, or refuses with an HttpsError whose
// message is already a sentence for the person reading it. `guarded` checks the
// caller's role in profiles/{uid} before the handler runs.

export const setMemberRole = onCall(
  { region: REGION },
  guarded('admin', 'setMemberRole', 'That role change failed unexpectedly.', changeRole)
)

export const deleteMember = onCall(
  { region: REGION },
  guarded('admin', 'deleteMember', 'Removing that member failed unexpectedly.', removeMember)
)

// member, not viewer: alumni and parents sit at `viewer` and have no business
// spending the team's API quota. It is also the floor the rules put on reading
// the two collections tbaProxy caches into.
export const tbaProxy = onCall(
  { region: REGION, secrets: [TBA_KEY] },
  guarded('member', 'tba', 'The Blue Alliance lookup failed unexpectedly.', (request) => handleTba(request.data))
)

export const nexusProxy = onCall(
  { region: REGION, secrets: [NEXUS_KEY] },
  guarded('member', 'nexus', 'The Nexus lookup failed unexpectedly.', (request) => handleNexus(request.data))
)

export const statboticsProxy = onCall(
  { region: REGION },
  guarded('member', 'statbotics', 'The Statbotics lookup failed unexpectedly.', (request) =>
    handleStatbotics(request.data)
  )
)

// A model call can take most of a minute on a long pick list.
export const ai = onCall(
  { region: REGION, secrets: [OPENAI_API_KEY], timeoutSeconds: 120 },
  guarded('member', 'ai', 'That AI request failed unexpectedly.', (request, caller) =>
    handleAi(caller.uid, request.data)
  )
)

// ---- Firestore triggers -----------------------------------------------------
// `retry` is on for all four: each does work that is safe to repeat, and a
// statistic that is quietly never updated is worse than one computed twice.

export const onScoutEntryWritten = onDocumentWritten(
  { document: 'scout_entries/{id}', region: REGION, retry: true },
  refreshStatsFor
)

export const onRobotPhotoWritten = onDocumentWritten(
  { document: 'robot_photos/{id}', region: REGION, retry: true },
  refreshStatsFor
)

export const onKnowledgeDocUpdated = onDocumentUpdated(
  { document: 'knowledge_docs/{id}', region: REGION, retry: true },
  snapshotKnowledgeDoc
)

export const onFileDeleted = onDocumentDeleted(
  { document: 'files/{id}', region: REGION, retry: true },
  cascadeFileDelete
)
