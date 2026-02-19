import './setup-jest';
import { TemplateGenerator } from '../../../../../commands/gen2-migration/refactor/generators/template-generator';
import CategoryTemplateGenerator from '../../../../../commands/gen2-migration/refactor/generators/category-template-generator';
import {
  CloudFormationClient,
  CreateStackRefactorCommand,
  DescribeStackRefactorCommand,
  DescribeStackResourcesCommand,
  DescribeStackResourcesOutput,
  DescribeStacksCommand,
  DescribeStacksCommandOutput,
  ExecuteStackRefactorCommand,
  StackRefactorExecutionStatus,
  StackRefactorStatus,
  StackStatus,
  UpdateStackCommand,
} from '@aws-sdk/client-cloudformation';
import fs from 'node:fs/promises';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import {
  CATEGORY,
  CFN_AUTH_TYPE,
  CFN_S3_TYPE,
  CFN_DYNAMODB_TYPE,
  CFN_IAM_TYPE,
  CFNTemplate,
} from '../../../../../commands/gen2-migration/refactor/types';

import assert from 'node:assert';
import { Logger } from '../../../../../commands/gen2-migration';

jest.useFakeTimers();

const mockCfnClientSendMock = jest.fn();
const mockGenerateGen1PreProcessTemplate = jest.fn();
const mockGenerateGen2ResourceRemovalTemplate = jest.fn();
const mockGenerateStackRefactorTemplates = jest.fn();
const mockGenerateRefactorTemplates = jest.fn();
const mockReadTemplate = jest.fn();
const mockDescribeStack = jest.fn();
const REGION = 'us-east-1';
const getStackId = (stackName: string, category: CATEGORY) => {
  // In Gen1, user pool group and auth are their own stacks. In Gen2, they are combined into 1.
  const resolvedCategory = stackName === GEN2_ROOT_STACK_NAME && category === 'auth-user-pool-group' ? 'auth' : category;
  return `arn:aws:cloudformation:${REGION}:${ACCOUNT_ID}:stack/${stackName}-${resolvedCategory}/12345`;
};

const NUM_CATEGORIES_TO_REFACTOR = 3;
const ACCOUNT_ID = 'TEST_ACCOUNT_ID';
const GEN1_ROOT_STACK_NAME = 'amplify-gen1-dev-12345';
const GEN2_ROOT_STACK_NAME = 'amplify-gen2-test-sandbox-12345';
const GEN1_AUTH_STACK_ID = getStackId(GEN1_ROOT_STACK_NAME, 'auth');
const GEN1_AUTH_USER_POOL_GROUP_STACK_ID = getStackId(GEN1_ROOT_STACK_NAME, 'auth-user-pool-group');
const GEN2_AUTH_STACK_ID = getStackId(GEN2_ROOT_STACK_NAME, 'auth');
const GEN1_STORAGE_STACK_ID = getStackId(GEN1_ROOT_STACK_NAME, 'storage');
const GEN2_STORAGE_STACK_ID = getStackId(GEN2_ROOT_STACK_NAME, 'storage');
const GEN1_S3_BUCKET_LOGICAL_ID = 'S3Bucket';
const GEN2_S3_BUCKET_LOGICAL_ID = 'Gen2S3Bucket';
const GEN1_DDB_TABLE_LOGICAL_ID = 'DynamoDBTable';
const GEN2_DDB_TABLE_LOGICAL_ID = 'Gen2DynamoDBTable';
const STUB_CFN_CLIENT = new CloudFormationClient();
const STUB_SSM_CLIENT = new SSMClient();
const STUB_COGNITO_IDP_CLIENT = new CognitoIdentityProviderClient();
const APP_ID = 'd123456';
const ENV_NAME = 'test';
const CDK_IDENTIFIER = '12345678';
const GEN2_AUTH_LOGICAL_ID_PREFIX = 'amplifyAuth';
const GEN2_AUTH_USER_POOL_LOGICAL_ID = `${GEN2_AUTH_LOGICAL_ID_PREFIX}Gen2UserPool${CDK_IDENTIFIER}`;
const GEN2_AUTH_IDENTITY_POOL_LOGICAL_ID = `${GEN2_AUTH_LOGICAL_ID_PREFIX}Gen2IdentityPool${CDK_IDENTIFIER}`;
const GEN2_AUTH_USER_POOL_CLIENT_WEB_LOGICAL_ID = `${GEN2_AUTH_LOGICAL_ID_PREFIX}UserPoolAppClient${CDK_IDENTIFIER}`;
const GEN2_AUTH_USER_POOL_CLIENT_NATIVE_LOGICAL_ID = `${GEN2_AUTH_LOGICAL_ID_PREFIX}UserPoolNativeAppClient${CDK_IDENTIFIER}`;
const GEN2_IDENTITY_POOL_ROLE_ATTACHMENT_LOGICAL_ID = `${GEN2_AUTH_LOGICAL_ID_PREFIX}IdentityPoolRoleAttachment${CDK_IDENTIFIER}`;
const GEN2_USER_POOL_GROUP_LOGICAL_ID = `${GEN2_AUTH_LOGICAL_ID_PREFIX}MyUserPoolGroup${CDK_IDENTIFIER}`;
const GEN2_USER_POOL_GROUP_NAME = 'MyUserPool';
const GEN2_USER_POOL_GROUP_ROLE_LOGICAL_ID = `${GEN2_AUTH_LOGICAL_ID_PREFIX}myUserPoolGroupRole${CDK_IDENTIFIER}`;
const GEN2_AUTH_ROLE_LOGICAL_ID = `${GEN2_AUTH_LOGICAL_ID_PREFIX}unauthenticatedUserRole${CDK_IDENTIFIER}`;
const GEN2_UNAUTH_ROLE_LOGICAL_ID = `${GEN2_AUTH_LOGICAL_ID_PREFIX}authenticatedUserRole${CDK_IDENTIFIER}`;
export const GEN1_USER_POOL_GROUPS_STACK_TYPE_DESCRIPTION = 'auth-Cognito-UserPool-Groups';
export const GEN1_AUTH_STACK_TYPE_DESCRIPTION = 'auth-Cognito';
const USER_POOL_PARAM_NAME = 'authUserPoolId';

