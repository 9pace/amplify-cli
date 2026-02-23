import { isRefactorFailure, RefactorResult } from '../../../../commands/gen2-migration/refactor/types';

describe('isRefactorFailure', () => {
  it('should return true for failure result', () => {
    const result: RefactorResult = {
      success: false,
      failure: { reason: 'test', stackRefactorId: 'id-123', status: undefined },
    };
    expect(isRefactorFailure(result)).toBe(true);
  });

  it('should return false for success result', () => {
    const result: RefactorResult = { success: true };
    expect(isRefactorFailure(result)).toBe(false);
  });
});
