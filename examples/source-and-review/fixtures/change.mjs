// Synthetic source text for the storage example; these strings are retained,
// not executed. The demo does not run agents or claim a review occurred.
export const repository = 'queue-example';
export const actor = {
  name: 'Example author',
  email: 'author@example.invalid',
  seconds: 0,
  offset: '+0000'
};

export const baseFiles = [
  {
    path: 'src/queue.mjs',
    text: 'export const canRun = queue => queue.length >= 0;\n'
  },
  {
    path: 'test/queue.test.mjs',
    text: [
      "import assert from 'node:assert/strict';",
      "import { canRun } from '../src/queue.mjs';",
      "assert.equal(canRun(['job']), true);",
      ''
    ].join('\n')
  }
];

export const candidateFiles = [
  {
    path: 'src/queue.mjs',
    text: 'export const canRun = queue => queue.length > 0;\n'
  },
  {
    path: 'test/queue.test.mjs',
    text: baseFiles[1].text + 'assert.equal(canRun([]), false);\n'
  }
];
