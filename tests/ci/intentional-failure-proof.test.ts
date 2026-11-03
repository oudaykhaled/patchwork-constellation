import { expect, test } from 'vitest';

test('CI verification only: this assertion intentionally fails; do not merge', () => {
  expect('intentional CI failure proof for issue 2').toBe('this temporary proof must fail');
});
