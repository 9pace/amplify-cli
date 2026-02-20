import '../generators/setup-jest';
import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { discoverCategoryStacks } from '../../../../../commands/gen2-migration/refactor/generators/stack-discovery';
import { NON_CUSTOM_RESOURCE_CATEGORY } from '../../../../../commands/gen2-migration/refactor/types';

const mockSend = jest.fn();
const cfnClient = { send: mockSend } as unknown as CloudFormationClient;

const GEN1_ROOT = 'gen1-root';
const GEN2_ROOT = 'gen2-root';
const STACK_TYPE = 'AWS::CloudFormation::Stack';

function stackResource(logicalId: string, physicalId: string) {
  return {
    ResourceType: STACK_TYPE,
    LogicalResourceId: logicalId,
    PhysicalResourceId: physicalId,
    ResourceStatus: 'CREATE_COMPLETE',
    Timestamp: new Date(),
  };
}

function nonStackResource(logicalId: string) {
  return {
    ResourceType: 'AWS::S3::Bucket',
    LogicalResourceId: logicalId,
    PhysicalResourceId: logicalId,
    ResourceStatus: 'CREATE_COMPLETE',
    Timestamp: new Date(),
  };
}

function describeStackResponse(description: string) {
  return { Stacks: [{ Description: description }] };
}

