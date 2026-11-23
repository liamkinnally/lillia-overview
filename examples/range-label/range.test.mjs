import assert from 'node:assert/strict';
import test from 'node:test';
import { labelRange } from './range.mjs';
test('labels a range', () => assert.equal(labelRange(2, 4), '2–4'));