const mockDescribeGen1StackResources: DescribeStackResourcesOutput = {
  StackResources: [
    {
      ResourceType: 'AWS::CloudFormation::Stack',
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: 'auth',
      PhysicalResourceId: GEN1_AUTH_STACK_ID,
      Timestamp: new Date(),
    },
    {
      ResourceType: 'AWS::CloudFormation::Stack',
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: 'authUserPoolGroup',
      PhysicalResourceId: GEN1_AUTH_USER_POOL_GROUP_STACK_ID,
      Timestamp: new Date(),
    },
    {
      ResourceType: 'AWS::CloudFormation::Stack',
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: 'storage',
      PhysicalResourceId: GEN1_STORAGE_STACK_ID,
      Timestamp: new Date(),
    },
    {
      ResourceType: 'AWS::S3::Bucket',
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: GEN1_S3_BUCKET_LOGICAL_ID,
      PhysicalResourceId: 'my-s3-bucket-gen1',
      Timestamp: new Date(),
    },
    {
      ResourceType: CFN_DYNAMODB_TYPE.Table,
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: GEN1_DDB_TABLE_LOGICAL_ID,
      PhysicalResourceId: 'my-ddb-table-gen1',
      Timestamp: new Date(),
    },
    {
      ResourceType: 'AWS::Cognito::UserPoolClient',
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: 'UserPoolClient',
      PhysicalResourceId: 'user-pool-client-id',
      Timestamp: new Date(),
    },
  ],
};

const mockDescribeGen2StackResources: DescribeStackResourcesOutput = {
  StackResources: [
    {
      ResourceType: 'AWS::CloudFormation::Stack',
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: 'auth',
      PhysicalResourceId: getStackId(GEN2_ROOT_STACK_NAME, 'auth'),
      Timestamp: new Date(),
    },
    {
      ResourceType: 'AWS::CloudFormation::Stack',
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: 'storage',
      PhysicalResourceId: getStackId(GEN2_ROOT_STACK_NAME, 'storage'),
      Timestamp: new Date(),
    },
    {
      ResourceType: 'AWS::S3::Bucket',
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: GEN2_S3_BUCKET_LOGICAL_ID,
      PhysicalResourceId: 'my-s3-bucket-gen2',
      Timestamp: new Date(),
    },
    {
      ResourceType: CFN_DYNAMODB_TYPE.Table,
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: GEN2_DDB_TABLE_LOGICAL_ID,
      PhysicalResourceId: 'my-ddb-table-gen2',
      Timestamp: new Date(),
    },
  ],
};

