import { AmplifyError } from '@aws-amplify/amplify-cli-core';

export function extractStackNameFromId(stackId: string): string {
  const name = stackId.split('/')[1];
  if (!name) {
    throw new AmplifyError('InvalidStackError', {
      message: `Cannot extract stack name from '${stackId}' — expected a CloudFormation stack ARN`,
      resolution: 'Ensure the stack ID is a valid CloudFormation ARN (e.g., arn:aws:cloudformation:region:account:stack/name/id).',
    });
  }
  return name;
}
