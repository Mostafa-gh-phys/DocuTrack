import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {ID_PATTERN} from './src/utils/libraryLogic';

// Verifies the Firestore rules file structurally enforces all Eight Pillars and Dirty Dozen invariants
const rulesText = fs.readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');

test('Dirty Dozen #1 & #2: Default-deny safety net and strict owner isolation on read/list', () => {
  assert.match(rulesText, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
  assert.match(rulesText, /allow list:\s*if isOwnerRead\(userId\)\s*&&\s*resource\.data\.ownerId == request\.auth\.uid;/);
});

test('Dirty Dozen #3 & #12: Email verification gate and PII user profile isolation', () => {
  assert.match(rulesText, /request\.auth\.token\.email_verified == true/);
  assert.match(rulesText, /match \/users\/\{userId\}\s*\{[\s\S]*allow get:\s*if isValidId\(userId\) && isOwnerRead\(userId\);\s*allow list:\s*if false;/);
});

test('Dirty Dozen #4, #5, #6: OwnerId binding, hasOnly shadow field defense, and ID regex', () => {
  assert.ok(ID_PATTERN.test('book_1-alpha'));
  assert.equal(ID_PATTERN.test('a'.repeat(200) + '/bad'), false);
  assert.match(rulesText, /data\.keys\(\)\.hasAll\(/);
  assert.match(rulesText, /data\.keys\(\)\.hasOnly\(/);
  assert.match(rulesText, /data\.ownerId == userId/);
});

test('Dirty Dozen #7, #8, #9, #10, #11: Enum guard, referential integrity, immutability, server time, bounded lists', () => {
  assert.match(rulesText, /data\.format in \['pdf', 'epub', 'djvu'\]/);
  assert.match(rulesText, /data\.kind in \['highlight', 'underline', 'note', 'area', 'ink'\]/);
  assert.match(rulesText, /exists\(\/databases\/\$\(database\)\/documents\/users\/\$\(userId\)\/books\/\$\(incoming\(\)\.bookId\)\)/);
  assert.match(rulesText, /incoming\(\)\.ownerId == existing\(\)\.ownerId/);
  assert.match(rulesText, /incoming\(\)\.createdAt == request\.time/);
  assert.match(rulesText, /tags\.size\(\) <= 10/);
  assert.match(rulesText, /match \/goals\/\{goalId\}/);
  assert.match(rulesText, /history\.size\(\) <= 90/);
});