const mockDescribeGen2AuthStackResources: DescribeStackResourcesOutput = {
  StackResources: [
    {
      ResourceType: CFN_IAM_TYPE.Role,
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: GEN2_AUTH_ROLE_LOGICAL_ID,
      PhysicalResourceId: `authRole`,
      Timestamp: new Date(),
    },
    {
      ResourceType: CFN_IAM_TYPE.Role,
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: GEN2_UNAUTH_ROLE_LOGICAL_ID,
      PhysicalResourceId: 'unAuthRole',
      Timestamp: new Date(),
    },
    {
      ResourceType: CFN_IAM_TYPE.Role,
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: GEN2_USER_POOL_GROUP_ROLE_LOGICAL_ID,
      PhysicalResourceId: 'myGroupRole',
      Timestamp: new Date(),
    },
  ],
};

const mockDescribeGen2StorageStackResources: DescribeStackResourcesOutput = {
  StackResources: [
    {
      ResourceType: CFN_S3_TYPE.Bucket,
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: GEN2_S3_BUCKET_LOGICAL_ID,
      PhysicalResourceId: `myGen1BucketAfterRefactor`,
      Timestamp: new Date(),
    },
    {
      ResourceType: CFN_DYNAMODB_TYPE.Table,
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: GEN2_DDB_TABLE_LOGICAL_ID,
      PhysicalResourceId: `myGen1DDBTableAfterRefactor`,
      Timestamp: new Date(),
    },
  ],
};

const mockDescribeGen1AuthStackResources: DescribeStackResourcesOutput = {
  StackResources: [
    {
      ResourceType: CFN_AUTH_TYPE.UserPool,
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: `UserPool`,
      PhysicalResourceId: `userPoolId`,
      Timestamp: new Date(),
    },
  ],
};

const mockDescribeGen1AuthUserPoolGroupStackResources: DescribeStackResourcesOutput = {
  StackResources: [
    {
      ResourceType: CFN_AUTH_TYPE.UserPoolGroup,
      ResourceStatus: 'CREATE_COMPLETE',
      LogicalResourceId: GEN2_USER_POOL_GROUP_LOGICAL_ID,
      PhysicalResourceId: GEN2_USER_POOL_GROUP_NAME,
      Timestamp: new Date(),
    },
  ],
};

jest.mock('@aws-sdk/client-cloudformation', () => {
  return {
    ...jest.requireActual('@aws-sdk/client-cloudformation'),
    CloudFormationClient: function () {
      return {
        config: {
          region: () => REGION,
        },
        send: mockCfnClientSendMock,
      };
    },
  };
});

