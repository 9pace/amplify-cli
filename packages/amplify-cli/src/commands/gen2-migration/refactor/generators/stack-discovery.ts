import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { AmplifyError } from '@aws-amplify/amplify-cli-core';
import { NON_CUSTOM_RESOURCE_CATEGORY } from '../types';

const CFN_RESOURCE_STACK_TYPE = 'AWS::CloudFormation::Stack';

const CATEGORIES: NON_CUSTOM_RESOURCE_CATEGORY[] = [
  NON_CUSTOM_RESOURCE_CATEGORY.AUTH,
  NON_CUSTOM_RESOURCE_CATEGORY.STORAGE,
  NON_CUSTOM_RESOURCE_CATEGORY.ANALYTICS,
];

const GEN1_USER_POOL_GROUPS_STACK_TYPE_DESCRIPTION = 'auth-Cognito-UserPool-Groups';
const GEN1_AUTH_STACK_TYPE_DESCRIPTION = 'auth-Cognito';

/**
 * Discovers and maps category nested stacks between Gen1 and Gen2 root stacks.
 *
 * Queries both root stacks for their nested stacks, matches them by category,
 * and returns a map of category → [sourceStackId, destinationStackId].
 *
 * Special handling for auth: Gen1 may have separate stacks for UserPool vs UserPoolGroups,
 * while Gen2 combines them into one stack.
 */
