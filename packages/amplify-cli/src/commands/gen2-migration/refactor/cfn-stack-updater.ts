import { CloudFormationClient, DescribeStacksCommand, Parameter, UpdateStackCommand } from '@aws-sdk/client-cloudformation';
import { CFNTemplate } from './types';
import { AmplifyError } from '@aws-amplify/amplify-cli-core';

const POLL_ATTEMPTS = 120;
const POLL_INTERVAL_MS = 5 * 1000;
const NO_UPDATES_MESSAGE = 'No updates are to be performed';
const CFN_IAM_CAPABILIY = 'CAPABILITY_NAMED_IAM';
const COMPLETION_STATE = '_COMPLETE';
export const UPDATE_COMPLETE = 'UPDATE_COMPLETE';
/**
 * Updates a stack with given template. If no updates are present, it no-ops.
 * @param cfnClient
 * @param stackName
 * @param parameters
 * @param templateBody
 * @param attempts number of attempts to poll CFN stack for update completion state. The interval between the polls is 5 seconds.
 */
export async function tryUpdateStack(
  cfnClient: CloudFormationClient,
  stackName: string,
  parameters: Parameter[],
  templateBody: CFNTemplate,
  attempts = POLL_ATTEMPTS,
): Promise<string> {
  try {
    await cfnClient.send(
      new UpdateStackCommand({
        TemplateBody: JSON.stringify(templateBody),
        Parameters: parameters,
        StackName: stackName,
        Capabilities: [CFN_IAM_CAPABILIY],
        Tags: [],
      }),
    );
    return pollStackForCompletionState(cfnClient, stackName, attempts);
  } catch (e) {
    if (!(e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' && e.message.includes(NO_UPDATES_MESSAGE))) {
      throw e;
    }
    return UPDATE_COMPLETE;
  }
}

/**
 * Polls a stack for completion state
 * @param cfnClient
 * @param stackName
 * @param attempts number of attempts to poll for completion.
 * @returns the stack status
 */
export async function pollStackForCompletionState(
  cfnClient: CloudFormationClient,
  stackName: string,
  attempts: number = POLL_ATTEMPTS,
): Promise<string> {
  do {
    const { Stacks } = await cfnClient.send(
      new DescribeStacksCommand({
        StackName: stackName,
      }),
    );
    const stack = Stacks?.[0];
    if (!stack) {
      throw new AmplifyError('DeploymentError', {
        message: `Stack '${stackName}' not found in DescribeStacks response.`,
        resolution: `Verify the stack '${stackName}' exists in your AWS account and region.`,
      });
    }
    const stackStatus = stack.StackStatus;
    if (!stackStatus) {
      throw new AmplifyError('DeploymentError', {
        message: `Stack '${stackName}' has no status.`,
        resolution: `Check the CloudFormation console for stack '${stackName}' to see its current state.`,
      });
    }
    if (stackStatus?.endsWith(COMPLETION_STATE)) {
      return stackStatus;
    }
    await new Promise((res) => setTimeout(() => res(''), POLL_INTERVAL_MS));
    attempts--;
  } while (attempts > 0);
  throw new AmplifyError('DeploymentError', {
    message: `Stack ${stackName} did not reach a completion state within the given time period.`,
    resolution: `Check the CloudFormation console for stack '${stackName}' to see the current status and any failure reasons. If the stack is still in progress, re-run the command after it completes.`,
  });
}