jest.mock('node:fs/promises');
const stubReadTemplate: CFNTemplate = {
  AWSTemplateFormatVersion: 'AWSTemplateFormatVersion',
  Description: 'Gen2 template',
  Parameters: {
    [USER_POOL_PARAM_NAME]: {
      Type: 'String',
      Description: 'Cognito User Pool ID',
    },
  },
  Resources: {
    [GEN2_AUTH_USER_POOL_LOGICAL_ID]: {
      Type: CFN_AUTH_TYPE.UserPool,
      Properties: {
        UserPoolName: { 'Fn::Join': ['-', 'my-user-pool', 'dev'] },
        UserPoolId: { Ref: 'authUserPoolId' },
      },
    },
    [GEN2_AUTH_IDENTITY_POOL_LOGICAL_ID]: {
      Type: CFN_AUTH_TYPE.IdentityPool,
      Properties: {
        IdentityPoolName: { 'Fn::Join': ['-', 'my-identity-pool', 'dev'] },
      },
    },
    [GEN2_AUTH_USER_POOL_CLIENT_WEB_LOGICAL_ID]: {
      Type: CFN_AUTH_TYPE.UserPoolClient,
      Properties: {
        ClientName: 'WebClient',
      },
    },
    [GEN2_AUTH_USER_POOL_CLIENT_NATIVE_LOGICAL_ID]: {
      Type: CFN_AUTH_TYPE.UserPoolClient,
      Properties: {
        ClientName: 'NativeClient',
      },
    },
    [GEN2_IDENTITY_POOL_ROLE_ATTACHMENT_LOGICAL_ID]: {
      Type: CFN_AUTH_TYPE.IdentityPoolRoleAttachment,
      Properties: {
        IdentityPoolId: { Ref: GEN2_AUTH_IDENTITY_POOL_LOGICAL_ID },
        Roles: {
          authenticated: { 'Fn::GetAtt': [GEN2_AUTH_ROLE_LOGICAL_ID, 'Arn'] },
          unauthenticated: { 'Fn::GetAtt': [GEN2_UNAUTH_ROLE_LOGICAL_ID, 'Arn'] },
        },
      },
    },
    [GEN2_USER_POOL_GROUP_LOGICAL_ID]: {
      Type: CFN_AUTH_TYPE.UserPoolGroup,
      Properties: {
        GroupName: GEN2_USER_POOL_GROUP_NAME,
        RoleArn: {
          'Fn::GetAtt': [GEN2_USER_POOL_GROUP_ROLE_LOGICAL_ID, 'Arn'],
        },
      },
    },
    [GEN2_S3_BUCKET_LOGICAL_ID]: {
      Properties: {
        BucketName: 'S3BucketName',
      },
      Type: CFN_S3_TYPE.Bucket,
    },
    [GEN2_DDB_TABLE_LOGICAL_ID]: {
      Properties: {
        TableName: 'DynamoDBTableName',
      },
      Type: CFN_DYNAMODB_TYPE.Table,
    },
  },
  Outputs: {
    [GEN2_AUTH_USER_POOL_LOGICAL_ID]: {
      Value: { Ref: GEN2_AUTH_USER_POOL_LOGICAL_ID },
    },
    [GEN2_AUTH_IDENTITY_POOL_LOGICAL_ID]: {
      Value: { Ref: GEN2_AUTH_IDENTITY_POOL_LOGICAL_ID },
    },
    [GEN2_AUTH_USER_POOL_CLIENT_WEB_LOGICAL_ID]: {
      Value: { Ref: GEN2_AUTH_USER_POOL_CLIENT_WEB_LOGICAL_ID },
    },
    [GEN2_AUTH_USER_POOL_CLIENT_NATIVE_LOGICAL_ID]: {
      Value: { Ref: GEN2_AUTH_USER_POOL_CLIENT_NATIVE_LOGICAL_ID },
    },
  },
};
const stubCategoryTemplateGenerator = {
  generateGen1PreProcessTemplate: mockGenerateGen1PreProcessTemplate.mockReturnValue({
    oldTemplate: {},
    newTemplate: {},
    parameters: [],
  }),
  generateGen2ResourceRemovalTemplate: mockGenerateGen2ResourceRemovalTemplate.mockReturnValue({
    oldTemplate: {},
    newTemplate: {},
    parameters: [],
  }),
  generateStackRefactorTemplates: mockGenerateStackRefactorTemplates.mockReturnValue({
    sourceTemplate: {},
    destinationTemplate: {},
    logicalIdMapping: new Map([['ResourceA', 'ResourceB']]),
  }),
  generateRefactorTemplates: mockGenerateRefactorTemplates.mockReturnValue({
    sourceTemplate: {},
    destinationTemplate: {},
    logicalIdMapping: new Map([['ResourceA', 'ResourceB']]),
  }),
  readTemplate: mockReadTemplate.mockReturnValue(stubReadTemplate),
  describeStack: mockDescribeStack.mockReturnValue({
    Outputs: [
      {
        OutputKey: GEN2_AUTH_USER_POOL_LOGICAL_ID,
        OutputValue: 'user-pool-id',
      },
      {
        OutputKey: GEN2_AUTH_IDENTITY_POOL_LOGICAL_ID,
        OutputValue: 'identity-pool-id',
      },
      {
        OutputKey: GEN2_AUTH_USER_POOL_CLIENT_WEB_LOGICAL_ID,
        OutputValue: 'web-client-id',
      },
      {
        OutputKey: GEN2_AUTH_USER_POOL_CLIENT_NATIVE_LOGICAL_ID,
        OutputValue: 'native-client-id',
      },
    ],
    Parameters: [
      {
        ParameterKey: USER_POOL_PARAM_NAME,
        ParameterValue: 'user-pool-id',
      },
    ],
  }),
};
jest.mock('../../../../../commands/gen2-migration/refactor/generators/category-template-generator', () => {
  return jest.fn().mockImplementation(() => {
    return stubCategoryTemplateGenerator;
  });
});