export async function discoverCategoryStacks(
  cfnClient: CloudFormationClient,
  gen1RootStack: string,
  gen2RootStack: string,
  isRollback: boolean,
): Promise<Map<NON_CUSTOM_RESOURCE_CATEGORY, [string, string]>> {
  const categoryStackMap = new Map<NON_CUSTOM_RESOURCE_CATEGORY, [string, string]>();

  const sourceStackResourcesResponse = await cfnClient.send(new DescribeStackResourcesCommand({ StackName: gen1RootStack }));
  const destStackResourcesResponse = await cfnClient.send(new DescribeStackResourcesCommand({ StackName: gen2RootStack }));

  const sourceStackResources = sourceStackResourcesResponse.StackResources;
  const destStackResources = destStackResourcesResponse.StackResources;
  if (!sourceStackResources) {
    throw new AmplifyError('InvalidStackError', {
      message: 'No source stack resources found',
      resolution: 'Ensure the source stack exists and is in a stable state.',
    });
  }
  if (!destStackResources) {
    throw new AmplifyError('InvalidStackError', {
      message: 'No destination stack resources found',
      resolution: 'Ensure the destination stack exists and is in a stable state.',
    });
  }

  const sourceCategoryStacks = sourceStackResources.filter((r) => r.ResourceType === CFN_RESOURCE_STACK_TYPE);
  const destinationCategoryStacks = destStackResources.filter((r) => r.ResourceType === CFN_RESOURCE_STACK_TYPE);
  if (!sourceCategoryStacks || sourceCategoryStacks.length === 0) {
    throw new AmplifyError('InvalidStackError', {
      message: 'No nested category stacks found in source stack',
      resolution: 'Ensure the source stack contains nested category stacks (auth, storage, etc.).',
    });
  }
  if (!destinationCategoryStacks || destinationCategoryStacks.length === 0) {
    throw new AmplifyError('InvalidStackError', {
      message: 'No nested category stacks found in destination stack',
      resolution: 'Ensure the destination stack contains nested category stacks (auth, storage, etc.).',
    });
  }

  for (const { LogicalResourceId: sourceLogicalResourceId, PhysicalResourceId: sourcePhysicalResourceId } of sourceCategoryStacks) {
    const category = CATEGORIES.find((c) => sourceLogicalResourceId?.startsWith(c));
    if (!category) continue;

    if (!sourcePhysicalResourceId) {
      throw new AmplifyError('InvalidStackError', {
        message: `Source category stack '${sourceLogicalResourceId}' does not have a physical resource ID`,
        resolution: 'Ensure the stack is in a stable state before running the migration.',
      });
    }
    let destinationPhysicalResourceId: string | undefined;
    let userPoolGroupDestinationPhysicalResourceId: string | undefined;

    const correspondingCategoryStackInDestination = destinationCategoryStacks.find(({ LogicalResourceId: destLogicalId }) =>
      destLogicalId?.startsWith(category),
    );
    if (!correspondingCategoryStackInDestination) {
      throw new AmplifyError('StackStateError', {
        message: `No corresponding category found in destination stack for ${category} category`,
        resolution: 'Ensure your Gen2 stack has the corresponding category resources deployed before running the migration.',
      });
    }
    destinationPhysicalResourceId = correspondingCategoryStackInDestination.PhysicalResourceId;

    let isUserPoolGroupStack = false;

    // Auth stack discovery is asymmetric between forward and rollback:
    // Forward: Gen1 may have separate stacks for UserPool vs UserPoolGroups,
    //   so we check the SOURCE stack's description to classify it.
    // Rollback: Gen1 is now the DESTINATION, so we iterate all destination auth
    //   stacks and classify each to find the user pool group stack separately.
    if (!isRollback && category === 'auth') {
      const authCategory = await getGen1AuthCategory(cfnClient, sourcePhysicalResourceId);
      isUserPoolGroupStack = authCategory === 'auth-user-pool-group';
    } else if (isRollback && category === 'auth') {
      for (const { LogicalResourceId: destLogicalId, PhysicalResourceId: destPhysicalId } of destinationCategoryStacks) {
        if (!destPhysicalId) {
          throw new AmplifyError('InvalidStackError', {
            message: `Destination auth category stack '${destLogicalId}' does not have a physical resource ID`,
            resolution: 'Ensure the stack is in a stable state before running the migration.',
          });
        }
        if (!destLogicalId?.startsWith('auth')) continue;

        const authCategory = await getGen1AuthCategory(cfnClient, destPhysicalId);
        isUserPoolGroupStack = authCategory === 'auth-user-pool-group';

        if (isUserPoolGroupStack) {
          userPoolGroupDestinationPhysicalResourceId = destPhysicalId;
        } else if (authCategory === 'auth') {
          destinationPhysicalResourceId = destPhysicalId;
        }
      }
    }

    if (!destinationPhysicalResourceId) {
      throw new AmplifyError('InvalidStackError', {
        message: `No destination stack resolved for ${category} category`,
        resolution: 'Ensure the destination stack has the corresponding category resources deployed.',
      });
    }

    // Forward: only add the main auth entry when this is NOT a user pool group stack.
    // Rollback: always add the main auth entry — Gen2 has a single auth stack that
    // contains both user pool and user pool group resources.
    if (!isUserPoolGroupStack || isRollback) {
      categoryStackMap.set(category, [sourcePhysicalResourceId, destinationPhysicalResourceId]);
    }
    if (isUserPoolGroupStack) {
      const destinationId =
        isRollback && userPoolGroupDestinationPhysicalResourceId
          ? userPoolGroupDestinationPhysicalResourceId
          : destinationPhysicalResourceId;
      categoryStackMap.set(NON_CUSTOM_RESOURCE_CATEGORY.AUTH_USER_POOL_GROUP, [sourcePhysicalResourceId, destinationId]);
    }
  }

  return categoryStackMap;
}

/**
 * Determines the type of a Gen1 auth stack by parsing its Description metadata.
 * @returns the category enum value, or null if unknown
 */
async function getGen1AuthCategory(cfnClient: CloudFormationClient, stackName: string): Promise<NON_CUSTOM_RESOURCE_CATEGORY | null> {
  const describeStacksResponse = await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
  const stackDescription = describeStacksResponse?.Stacks?.[0]?.Description;
  if (!stackDescription) return null;

  try {
    const parsed = JSON.parse(stackDescription);
    if (typeof parsed === 'object' && 'stackType' in parsed) {
      switch (parsed.stackType) {
        case GEN1_USER_POOL_GROUPS_STACK_TYPE_DESCRIPTION:
          return NON_CUSTOM_RESOURCE_CATEGORY.AUTH_USER_POOL_GROUP;
        case GEN1_AUTH_STACK_TYPE_DESCRIPTION:
          return NON_CUSTOM_RESOURCE_CATEGORY.AUTH;
      }
    }
  } catch {
    // Description might not be valid JSON — fail silently
  }
  return null;
}
