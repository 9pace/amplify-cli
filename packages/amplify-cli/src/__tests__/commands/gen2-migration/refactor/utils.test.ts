import extractStackNameFromId from '../../../../commands/gen2-migration/refactor/utils';

describe('extractStackNameFromId', () => {
  it('should extract stack name from a valid CloudFormation ARN', () => {
    expect(extractStackNameFromId('arn:aws:cloudformation:us-east-1:123456:stack/my-stack-name/guid-1234')).toBe('my-stack-name');
  });

  it('should throw AmplifyError when input has no slash', () => {
    expect(() => extractStackNameFromId('not-an-arn')).toThrow('Cannot extract stack name');
  });

  it('should throw AmplifyError when input is empty', () => {
    expect(() => extractStackNameFromId('')).toThrow('Cannot extract stack name');
  });
});