const describeStackResourcesResponse = (stackName: string | undefined) => {
  assert(stackName);
  switch (stackName) {
    case GEN1_ROOT_STACK_NAME:
      return Promise.resolve(mockDescribeGen1StackResources);
    case GEN2_ROOT_STACK_NAME:
      return Promise.resolve(mockDescribeGen2StackResources);
    case GEN1_AUTH_STACK_ID:
      return Promise.resolve(mockDescribeGen1AuthStackResources);
    case GEN2_AUTH_STACK_ID:
      return Promise.resolve(mockDescribeGen2AuthStackResources);
    case GEN1_AUTH_USER_POOL_GROUP_STACK_ID:
      return Promise.resolve(mockDescribeGen1AuthUserPoolGroupStackResources);
    case GEN2_STORAGE_STACK_ID:
      return Promise.resolve(mockDescribeGen2StorageStackResources);
    default:
      throw new Error(`Unexpected stack: ${stackName}`);
  }
};

const describeStacksResponse = (stackName: string | undefined, stackStatus: StackStatus = 'UPDATE_COMPLETE') => {
  assert(stackName);
  const defaultResponse: DescribeStacksCommandOutput = {
    Stacks: [
      {
        StackStatus: stackStatus,
        StackName: stackName,
        CreationTime: new Date(),
      },
    ],
    $metadata: {},
  };
  assert(defaultResponse.Stacks?.[0]);
  switch (stackName) {
    case GEN1_AUTH_STACK_ID: {
      defaultResponse.Stacks[0].Description = JSON.stringify({
        stackType: GEN1_AUTH_STACK_TYPE_DESCRIPTION,
      });
      return Promise.resolve(defaultResponse);
    }
    case GEN1_AUTH_USER_POOL_GROUP_STACK_ID:
      defaultResponse.Stacks[0].Description = JSON.stringify({
        stackType: GEN1_USER_POOL_GROUPS_STACK_TYPE_DESCRIPTION,
      });
      return Promise.resolve(defaultResponse);
    default:
      return Promise.resolve(defaultResponse);
  }
};

