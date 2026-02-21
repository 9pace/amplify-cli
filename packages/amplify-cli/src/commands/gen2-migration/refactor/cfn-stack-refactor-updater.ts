import {
  CloudFormationClient,
  CreateStackRefactorCommand,
  CreateStackRefactorCommandInput,
  DescribeStackRefactorCommand,
  DescribeStackRefactorCommandOutput,
  ExecuteStackRefactorCommand,
  StackRefactorExecutionStatus,
  StackRefactorStatus,
} from '@aws-sdk/client-cloudformation';
import { CFNStackStatus, CFN_TERMINAL_STATE_SUFFIX, CFN_FAILED_STATE_SUFFIX, FailedRefactorResponse } from './types';
import { pollStackForTerminalState } from './cfn-stack-updater';
import { AmplifyError } from '@aws-amplify/amplify-cli-core';

const POLL_ATTEMPTS = 300;
const POLL_INTERVAL_MS = 12000;
/**
 * Refactors a stack with given source and destination template.
 * Creates the refactor, polls for terminal state, executes it, then verifies both stacks updated.
 * @param cfnClient
 * @param createStackRefactorCommandInput
 * @param attempts number of attempts to poll. The interval between polls is 12 seconds.
 * @returns a tuple of [success, failureDetails]. On success, failureDetails is undefined.
 */
export async function tryRefactorStack(
  cfnClient: CloudFormationClient,
  createStackRefactorCommandInput: CreateStackRefactorCommandInput,
  attempts = POLL_ATTEMPTS,
): Promise<[boolean, FailedRefactorResponse | undefined]> {
  const { StackRefactorId } = await cfnClient.send(new CreateStackRefactorCommand(createStackRefactorCommandInput));
  if (!StackRefactorId) {
    throw new AmplifyError('DeploymentError', {
      message: 'CreateStackRefactor did not return a StackRefactorId.',
      resolution: 'Retry the operation. If the problem persists, check the CloudFormation console for errors.',
    });
  }
  let describeStackRefactorResponse = await pollStackRefactorForTerminalState(
    cfnClient,
    StackRefactorId,
    (_describeStackRefactorResponse: DescribeStackRefactorCommandOutput) => {
      if (!_describeStackRefactorResponse.Status) return false;
      return (
        _describeStackRefactorResponse.Status.endsWith(CFN_TERMINAL_STATE_SUFFIX) ||
        _describeStackRefactorResponse.Status.endsWith(CFN_FAILED_STATE_SUFFIX)
      );
    },
    attempts,
  );
  if (describeStackRefactorResponse.Status !== StackRefactorStatus.CREATE_COMPLETE) {
    return [
      false,
      {
        status: describeStackRefactorResponse.Status,
        reason: describeStackRefactorResponse.StatusReason,
        stackRefactorId: StackRefactorId,
      },
    ];
  }
  await cfnClient.send(
    new ExecuteStackRefactorCommand({
      StackRefactorId,
    }),
  );
  describeStackRefactorResponse = await pollStackRefactorForTerminalState(
    cfnClient,
    StackRefactorId,
    (describeStackRefactorResponse: DescribeStackRefactorCommandOutput) => {
      if (!describeStackRefactorResponse.ExecutionStatus) return false;
      return (
        describeStackRefactorResponse.ExecutionStatus.endsWith(CFN_TERMINAL_STATE_SUFFIX) ||
        describeStackRefactorResponse.ExecutionStatus.endsWith(CFN_FAILED_STATE_SUFFIX)
      );
    },
    attempts,
  );
  if (describeStackRefactorResponse.ExecutionStatus !== StackRefactorExecutionStatus.EXECUTE_COMPLETE) {
    return [
      false,
      {
        status: describeStackRefactorResponse.ExecutionStatus,
        stackRefactorId: StackRefactorId,
        reason: describeStackRefactorResponse.ExecutionStatusReason,
      },
    ];
  }

  const sourceStackName = createStackRefactorCommandInput.StackDefinitions?.[0].StackName;
  const destinationStackName = createStackRefactorCommandInput.StackDefinitions?.[1].StackName;
  if (!sourceStackName || !destinationStackName) {
    throw new AmplifyError('DeploymentError', {
      message: 'Stack refactor input is missing source or destination stack name.',
      resolution: 'This is an internal error. Please report it with the full command output.',
    });
  }
  const sourceStackStatus = await pollStackForTerminalState(cfnClient, sourceStackName);
  if (sourceStackStatus !== CFNStackStatus.UPDATE_COMPLETE) {
    throw new AmplifyError('DeploymentError', {
      message: `${sourceStackName} was not updated successfully. Status: ${sourceStackStatus}`,
      resolution: `Check the CloudFormation console for stack '${sourceStackName}' to see failure details.`,
    });
  }
  const destinationStackStatus = await pollStackForTerminalState(cfnClient, destinationStackName);
  if (destinationStackStatus !== CFNStackStatus.UPDATE_COMPLETE) {
    throw new AmplifyError('DeploymentError', {
      message: `${destinationStackName} was not updated successfully. Status: ${destinationStackStatus}`,
      resolution: `Check the CloudFormation console for stack '${destinationStackName}' to see failure details.`,
    });
  }

  return [true, undefined];
}

/**
 * Polls a stack refactor operation for a terminal state.
 * @param cfnClient
 * @param stackRefactorId
 * @param exitCondition determines if the refactor has reached a terminal state.
 * @param attempts number of attempts to poll.
 * @returns the describe response once terminal state is reached
 */
async function pollStackRefactorForTerminalState(
  cfnClient: CloudFormationClient,
  stackRefactorId: string,
  exitCondition: (describeStackRefactorResponse: DescribeStackRefactorCommandOutput) => boolean,
  attempts: number,
): Promise<DescribeStackRefactorCommandOutput> {
  do {
    const describeStackRefactorResponse = await cfnClient.send(
      new DescribeStackRefactorCommand({
        StackRefactorId: stackRefactorId,
      }),
    );
    if (exitCondition(describeStackRefactorResponse)) {
      return describeStackRefactorResponse;
    }
    await new Promise((res) => setTimeout(() => res(''), POLL_INTERVAL_MS));
    attempts--;
  } while (attempts > 0);
  throw new AmplifyError('DeploymentError', {
    message: `Stack refactor ${stackRefactorId} did not reach a terminal state within the given time period.`,
    resolution: `Check the CloudFormation console for stack refactor '${stackRefactorId}' to see the current status and any failure reasons. If the operation is still in progress, re-run the command after it completes.`,
  });
}