describe('discoverCategoryStacks', () => {
  beforeEach(() => mockSend.mockReset());

  it('should discover non-auth categories (forward)', async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd instanceof DescribeStackResourcesCommand) {
        if (cmd.input.StackName === GEN1_ROOT) {
          return { StackResources: [stackResource('storage-abc', 'gen1-storage-id')] };
        }
        return { StackResources: [stackResource('storage-xyz', 'gen2-storage-id')] };
      }
      return {};
    });

    const result = await discoverCategoryStacks(cfnClient, GEN1_ROOT, GEN2_ROOT, false);
    expect(result.get(NON_CUSTOM_RESOURCE_CATEGORY.STORAGE)).toEqual(['gen1-storage-id', 'gen2-storage-id']);
    expect(result.size).toBe(1);
  });

  it('should discover auth category (forward, non-user-pool-group)', async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd instanceof DescribeStackResourcesCommand) {
        if (cmd.input.StackName === GEN1_ROOT) {
          return { StackResources: [stackResource('auth-abc', 'gen1-auth-id')] };
        }
        return { StackResources: [stackResource('auth-xyz', 'gen2-auth-id')] };
      }
      if (cmd instanceof DescribeStacksCommand) {
        return describeStackResponse(JSON.stringify({ stackType: 'auth-Cognito' }));
      }
      return {};
    });

    const result = await discoverCategoryStacks(cfnClient, GEN1_ROOT, GEN2_ROOT, false);
    expect(result.get(NON_CUSTOM_RESOURCE_CATEGORY.AUTH)).toEqual(['gen1-auth-id', 'gen2-auth-id']);
    expect(result.has(NON_CUSTOM_RESOURCE_CATEGORY.AUTH_USER_POOL_GROUP)).toBe(false);
  });

  it('should discover auth-user-pool-group category (forward)', async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd instanceof DescribeStackResourcesCommand) {
        if (cmd.input.StackName === GEN1_ROOT) {
          return { StackResources: [stackResource('auth-groups', 'gen1-auth-groups-id')] };
        }
        return { StackResources: [stackResource('auth-xyz', 'gen2-auth-id')] };
      }
      if (cmd instanceof DescribeStacksCommand) {
        return describeStackResponse(JSON.stringify({ stackType: 'auth-Cognito-UserPool-Groups' }));
      }
      return {};
    });

    const result = await discoverCategoryStacks(cfnClient, GEN1_ROOT, GEN2_ROOT, false);
    expect(result.has(NON_CUSTOM_RESOURCE_CATEGORY.AUTH)).toBe(false);
    expect(result.get(NON_CUSTOM_RESOURCE_CATEGORY.AUTH_USER_POOL_GROUP)).toEqual(['gen1-auth-groups-id', 'gen2-auth-id']);
  });

  it('should split auth and auth-user-pool-group on rollback', async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd instanceof DescribeStackResourcesCommand) {
        if (cmd.input.StackName === GEN1_ROOT) {
          return { StackResources: [stackResource('auth-main', 'gen1-auth-id')] };
        }
        return {
          StackResources: [stackResource('auth-main', 'gen2-auth-id'), stackResource('auth-groups', 'gen2-groups-id')],
        };
      }
      if (cmd instanceof DescribeStacksCommand) {
        const stackName = cmd.input.StackName;
        if (stackName === 'gen2-groups-id') {
          return describeStackResponse(JSON.stringify({ stackType: 'auth-Cognito-UserPool-Groups' }));
        }
        return describeStackResponse(JSON.stringify({ stackType: 'auth-Cognito' }));
      }
      return {};
    });

    const result = await discoverCategoryStacks(cfnClient, GEN1_ROOT, GEN2_ROOT, true);
    expect(result.get(NON_CUSTOM_RESOURCE_CATEGORY.AUTH)).toEqual(['gen1-auth-id', 'gen2-auth-id']);
    expect(result.get(NON_CUSTOM_RESOURCE_CATEGORY.AUTH_USER_POOL_GROUP)).toEqual(['gen1-auth-id', 'gen2-groups-id']);
  });

  it('should handle invalid JSON in stack description gracefully', async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd instanceof DescribeStackResourcesCommand) {
        if (cmd.input.StackName === GEN1_ROOT) {
          return { StackResources: [stackResource('auth-abc', 'gen1-auth-id')] };
        }
        return { StackResources: [stackResource('auth-xyz', 'gen2-auth-id')] };
      }
      if (cmd instanceof DescribeStacksCommand) {
        return describeStackResponse('not valid json {{{');
      }
      return {};
    });

    const result = await discoverCategoryStacks(cfnClient, GEN1_ROOT, GEN2_ROOT, false);
    // Invalid JSON → getGen1AuthCategory returns null → not a user pool group → maps as auth
    expect(result.get(NON_CUSTOM_RESOURCE_CATEGORY.AUTH)).toEqual(['gen1-auth-id', 'gen2-auth-id']);
  });

  it('should handle description JSON with no stackType field', async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd instanceof DescribeStackResourcesCommand) {
        if (cmd.input.StackName === GEN1_ROOT) {
          return { StackResources: [stackResource('auth-abc', 'gen1-auth-id')] };
        }
        return { StackResources: [stackResource('auth-xyz', 'gen2-auth-id')] };
      }
      if (cmd instanceof DescribeStacksCommand) {
        return describeStackResponse(JSON.stringify({ someOtherField: 'value' }));
      }
      return {};
    });

    const result = await discoverCategoryStacks(cfnClient, GEN1_ROOT, GEN2_ROOT, false);
    expect(result.get(NON_CUSTOM_RESOURCE_CATEGORY.AUTH)).toEqual(['gen1-auth-id', 'gen2-auth-id']);
  });

  it('should skip non-category stacks', async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd instanceof DescribeStackResourcesCommand) {
        if (cmd.input.StackName === GEN1_ROOT) {
          return { StackResources: [stackResource('custom-lambda', 'gen1-custom'), stackResource('storage-s3', 'gen1-storage')] };
        }
        return { StackResources: [stackResource('storage-s3', 'gen2-storage')] };
      }
      return {};
    });

    const result = await discoverCategoryStacks(cfnClient, GEN1_ROOT, GEN2_ROOT, false);
    expect(result.size).toBe(1);
    expect(result.get(NON_CUSTOM_RESOURCE_CATEGORY.STORAGE)).toEqual(['gen1-storage', 'gen2-storage']);
  });

  it('should throw when source has no stack resources', async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd instanceof DescribeStackResourcesCommand) {
        if (cmd.input.StackName === GEN1_ROOT) return { StackResources: undefined };
        return { StackResources: [stackResource('storage-s3', 'gen2-storage')] };
      }
      return {};
    });

    await expect(discoverCategoryStacks(cfnClient, GEN1_ROOT, GEN2_ROOT, false)).rejects.toThrow('No source stack resources found');
  });

  it('should throw when source has no nested category stacks', async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd instanceof DescribeStackResourcesCommand) {
        if (cmd.input.StackName === GEN1_ROOT) return { StackResources: [nonStackResource('SomeBucket')] };
        return { StackResources: [stackResource('storage-s3', 'gen2-storage')] };
      }
      return {};
    });

    await expect(discoverCategoryStacks(cfnClient, GEN1_ROOT, GEN2_ROOT, false)).rejects.toThrow(
      'No nested category stacks found in source stack',
    );
  });

  it('should throw when destination has no matching category', async () => {
    mockSend.mockImplementation((cmd: any) => {
      if (cmd instanceof DescribeStackResourcesCommand) {
        if (cmd.input.StackName === GEN1_ROOT) return { StackResources: [stackResource('storage-s3', 'gen1-storage')] };
        return { StackResources: [stackResource('auth-xyz', 'gen2-auth')] };
      }
      return {};
    });

    await expect(discoverCategoryStacks(cfnClient, GEN1_ROOT, GEN2_ROOT, false)).rejects.toThrow(
      'No corresponding category found in destination stack for storage category',
    );
  });
});
