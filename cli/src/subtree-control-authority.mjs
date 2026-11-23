import { chatProject } from './project-chat-origins.mjs';
import { verifyProjectChat } from './project-chat.mjs';
import { readBranchThread, verifyBranchThreads } from './project-chat-branch-threads.mjs';
import { readChatBranch } from './project-chat-branches.mjs';

// Raw verified facts only. These records supply neither a chat admission gate nor
// membership/task-control generations; specVersion remains specification provenance.
export function readSubtreeControlFacts(store, { projectId, threadId }) {
  const db = store.db;
  function read() {
    if (chatProject(db).projectId !== projectId) throw Error('Foreign project.');
    if (
      typeof threadId !== 'string' ||
      !db.prepare('SELECT 1 FROM project_chat_threads WHERE id=?').get(threadId)
    )
      throw Error('Project thread not found.');
    // Reuse native output, owner receipt and child admission proof instead of trusting
    // workGoalId or branch rows alone. Corrupt same-store evidence fails closed.
    verifyProjectChat(db);
    verifyBranchThreads(db);
    const relations = db
      .prepare('SELECT threadId FROM project_chat_branch_threads ORDER BY threadId')
      .all()
      .map((row) => {
        const verified = readBranchThread(db, row.threadId);
        if (verified.branchThread.projectId !== projectId) throw Error('Foreign branch project.');
        const { branch } = readChatBranch(db, {
          projectId,
          id: verified.branchThread.preparationId
        });
        return {
          id: row.threadId,
          parentThreadId: branch.parentThreadId,
          preparationId: branch.id
        };
      });
    const descendants = relations.filter((row) => row.parentThreadId === threadId);
    const taskFacts = (id) => {
      const row = db
        .prepare(
          `SELECT t.id,g.goalId,g.goalVersion,g.specVersion,g.provider,
        t.status,t.recoveryCleared,t.threadId AS nativeThreadId,t.turnId AS nativeTurnId,t.dependsOn
        FROM tasks t JOIN goal_tasks g ON g.taskId=t.id WHERE t.id=?`
        )
        .get(id);
      if (!row) throw Error('Owned task not found.');
      const latestAttempt =
        db
          .prepare(
            `SELECT id,ordinal,status,threadId AS nativeThreadId,
        turnId AS nativeTurnId FROM attempts WHERE taskId=? ORDER BY ordinal DESC LIMIT 1`
          )
          .get(id) ?? null;
      return { ...row, dependsOn: JSON.parse(row.dependsOn), latestAttempt };
    };
    const threads = [threadId, ...descendants.map((row) => row.id)].map((id) => {
      const turns = db
        .prepare(
          `SELECT u.id,u.taskId,u.carrierGoalId,u.workGoalId FROM project_chat_turns u
        JOIN project_chat_turn_threads m ON m.turnId=u.id WHERE m.threadId=? ORDER BY u.id`
        )
        .all(id);
      return {
        id,
        parentThreadId: relations.find((row) => row.id === id)?.parentThreadId ?? null,
        workGoals: turns
          .filter((turn) => turn.workGoalId !== null)
          .map((turn) => {
            const goal = db
              .prepare('SELECT id,version,state FROM goals WHERE id=?')
              .get(turn.workGoalId);
            if (!goal) throw Error('Owned work goal not found.');
            return {
              ...goal,
              ownerTurnId: turn.id,
              tasks: db
                .prepare('SELECT taskId FROM goal_tasks WHERE goalId=? ORDER BY taskId')
                .all(goal.id)
                .map((row) => taskFacts(row.taskId))
            };
          }),
        carrierTurns: turns
          .filter((turn) => turn.taskId !== null)
          .map((turn) => {
            const task = taskFacts(turn.taskId);
            if (task.goalId !== turn.carrierGoalId) throw Error('Carrier task binding differs.');
            return { turnId: turn.id, carrierGoalId: turn.carrierGoalId, task };
          })
      };
    });
    return { projectId, threadId, descendants, threads };
  }
  return db.isTransaction ? read() : store.transaction(read);
}
