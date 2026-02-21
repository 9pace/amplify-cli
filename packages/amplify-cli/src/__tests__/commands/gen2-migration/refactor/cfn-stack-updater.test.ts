import { CloudFormationClient, DescribeStacksCommand, UpdateStackCommand } from '@aws-sdk/client-cloudformation';
import { tryUpdateStack, pollStackForTerminalState } from '../../../../commands/gen2-migration/refactor/cfn-stack-updater';
import { CFNStackStatus, CFNTemplate } from '../../../../commands/gen2-migration/refactor/types';

jest.useFakeTimers();

const STACK_NAME = 'test-stack';
const TEMPLATE: CFNTemplate = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'test',
  Resources: { Placeholder: { Type: 'AWS::CloudFormation::WaitConditionHandle', Properties: {} } },
  Outputs: {},
};

const mockSend = jest.fn();
const cfnClient = { send: mockSend } as unknown as CloudFormationClient;

afterEach(() => jest.clearAllMocks());

describe('tryUpdateStack', () => {
  it('should update stack and return completion status', async () => {
    mockSend.mockImplementation((command) => {
      if (command instanceof UpdateStackCommand) return Promise.resolve({});
      if (command instanceof DescribeStacksCommand) {
        return Promise.resolve({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] });
      }
      return Promise.resolve({});
    });

    const result = await tryUpdateStack(cfnClient, STACK_NAME, [], TEMPLATE, 1);
    expect(result).toBe('UPDATE_COMPLETE');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('should return UPDATE_COMPLETE when no updates are to be performed', async () => {
    mockSend.mockImplementation((command) => {
      if (command instanceof UpdateStackCommand) {
        throw Object.assign(new Error('No updates are to be performed'), { message: 'No updates are to be performed' });
      }
      return Promise.resolve({});
    });

    const result = await tryUpdateStack(cfnClient, STACK_NAME, [], TEMPLATE);
    expect(result).toBe(CFNStackStatus.UPDATE_COMPLETE);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('should rethrow non-"no updates" errors', async () => {
    mockSend.mockImplementation((command) => {
      if (command instanceof UpdateStackCommand) {
        throw new Error('Malformed template');
      }
      return Promise.resolve({});
    });

    await expect(tryUpdateStack(cfnClient, STACK_NAME, [], TEMPLATE)).rejects.toThrow('Malformed template');
  });
});

describe('pollStackForTerminalState', () => {
  it('should return status when stack reaches completion state', async () => {
    mockSend.mockResolvedValue({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] });

    const result = await pollStackForTerminalState(cfnClient, STACK_NAME, 1);
    expect(result).toBe('UPDATE_COMPLETE');
  });

  it('should throw DeploymentError when polling times out', async () => {
    mockSend.mockResolvedValue({ Stacks: [{ StackStatus: 'UPDATE_IN_PROGRESS' }] });

    const promise = pollStackForTerminalState(cfnClient, STACK_NAME, 1);
    // Flush microtasks so the first poll completes, then advance past the setTimeout
    await Promise.resolve();
    jest.advanceTimersByTime(5000);
    await expect(promise).rejects.toThrow('did not reach a terminal state');
  });

  it('should throw DeploymentError when stack is not found', async () => {
    mockSend.mockResolvedValue({ Stacks: [] });

    await expect(pollStackForTerminalState(cfnClient, STACK_NAME, 1)).rejects.toThrow('not found in DescribeStacks response');
  });

  it('should throw DeploymentError when stack has no status', async () => {
    mockSend.mockResolvedValue({ Stacks: [{ StackStatus: undefined }] });

    await expect(pollStackForTerminalState(cfnClient, STACK_NAME, 1)).rejects.toThrow('has no status');
  });

  it('should poll multiple times before reaching completion', async () => {
    let callCount = 0;
    mockSend.mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({ Stacks: [{ StackStatus: 'UPDATE_IN_PROGRESS' }] });
      }
      return Promise.resolve({ Stacks: [{ StackStatus: 'UPDATE_COMPLETE' }] });
    });

    const promise = pollStackForTerminalState(cfnClient, STACK_NAME, 5);
    // Advance timers to allow polling iterations
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
    }
    const result = await promise;
    expect(result).toBe('UPDATE_COMPLETE');
    expect(callCount).toBe(3);
  });
});
