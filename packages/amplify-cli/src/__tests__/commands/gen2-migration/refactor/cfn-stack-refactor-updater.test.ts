import {
  CloudFormationClient,
  CreateStackRefactorCommand,
  CreateStackRefactorCommandInput,
  DescribeStackRefactorCommand,
  ExecuteStackRefactorCommand,
  StackRefactorExecutionStatus,
  StackRefactorStatus,
} from '@aws-sdk/client-cloudformation';
import { refactorStack } from '../../../../commands/gen2-migration/refactor/cfn-stack-refactor-updater';
import { pollStackForTerminalState } from '../../../../commands/gen2-migration/refactor/cfn-stack-updater';

jest.mock('../../../../commands/gen2-migration/refactor/cfn-stack-updater', () => ({
  pollStackForTerminalState: jest.fn(),
}));

jest.useFakeTimers();

const mockPollStack = pollStackForTerminalState as jest.MockedFunction<typeof pollStackForTerminalState>;
const mockSend = jest.fn();
const cfnClient = { send: mockSend } as unknown as CloudFormationClient;

const REFACTOR_ID = 'refactor-123';
const SOURCE_STACK = 'source-stack';
const DEST_STACK = 'dest-stack';

const INPUT: CreateStackRefactorCommandInput = {
  StackDefinitions: [
    { StackName: SOURCE_STACK, TemplateBody: '{}' },
    { StackName: DEST_STACK, TemplateBody: '{}' },
  ],
  ResourceMappings: [],
};

afterEach(() => jest.clearAllMocks());

describe('refactorStack', () => {
  it('should return success when create, execute, and stack updates all complete', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateStackRefactorCommand) {
        return Promise.resolve({ StackRefactorId: REFACTOR_ID });
      }
      if (command instanceof DescribeStackRefactorCommand) {
        return Promise.resolve({
          Status: StackRefactorStatus.CREATE_COMPLETE,
          ExecutionStatus: StackRefactorExecutionStatus.EXECUTE_COMPLETE,
        });
      }
      if (command instanceof ExecuteStackRefactorCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    mockPollStack.mockResolvedValue('UPDATE_COMPLETE');

    const result = await refactorStack(cfnClient, INPUT, 1);

    expect(result).toEqual({ success: true });
    expect(mockSend).toHaveBeenCalledTimes(4); // create, describe, execute, describe
    expect(mockPollStack).toHaveBeenCalledTimes(2);
    expect(mockPollStack).toHaveBeenCalledWith(cfnClient, SOURCE_STACK);
    expect(mockPollStack).toHaveBeenCalledWith(cfnClient, DEST_STACK);
  });

  it('should return failure when create phase fails', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateStackRefactorCommand) {
        return Promise.resolve({ StackRefactorId: REFACTOR_ID });
      }
      if (command instanceof DescribeStackRefactorCommand) {
        return Promise.resolve({
          Status: StackRefactorStatus.CREATE_FAILED,
          StatusReason: 'Validation error',
        });
      }
      return Promise.resolve({});
    });

    const result = await refactorStack(cfnClient, INPUT, 1);

    expect(result).toEqual({
      success: false,
      failure: {
        status: StackRefactorStatus.CREATE_FAILED,
        reason: 'Validation error',
        stackRefactorId: REFACTOR_ID,
      },
    });
    expect(mockPollStack).not.toHaveBeenCalled();
  });

  it('should return failure when execute phase fails', async () => {
    let describeCallCount = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateStackRefactorCommand) {
        return Promise.resolve({ StackRefactorId: REFACTOR_ID });
      }
      if (command instanceof DescribeStackRefactorCommand) {
        describeCallCount++;
        if (describeCallCount === 1) {
          return Promise.resolve({ Status: StackRefactorStatus.CREATE_COMPLETE });
        }
        return Promise.resolve({
          ExecutionStatus: StackRefactorExecutionStatus.EXECUTE_FAILED,
          ExecutionStatusReason: 'Resource conflict',
        });
      }
      if (command instanceof ExecuteStackRefactorCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const result = await refactorStack(cfnClient, INPUT, 1);

    expect(result).toEqual({
      success: false,
      failure: {
        status: StackRefactorExecutionStatus.EXECUTE_FAILED,
        reason: 'Resource conflict',
        stackRefactorId: REFACTOR_ID,
      },
    });
    expect(mockPollStack).not.toHaveBeenCalled();
  });

  it('should throw when polling times out', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateStackRefactorCommand) {
        return Promise.resolve({ StackRefactorId: REFACTOR_ID });
      }
      if (command instanceof DescribeStackRefactorCommand) {
        return Promise.resolve({ Status: 'CREATE_IN_PROGRESS' });
      }
      return Promise.resolve({});
    });

    const promise = refactorStack(cfnClient, INPUT, 1);
    // Flush microtasks so the async flow reaches the setTimeout
    for (let i = 0; i < 10; i++) await Promise.resolve();
    jest.advanceTimersByTime(12000);

    await expect(promise).rejects.toThrow('did not reach a terminal state');
  });

  it('should throw when CreateStackRefactor returns no StackRefactorId', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateStackRefactorCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await expect(refactorStack(cfnClient, INPUT, 1)).rejects.toThrow('CreateStackRefactor did not return a StackRefactorId');
  });

  it('should throw when source stack does not reach UPDATE_COMPLETE', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateStackRefactorCommand) {
        return Promise.resolve({ StackRefactorId: REFACTOR_ID });
      }
      if (command instanceof DescribeStackRefactorCommand) {
        return Promise.resolve({
          Status: StackRefactorStatus.CREATE_COMPLETE,
          ExecutionStatus: StackRefactorExecutionStatus.EXECUTE_COMPLETE,
        });
      }
      if (command instanceof ExecuteStackRefactorCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    mockPollStack.mockResolvedValue('ROLLBACK_COMPLETE');

    await expect(refactorStack(cfnClient, INPUT, 1)).rejects.toThrow(`${SOURCE_STACK} was not updated successfully`);
  });

  it('should throw when destination stack does not reach UPDATE_COMPLETE', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateStackRefactorCommand) {
        return Promise.resolve({ StackRefactorId: REFACTOR_ID });
      }
      if (command instanceof DescribeStackRefactorCommand) {
        return Promise.resolve({
          Status: StackRefactorStatus.CREATE_COMPLETE,
          ExecutionStatus: StackRefactorExecutionStatus.EXECUTE_COMPLETE,
        });
      }
      if (command instanceof ExecuteStackRefactorCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    mockPollStack.mockResolvedValueOnce('UPDATE_COMPLETE').mockResolvedValueOnce('ROLLBACK_COMPLETE');

    await expect(refactorStack(cfnClient, INPUT, 1)).rejects.toThrow(`${DEST_STACK} was not updated successfully`);
  });

  it('should throw when stack definitions are missing stack names', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof CreateStackRefactorCommand) {
        return Promise.resolve({ StackRefactorId: REFACTOR_ID });
      }
      if (command instanceof DescribeStackRefactorCommand) {
        return Promise.resolve({
          Status: StackRefactorStatus.CREATE_COMPLETE,
          ExecutionStatus: StackRefactorExecutionStatus.EXECUTE_COMPLETE,
        });
      }
      if (command instanceof ExecuteStackRefactorCommand) {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const inputWithoutNames: CreateStackRefactorCommandInput = {
      StackDefinitions: [{ TemplateBody: '{}' }, { TemplateBody: '{}' }],
      ResourceMappings: [],
    };

    await expect(refactorStack(cfnClient, inputWithoutNames, 1)).rejects.toThrow('missing source or destination stack name');
  });
});