describe('TemplateGenerator', () => {
  beforeEach(() => {
    mockCfnClientSendMock.mockImplementation((command) => {
      if (command instanceof DescribeStackResourcesCommand) {
        return describeStackResourcesResponse(command.input.StackName);
      }
      if (command instanceof UpdateStackCommand) {
        return Promise.resolve({});
      }
      if (command instanceof DescribeStacksCommand) {
        return describeStacksResponse(command.input.StackName);
      }
      if (command instanceof CreateStackRefactorCommand) {
        return Promise.resolve({
          StackRefactorId: '12345',
        });
      }
      if (command instanceof DescribeStackRefactorCommand) {
        return Promise.resolve({
          Status: StackRefactorStatus.CREATE_COMPLETE,
          ExecutionStatus: StackRefactorExecutionStatus.EXECUTE_COMPLETE,
        });
      }
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // --- generateSelectedCategories tests ---

  it('should refactor selected categories from Gen1 to Gen2 successfully', async () => {
    const generator = new TemplateGenerator(
      GEN1_ROOT_STACK_NAME,
      GEN2_ROOT_STACK_NAME,
      ACCOUNT_ID,
      STUB_CFN_CLIENT,
      STUB_SSM_CLIENT,
      STUB_COGNITO_IDP_CLIENT,
      APP_ID,
      ENV_NAME,
      new Logger('mock', 'mock', 'mock'),
      REGION,
    );
    await generator.initializeForAssessment();
    const result = await generator.generateSelectedCategories(['auth', 'auth-user-pool-group', 'storage']);

    expect(result).toBe(true);
    expect(fs.mkdir).toBeCalledTimes(1);
    expect(mockGenerateGen1PreProcessTemplate).toBeCalledTimes(NUM_CATEGORIES_TO_REFACTOR);
    expect(mockGenerateGen2ResourceRemovalTemplate).toBeCalledTimes(NUM_CATEGORIES_TO_REFACTOR);
    expect(mockGenerateStackRefactorTemplates).toBeCalledTimes(NUM_CATEGORIES_TO_REFACTOR);
  });

  it('should skip categories that have already been refactored when using generateSelectedCategories', async () => {
    mockGenerateGen1PreProcessTemplate.mockImplementationOnce(() => {
      throw new Error('No resources to move in Gen1 stack');
    });
    const generator = new TemplateGenerator(
      GEN1_ROOT_STACK_NAME,
      GEN2_ROOT_STACK_NAME,
      ACCOUNT_ID,
      STUB_CFN_CLIENT,
      STUB_SSM_CLIENT,
      STUB_COGNITO_IDP_CLIENT,
      APP_ID,
      ENV_NAME,
      new Logger('mock', 'mock', 'mock'),
      REGION,
    );
    await generator.initializeForAssessment();
    const result = await generator.generateSelectedCategories(['auth', 'auth-user-pool-group', 'storage']);

    expect(result).toBe(true);
    expect(mockGenerateGen1PreProcessTemplate).toBeCalledTimes(NUM_CATEGORIES_TO_REFACTOR);
    // One category skipped, so gen2 removal and refactor called one fewer time
    expect(mockGenerateGen2ResourceRemovalTemplate).toBeCalledTimes(NUM_CATEGORIES_TO_REFACTOR - 1);
    expect(mockGenerateStackRefactorTemplates).toBeCalledTimes(NUM_CATEGORIES_TO_REFACTOR - 1);
  });

  it('should throw when no applicable destination category exists during initializeForAssessment', async () => {
    const mockDescribeGen2StackResourcesWithStorageMissing: DescribeStackResourcesOutput = {
      StackResources: [
        {
          ResourceType: 'AWS::CloudFormation::Stack',
          ResourceStatus: 'CREATE_COMPLETE',
          LogicalResourceId: 'auth',
          PhysicalResourceId: GEN2_AUTH_STACK_ID,
          Timestamp: new Date(),
        },
      ],
    };
    const failureSendMock = (command: any) => {
      if (command instanceof DescribeStackResourcesCommand) {
        return Promise.resolve(
          command.input.StackName === GEN1_ROOT_STACK_NAME
            ? mockDescribeGen1StackResources
            : mockDescribeGen2StackResourcesWithStorageMissing,
        );
      }
      if (command instanceof DescribeStacksCommand) {
        return describeStacksResponse(command.input.StackName);
      }
      return Promise.resolve({});
    };
    mockCfnClientSendMock.mockImplementation(failureSendMock);

    const generator = new TemplateGenerator(
      GEN1_ROOT_STACK_NAME,
      GEN2_ROOT_STACK_NAME,
      ACCOUNT_ID,
      STUB_CFN_CLIENT,
      STUB_SSM_CLIENT,
      STUB_COGNITO_IDP_CLIENT,
      APP_ID,
      ENV_NAME,
      new Logger('mock', 'mock', 'mock'),
      REGION,
    );
    await expect(generator.initializeForAssessment()).rejects.toThrow(
      'No corresponding category found in destination stack for storage category',
    );
  });

  it('should return false and rollback gen2 stack when stack refactor fails', async () => {
    mockCfnClientSendMock.mockImplementation((command) => {
      if (command instanceof DescribeStackResourcesCommand) {
        return describeStackResourcesResponse(command.input.StackName);
      }
      if (command instanceof UpdateStackCommand) {
        return Promise.resolve({});
      }
      if (command instanceof DescribeStacksCommand) {
        return describeStacksResponse(command.input.StackName);
      }
      if (command instanceof CreateStackRefactorCommand) {
        return Promise.resolve({ StackRefactorId: '12345' });
      }
      if (command instanceof DescribeStackRefactorCommand) {
        return Promise.resolve({
          Status: StackRefactorStatus.CREATE_FAILED,
          StatusReason: 'Update operations not permitted in refactor',
        });
      }
      return Promise.resolve({});
    });

    const generator = new TemplateGenerator(
      GEN1_ROOT_STACK_NAME,
      GEN2_ROOT_STACK_NAME,
      ACCOUNT_ID,
      STUB_CFN_CLIENT,
      STUB_SSM_CLIENT,
      STUB_COGNITO_IDP_CLIENT,
      APP_ID,
      ENV_NAME,
      new Logger('mock', 'mock', 'mock'),
      REGION,
    );
    await generator.initializeForAssessment();
    const result = await generator.generateSelectedCategories(['auth', 'auth-user-pool-group', 'storage']);

    expect(result).toBe(false);
  });

  // --- rollback tests ---

  it('should rollback resources from Gen2 to Gen1 successfully', async () => {
    // Act
    const generator = new TemplateGenerator(
      GEN2_ROOT_STACK_NAME,
      GEN1_ROOT_STACK_NAME,
      ACCOUNT_ID,
      STUB_CFN_CLIENT,
      STUB_SSM_CLIENT,
      STUB_COGNITO_IDP_CLIENT,
      APP_ID,
      ENV_NAME,
      new Logger('mock', 'mock', 'mock'),
      REGION,
    );
    await generator.rollback();

    // Assert
    successfulRollbackAssertions();
    // 2 describe stack resources call for each root stack (Gen1, Gen2)
    // 2 describe stacks call for Gen 1 auth related stacks (auth, user pool groups)
    // 1 describe stack resources call for Gen2 auth stack to get physical ids for auth roles
    let callIndex = assertStackRefactorCommands('auth', 5, false, false, true);
    // 1 describe stack resources call for Gen2 auth stack to get physical ids for user group roles
    // 1 describe stack resources call for Gen2 storage stack to get physical ids for user group roles
    callIndex = assertStackRefactorCommands('auth-user-pool-group', callIndex + 2, false, false, true);
    assertStackRefactorCommands('storage', callIndex + 2, false, false, true);
  });

  it('should rollback resources from Gen2 to Gen1 successfully, skipping categories that have already been updated previously', async () => {
    const clonedStubGetTemplate = JSON.parse(JSON.stringify(stubReadTemplate));
    delete clonedStubGetTemplate.Resources[GEN2_S3_BUCKET_LOGICAL_ID];
    delete clonedStubGetTemplate.Resources[GEN2_DDB_TABLE_LOGICAL_ID];
    mockReadTemplate.mockReturnValue(clonedStubGetTemplate);
    // Act
    const generator = new TemplateGenerator(
      GEN2_ROOT_STACK_NAME,
      GEN1_ROOT_STACK_NAME,
      ACCOUNT_ID,
      STUB_CFN_CLIENT,
      STUB_SSM_CLIENT,
      STUB_COGNITO_IDP_CLIENT,
      APP_ID,
      ENV_NAME,
      new Logger('mock', 'mock', 'mock'),
      REGION,
    );
    await generator.rollback();

    // Assert
    successfulRollbackAssertions(1);
    // 2 describe stack resources call for each root stack (Gen1, Gen2)
    // 2 describe stacks call for Gen 1 auth related stacks (auth, user pool groups)
    // 1 describe stack resources call for Gen2 auth stack to get physical ids for auth roles
    const callIndex = assertStackRefactorCommands('auth', 5, false, false, true);
    assertStackRefactorCommands('auth-user-pool-group', callIndex + 2, false, false, true);
  });

  function successfulRollbackAssertions(numCategoriesToSkipUpdate = 0) {
    expect(fs.mkdir).not.toBeCalled();
    expect(mockGenerateGen1PreProcessTemplate).not.toBeCalled();
    expect(mockGenerateGen2ResourceRemovalTemplate).not.toBeCalled();
    expect(mockGenerateRefactorTemplates).toBeCalledTimes(NUM_CATEGORIES_TO_REFACTOR - numCategoriesToSkipUpdate);
    expect(CategoryTemplateGenerator).toBeCalledTimes(NUM_CATEGORIES_TO_REFACTOR);
    expect(CategoryTemplateGenerator).toHaveBeenNthCalledWith(
      1,
      new Logger('mock', 'mock', 'mock'),
      GEN2_AUTH_STACK_ID,
      GEN1_AUTH_STACK_ID,
      REGION,
      ACCOUNT_ID,
      STUB_CFN_CLIENT,
      STUB_SSM_CLIENT,
      STUB_COGNITO_IDP_CLIENT,
      APP_ID,
      ENV_NAME,
      [
        CFN_AUTH_TYPE.UserPool,
        CFN_AUTH_TYPE.UserPoolClient,
        CFN_AUTH_TYPE.IdentityPool,
        CFN_AUTH_TYPE.IdentityPoolRoleAttachment,
        CFN_AUTH_TYPE.UserPoolDomain,
      ],
      undefined,
    );
    expect(CategoryTemplateGenerator).toHaveBeenNthCalledWith(
      2,
      new Logger('mock', 'mock', 'mock'),
      GEN2_AUTH_STACK_ID,
      GEN1_AUTH_USER_POOL_GROUP_STACK_ID,
      REGION,
      ACCOUNT_ID,
      STUB_CFN_CLIENT,
      STUB_SSM_CLIENT,
      STUB_COGNITO_IDP_CLIENT,
      APP_ID,
      ENV_NAME,
      [CFN_AUTH_TYPE.UserPoolGroup],
      undefined,
    );
    expect(CategoryTemplateGenerator).toHaveBeenNthCalledWith(
      3,
      new Logger('mock', 'mock', 'mock'),
      GEN2_STORAGE_STACK_ID,
      GEN1_STORAGE_STACK_ID,
      REGION,
      ACCOUNT_ID,
      STUB_CFN_CLIENT,
      STUB_SSM_CLIENT,
      STUB_COGNITO_IDP_CLIENT,
      APP_ID,
      ENV_NAME,
      [CFN_S3_TYPE.Bucket, CFN_DYNAMODB_TYPE.Table],
      undefined,
    );
  }

  function assertStackRefactorCommands(
    category: CATEGORY,
    callIndex: number,
    onCreateRefactorFailed = false,
    onExecuteRefactorFailed = false,
    isRevert = false,
  ) {
    const sourceStackName = isRevert ? getStackId(GEN2_ROOT_STACK_NAME, category) : getStackId(GEN1_ROOT_STACK_NAME, category);
    const destinationStackName = isRevert ? getStackId(GEN1_ROOT_STACK_NAME, category) : getStackId(GEN2_ROOT_STACK_NAME, category);
    expect(mockCfnClientSendMock.mock.calls[callIndex]).toBeACloudFormationCommand(
      {
        ResourceMappings: [
          {
            Source: {
              LogicalResourceId: 'ResourceA',
              StackName: sourceStackName,
            },
            Destination: {
              LogicalResourceId: 'ResourceB',
              StackName: destinationStackName,
            },
          },
        ],
        StackDefinitions: [
          {
            TemplateBody: `{}`,
            StackName: sourceStackName,
          },
          {
            TemplateBody: `{}`,
            StackName: destinationStackName,
          },
        ],
      },
      CreateStackRefactorCommand,
    );
    expect(mockCfnClientSendMock.mock.calls[++callIndex]).toBeACloudFormationCommand(
      {
        StackRefactorId: '12345',
      },
      DescribeStackRefactorCommand,
    );
    if (!onCreateRefactorFailed) {
      expect(mockCfnClientSendMock.mock.calls[++callIndex]).toBeACloudFormationCommand(
        {
          StackRefactorId: '12345',
        },
        ExecuteStackRefactorCommand,
      );
      expect(mockCfnClientSendMock.mock.calls[++callIndex]).toBeACloudFormationCommand(
        {
          StackRefactorId: '12345',
        },
        DescribeStackRefactorCommand,
      );
      if (!onExecuteRefactorFailed) {
        expect(mockCfnClientSendMock.mock.calls[++callIndex]).toBeACloudFormationCommand(
          {
            StackName: sourceStackName,
          },
          DescribeStacksCommand,
        );
        expect(mockCfnClientSendMock.mock.calls[++callIndex]).toBeACloudFormationCommand(
          {
            StackName: destinationStackName,
          },
          DescribeStacksCommand,
        );
      }
    }
    return callIndex;
  }
});
