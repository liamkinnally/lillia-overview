import { scopeRecoveryTables } from './subtree-scope-recovery.mjs';
import { createHash } from 'node:crypto';
import { schemaVersion } from './goal-store.mjs';
import { projectChatThreadTables } from './project-chat-threads.mjs';
import { originTables } from './project-chat-origins.mjs';
import { chatContextTables, chatSelectionTables } from './project-chat-contexts.mjs';
import { attachmentPinTables } from './project-chat-attachment-pins.mjs';
import { chatBranchTables } from './project-chat-branches.mjs';
import { branchThreadTable } from './project-chat-branch-threads.mjs';
import { branchRuntimeTable } from './project-chat-branch-runtime.mjs';
import { nativeReleaseTables } from './native-release.mjs';
import { nativeReviewTables } from './native-review.mjs';
import { libraryTables } from './research-library.mjs';
import { reviewSeriesTables } from './native-series.mjs';
import { gitCompatibilityTables } from './git-compatibility.mjs';
import { nativeQueueTables } from './native-queue.mjs';
import { nativeJavascriptTables } from './native-javascript.mjs';
import { projectValidationTables } from './project-validation.mjs';
import { projectChangeTables } from './project-development.mjs';
import { harnessGitTables } from './harness-git.mjs';
import { nativeObjectiveTables } from './native-objective-planning.mjs';
import { nativeAuthorityTables } from './native-authority.mjs';
import { executionPinTable } from './execution-pins.mjs';

export const formatVersion = 1;
export const projectedFormatVersion = 2;
export function supportedManifest(manifest) {
  return (
    (manifest.formatVersion === 1 && manifest.projection === undefined) ||
    (manifest.formatVersion === 2 &&
      manifest.schemaVersion === 58 &&
      manifest.projection?.profile === 'thread-mail-private-bindings-v1' &&
      manifest.projection?.sourceSchema === 58)
  );
}
export const supportedSchema = (v) => Number.isInteger(v) && v >= 10 && v <= schemaVersion;
export const backupId = 0x5343424b;
export const inspectId = 0x5343524f;
export const hashed = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const recoveryConflict = (message) => Object.assign(new Error(message), { status: 409 });
export const check = (condition, message, status = 409) => {
  if (!condition) throw Object.assign(new Error(message), { status });
};
const knownTables = new Set(
  (
    'activity attempts claude_results command_receipts criterion_evidence events git_blobs git_captures git_paths git_revisions ' +
    'goal_allowances goal_completions goal_destinations goal_plans goal_revisions goal_tasks goals plan_jobs research_blobs research_entities research_pins ' +
    'service_drain workspace_admissions workspace_goals agent_workspaces worktree_captures investigation_runs time_budgets time_clock timed_attempts change_flows change_delegations review_recipes review_candidates review_agent_grants review_main review_changes review_versions review_decisions review_checks review_landings coordination_messages coordination_deliveries coordination_processed pending_effects ' +
    'research_relations research_search research_search_config research_search_content research_search_data research_search_docsize research_search_idx ' +
    'job_capabilities job_observations research_versions research_disclosures goal_model_pins provider_config_baselines attempt_configs settings sqlite_sequence task_contexts task_controls task_final_outputs tasks'
  ).split(' ')
);
knownTables.add('thread_mail_operations');
for (const name of [
  'thread_mail_reply_requests',
  'thread_mail_turn_selections',
  'thread_mail_effects',
  'thread_mail_native_requests',
  'thread_mail_native_confirmations'
])
  knownTables.add(name);
knownTables.add('thread_mail_owner_authorizations');
knownTables.add('thread_mail_owner_actions');
knownTables.add('thread_mail_owner_previews');
for (const table of [
  'thread_mail_authority',
  'thread_mail_authority_events',
  'thread_mail_permissions'
])
  knownTables.add(table);
for (const table of scopeRecoveryTables) knownTables.add(table);
knownTables.add('plan_followups');
knownTables.add(executionPinTable);
export const chatTables = ['project_chat_carriers', 'project_chat_turns'];
for (const name of [...chatTables, ...projectChatThreadTables]) knownTables.add(name);
knownTables.add('project_chat_thread_creations');
for (const name of [...originTables, ...chatContextTables, ...chatSelectionTables])
  knownTables.add(name);
for (const name of attachmentPinTables) knownTables.add(name);
for (const name of chatBranchTables) knownTables.add(name);
knownTables.add(branchThreadTable);
knownTables.add(branchRuntimeTable);
knownTables.add('review_dependencies');
export const bridgeTables = ['bridge_mappings', 'bridge_imports', 'bridge_exports'];
for (const table of bridgeTables) knownTables.add(table);
export const nativeJobTables = [
  'native_job_capabilities',
  'native_job_bindings',
  'native_job_observations'
];
for (const name of nativeJobTables) knownTables.add(name);
export const nativeTables = [
  'native_files',
  'native_file_grants',
  'native_revisions',
  'native_refs',
  'native_ref_events'
];
export const nativeOwnerTables = ['native_owner', 'native_drafts'];
for (const table of [
  ...nativeTables,
  ...nativeOwnerTables,
  ...nativeReviewTables,
  ...nativeReleaseTables,
  ...nativeAuthorityTables,
  ...nativeQueueTables,
  ...gitCompatibilityTables,
  ...reviewSeriesTables,
  ...libraryTables
])
  knownTables.add(table);
for (const table of [
  ...nativeJavascriptTables,
  ...nativeObjectiveTables,
  ...harnessGitTables,
  ...projectChangeTables,
  ...projectValidationTables,
  'task_handoffs',
  'git_cutover'
])
  knownTables.add(table);

export function schema(db, id, expected) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  check(
    db.prepare('PRAGMA application_id').get().application_id === id &&
      supportedSchema(version) &&
      (expected === undefined || expected === version),
    'Unexpected recovery application or schema version.'
  );
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
    .all()
    .map((row) => row.name);
  check(
    tables.every((name) => knownTables.has(name)),
    'A new table requires a recovery format review before backup or restore.'
  );
  return new Set(tables);
}
