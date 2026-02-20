import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  Parameter,
} from '@aws-sdk/client-cloudformation';
import CategoryTemplateGenerator from './category-template-generator';
import fs from 'node:fs/promises';
import {
  CATEGORY,
  NON_CUSTOM_RESOURCE_CATEGORY,
  CFN_AUTH_TYPE,
  CFN_CATEGORY_TYPE,
  CFN_RESOURCE_TYPES,
  CFN_S3_TYPE,
  CFN_DYNAMODB_TYPE,
  CFNResource,
  CFNStackStatus,
  CFNTemplate,
  ResourceMapping,
  CFN_ANALYTICS_TYPE,
  NoResourcesError,
  CategoryRefactorResult,
} from '../types';
import { pollStackForCompletionState, tryUpdateStack } from '../cfn-stack-updater';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { tryRefactorStack } from '../cfn-stack-refactor-updater';
import CfnOutputResolver from '../resolvers/cfn-output-resolver';
import CfnDependencyResolver from '../resolvers/cfn-dependency-resolver';
import CfnParameterResolver from '../resolvers/cfn-parameter-resolver';
import { Logger } from '../../../gen2-migration';
import { AmplifyError } from '@aws-amplify/amplify-cli-core';

const CFN_RESOURCE_STACK_TYPE = 'AWS::CloudFormation::Stack';
const GEN2_AMPLIFY_AUTH_LOGICAL_ID_PREFIX = 'amplifyAuth';
const CDK_HASH_LENGTH = 8;

const CATEGORIES: CATEGORY[] = ['auth', 'storage', 'analytics'];
const TEMPLATES_DIR = '.amplify/migration/templates';

const GEN1 = 'Gen 1';
const GEN2 = 'Gen 2';
const AUTH_RESOURCES_TO_REFACTOR = [
  CFN_AUTH_TYPE.UserPool,
  CFN_AUTH_TYPE.UserPoolClient,
  CFN_AUTH_TYPE.IdentityPool,
  CFN_AUTH_TYPE.IdentityPoolRoleAttachment,
  CFN_AUTH_TYPE.UserPoolDomain,
];
const AUTH_USER_POOL_GROUP_RESOURCES_TO_REFACTOR = [CFN_AUTH_TYPE.UserPoolGroup];
const STORAGE_RESOURCES_TO_REFACTOR = [CFN_S3_TYPE.Bucket, CFN_DYNAMODB_TYPE.Table];
const ANALYTICS_RESOURCES_TO_REFACTOR = [CFN_ANALYTICS_TYPE.Stream];

// The following is only used for rollback operation
const GEN1_RESOURCE_TYPE_TO_LOGICAL_RESOURCE_IDS_MAP = new Map<string, string>([
  [CFN_AUTH_TYPE.UserPool.valueOf(), 'UserPool'],
  [CFN_AUTH_TYPE.UserPoolClient.valueOf(), 'UserPoolClientWeb'],
  [CFN_AUTH_TYPE.IdentityPool.valueOf(), 'IdentityPool'],
  [CFN_AUTH_TYPE.IdentityPoolRoleAttachment.valueOf(), 'IdentityPoolRoleMap'],
  [CFN_AUTH_TYPE.UserPoolDomain.valueOf(), 'UserPoolDomain'],
  [CFN_S3_TYPE.Bucket.valueOf(), 'S3Bucket'],
  [CFN_DYNAMODB_TYPE.Table.valueOf(), 'DynamoDBTable'],
  [CFN_ANALYTICS_TYPE.Stream.valueOf(), 'KinesisStream'],
]);
const LOGICAL_IDS_TO_REMOVE_FOR_ROLLBACK_MAP = new Map<CATEGORY, CFN_RESOURCE_TYPES[]>([
  ['auth', AUTH_RESOURCES_TO_REFACTOR],
  ['auth-user-pool-group', AUTH_USER_POOL_GROUP_RESOURCES_TO_REFACTOR],
  ['storage', [CFN_S3_TYPE.Bucket, CFN_DYNAMODB_TYPE.Table]],
  ['analytics', ANALYTICS_RESOURCES_TO_REFACTOR],
]);
const GEN2_NATIVE_APP_CLIENT = 'UserPoolNativeAppClient';
const GEN1_USER_POOL_GROUPS_STACK_TYPE_DESCRIPTION = 'auth-Cognito-UserPool-Groups';
const GEN1_AUTH_STACK_TYPE_DESCRIPTION = 'auth-Cognito';

/**
 * Orchestrates CloudFormation stack refactoring between Gen1 and Gen2 stacks.
 *
 * This class follows a pipeline pattern: discover → assess → generate → execute → rollback.
 * If it crosses 1000 lines or gains methods outside this pipeline flow, revisit decomposition.
 * See git history for the analysis that deferred the split (KIRO-refactor branch).
 */
class TemplateGenerator {
  private _categoryStackMap: Map<CATEGORY, [string, string]>;
  private readonly categoryTemplateGenerators: [CATEGORY, string, string, CategoryTemplateGenerator<CFN_CATEGORY_TYPE>][];
  private readonly _cfnClient: CloudFormationClient;
  private readonly categoryGeneratorConfig = {
    auth: {
      resourcesToRefactor: AUTH_RESOURCES_TO_REFACTOR,
    },
    'auth-user-pool-group': {
      resourcesToRefactor: AUTH_USER_POOL_GROUP_RESOURCES_TO_REFACTOR,
    },
    storage: {
      resourcesToRefactor: STORAGE_RESOURCES_TO_REFACTOR,
    },
    analytics: {
      resourcesToRefactor: ANALYTICS_RESOURCES_TO_REFACTOR,
    },
  } as const;

  constructor(
    private readonly fromStack: string,
    private readonly toStack: string,
    private readonly accountId: string,
    cfnClient: CloudFormationClient,
    private readonly ssmClient: SSMClient,
    private readonly cognitoIdpClient: CognitoIdentityProviderClient,
    private readonly appId: string,
    private readonly environmentName: string,
    private readonly logger: Logger,
    private readonly region: string,
  ) {
    this._categoryStackMap = new Map<CATEGORY, [string, string]>();
    this.categoryTemplateGenerators = [];
    this._cfnClient = cfnClient;
  }

  // Public getter for categoryStackMap
  public get categoryStackMap() {
    return this._categoryStackMap;
  }

  private set categoryStackMap(value: Map<CATEGORY, [string, string]>) {
    this._categoryStackMap = value;
  }

  // Public getter for cfnClient
  public get cfnClient() {
    return this._cfnClient;
  }

  // Initialize for assessment - parse category stacks without generating templates
  public async initializeForAssessment(): Promise<void> {
    await this.parseCategoryStacks();
  }

  // Get stack template for a given stack ID
  public async getStackTemplate(stackId: string): Promise<CFNTemplate | undefined> {
    try {
      const { TemplateBody } = await this.cfnClient.send(
        new GetTemplateCommand({
          StackName: stackId,
        }),
      );
      if (!TemplateBody) return undefined;
      return JSON.parse(TemplateBody);
    } catch (error) {
      return undefined;
    }
  }

  // Get resources to migrate for a given category
  public getResourcesToMigrate(template: CFNTemplate, category: string): string[] {
    if (!template.Resources) return [];

    const config = this.categoryGeneratorConfig[category as keyof typeof this.categoryGeneratorConfig];
    if (!config) return [];

    const resourcesToRefactor = config.resourcesToRefactor;
    return Object.entries(template.Resources)
      .filter(([, resource]) => resourcesToRefactor.some((type) => type.valueOf() === resource.Type))
      .map(([logicalId]) => logicalId);
  }

  // Generate templates for selected categories only (Entry point for refactor)
  public async generateSelectedCategories(selectedCategories: string[], customResourceMap?: ResourceMapping[]): Promise<boolean> {
    await fs.mkdir(TEMPLATES_DIR, { recursive: true });

    // Filter categoryStackMap to only include selected categories
    const filteredCategoryStackMap = new Map<CATEGORY, [string, string]>();
    for (const [category, stacks] of this._categoryStackMap.entries()) {
      if (selectedCategories.includes(category)) {
        filteredCategoryStackMap.set(category, stacks);
      }
    }

    // Temporarily replace categoryStackMap with filtered version
    const originalCategoryStackMap = this._categoryStackMap;
    this._categoryStackMap = filteredCategoryStackMap;

    try {
      const result = await this.generateCategoryTemplates(false, customResourceMap);
      return result;
    } finally {
      // Restore original categoryStackMap
      this._categoryStackMap = originalCategoryStackMap;
    }
  }

  public async rollback() {
    await this.parseCategoryStacks(true);
    return await this.generateCategoryTemplates(true);
  }

  /**
   * Discovers and maps category nested stacks between Gen1 and Gen2 root stacks.
   *
   * Queries both Gen1 (source) and Gen2 (destination) root stacks for their nested stacks
   * Matches nested stacks by category (e.g., Gen1's "authXYZ" → Gen2's "authABC")
   * Populates _categoryStackMap with: category → [sourceStackId, destinationStackId]
   *
   *
   * Special handling for auth: Gen1 may have separate stacks for UserPool vs UserPoolGroups,
   * while Gen2 combines them into one stack. The code detects this via stack description metadata.
   *
   * @param isRollback - If true, we're moving resources FROM Gen2 back TO Gen1 (reverse of migration)
   */
  private async parseCategoryStacks(isRollback = false): Promise<void> {
    const sourceStackResourcesResponse = await this.cfnClient.send(
      new DescribeStackResourcesCommand({
        StackName: this.fromStack,
      }),
    );
    const destStackResourcesResponse = await this.cfnClient.send(
      new DescribeStackResourcesCommand({
        StackName: this.toStack,
      }),
    );

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

    // Filter to only nested stacks (AWS::CloudFormation::Stack) to retrieve category stacks
    const sourceCategoryStacks = sourceStackResources.filter((stackResource) => stackResource.ResourceType === CFN_RESOURCE_STACK_TYPE);
    const destinationCategoryStacks = destStackResources.filter((stackResource) => stackResource.ResourceType === CFN_RESOURCE_STACK_TYPE);
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
      // Check if this stack's logical ID starts with a known category name (e.g., "authXYZ123", "storageDEF456")
      const category = CATEGORIES.find((category) => sourceLogicalResourceId?.startsWith(category));
      if (!category) continue;

      if (!sourcePhysicalResourceId) {
        throw new AmplifyError('InvalidStackError', {
          message: `Source category stack '${sourceLogicalResourceId}' does not have a physical resource ID`,
          resolution: 'Ensure the stack is in a stable state before running the migration.',
        });
      }
      let destinationPhysicalResourceId: string | undefined;
      let userPoolGroupDestinationPhysicalResourceId: string | undefined;

      // find the corresponding category stack in Gen2 stack
      const correspondingCategoryStackInDestination = destinationCategoryStacks.find(
        ({ LogicalResourceId: destinationLogicalResourceId }) => destinationLogicalResourceId?.startsWith(category),
      );
      if (!correspondingCategoryStackInDestination) {
        throw new AmplifyError('StackStateError', {
          message: `No corresponding category found in destination stack for ${category} category`,
          resolution: 'Ensure your Gen2 stack has the corresponding category resources deployed before running the migration.',
        });
      }
      destinationPhysicalResourceId = correspondingCategoryStackInDestination.PhysicalResourceId;

      // Gen1 can have TWO auth stacks (UserPool/IdentityPool + UserPoolGroups), Gen2 combines them
      let isUserPoolGroupStack = false;

      if (!isRollback && category === 'auth') {
        // Forward migration: check if this Gen1 auth stack is specifically for UserPoolGroups
        const gen1AuthTypeStack = await this.getGen1AuthCategory(sourcePhysicalResourceId);
        isUserPoolGroupStack = gen1AuthTypeStack === 'auth-user-pool-group';
      } else if (isRollback && category === 'auth') {
        // Reverse migration: need to find both auth stacks in destination (Gen1) since Gen2 combined them
        for (const {
          LogicalResourceId: destinationLogicalResourceId,
          PhysicalResourceId: _destinationPhysicalResourceId,
        } of destinationCategoryStacks) {
          if (!_destinationPhysicalResourceId) {
            throw new AmplifyError('InvalidStackError', {
              message: `Destination auth category stack '${destinationLogicalResourceId}' does not have a physical resource ID`,
              resolution: 'Ensure the stack is in a stable state before running the migration.',
            });
          }
          const destinationIsAuthCategory = destinationLogicalResourceId?.startsWith('auth');
          if (!destinationIsAuthCategory) continue;

          const gen1AuthTypeStack = await this.getGen1AuthCategory(_destinationPhysicalResourceId);
          isUserPoolGroupStack = gen1AuthTypeStack === 'auth-user-pool-group';

          if (isUserPoolGroupStack) {
            userPoolGroupDestinationPhysicalResourceId = _destinationPhysicalResourceId;
          } else if (gen1AuthTypeStack === 'auth') {
            destinationPhysicalResourceId = _destinationPhysicalResourceId;
          }
        }
      }

      if (!destinationPhysicalResourceId) {
        throw new AmplifyError('InvalidStackError', {
          message: `No destination stack resolved for ${category} category`,
          resolution: 'Ensure the destination stack has the corresponding category resources deployed.',
        });
      }

      // Store the mapping in _categoryStackMap
      this.updateCategoryStackMap(
        category,
        sourcePhysicalResourceId,
        destinationPhysicalResourceId,
        isUserPoolGroupStack,
        isRollback,
        userPoolGroupDestinationPhysicalResourceId,
      );
    }
  }

  /**
   * Stores a category mapping in _categoryStackMap.
   *
   * Handles the complexity of auth category where Gen1 has separate stacks for
   * UserPool vs UserPoolGroups, but Gen2 combines them.
   *
   * @param category - The category name ('auth', 'storage', etc.)
   * @param sourcePhysicalResourceId - The ARN/ID of the source (Gen1) nested stack
   * @param destinationPhysicalResourceId - The ARN/ID of the destination (Gen2) nested stack
   * @param isUserPoolGroupStack - True if this is specifically a UserPoolGroups stack (not main auth)
   * @param isRollback - True if we're doing a reverse migration (Gen2 → Gen1)
   * @param userPoolGroupDestinationPhysicalResourceId - For rollback: the separate UserPoolGroups stack in Gen1
   */
  private updateCategoryStackMap(
    category: CATEGORY | string,
    sourcePhysicalResourceId: string,
    destinationPhysicalResourceId: string,
    isUserPoolGroupStack: boolean,
    isRollback: boolean,
    userPoolGroupDestinationPhysicalResourceId?: string,
  ): void {
    // For non-UserPoolGroup stacks, or during rollback (where we need both mappings), store the main category mapping
    // Example: 'auth' → [gen1AuthStackId, gen2AuthStackId]
    //          'storage' → [gen1StorageStackId, gen2StorageStackId]
    if (!isUserPoolGroupStack || isRollback) {
      this.categoryStackMap.set(category, [sourcePhysicalResourceId, destinationPhysicalResourceId]);
    }

    // For UserPoolGroup stacks, store a separate mapping under 'auth-user-pool-group'
    // This is needed because Gen1 has a separate stack for groups, but Gen2 combines them
    if (isUserPoolGroupStack) {
      // During rollback: use the separate Gen1 UserPoolGroups stack as destination
      // During forward migration: use the same Gen2 auth stack (since Gen2 combines them)
      const destinationId =
        isRollback && userPoolGroupDestinationPhysicalResourceId
          ? userPoolGroupDestinationPhysicalResourceId
          : destinationPhysicalResourceId;

      this.categoryStackMap.set('auth-user-pool-group', [sourcePhysicalResourceId, destinationId]);
    }
  }

  /**
   * Determines the type of a Gen1 auth stack by parsing its Description metadata.
   *
   * Gen1 Amplify stores JSON metadata in the stack's Description field, including a 'stackType'
   * that indicates whether this is the main auth stack or the UserPoolGroups stack.
   *
   * @param stackName - The stack name/ARN to inspect
   * @returns 'auth' for main auth stack, 'auth-user-pool-group' for groups stack, null if unknown
   */
  private getGen1AuthCategory = async (stackName: string): Promise<CATEGORY | null> => {
    const describeStacksResponse = await this.cfnClient.send(
      new DescribeStacksCommand({
        StackName: stackName,
      }),
    );

    const stackDescription = describeStacksResponse?.Stacks?.[0]?.Description;
    if (!stackDescription) return null;

    try {
      // Gen1 stores metadata as JSON in the Description field
      // Example: {"stackType": "auth-Cognito"} or {"stackType": "auth-Cognito-UserPool-Groups"}
      const parsedStackDescription = JSON.parse(stackDescription);

      if (typeof parsedStackDescription === 'object' && 'stackType' in parsedStackDescription) {
        switch (parsedStackDescription.stackType) {
          case GEN1_USER_POOL_GROUPS_STACK_TYPE_DESCRIPTION: // 'auth-Cognito-UserPool-Groups'
            return 'auth-user-pool-group';
          case GEN1_AUTH_STACK_TYPE_DESCRIPTION: // 'auth-Cognito'
            return 'auth';
        }
      }
    } catch (e) {
      // Description might not be valid JSON (older stacks or different format)
      // Fail silently and return null
    }

    return null;
  };

  private isNoResourcesError(error: unknown): boolean {
    return error instanceof NoResourcesError;
  }

  private getStackCategoryName(category: string) {
    return !this.isCustomResource(category) ? category : 'custom';
  }

  private async processGen1Stack(
    category: string,
    categoryTemplateGenerator: CategoryTemplateGenerator<CFN_CATEGORY_TYPE>,
    sourceCategoryStackId: string,
  ): Promise<[CFNTemplate, Parameter[]] | undefined> {
    try {
      const { newTemplate, parameters: gen1StackParameters } = await categoryTemplateGenerator.generateGen1PreProcessTemplate();
      // gen1StackParameters guaranteed by generateGen1PreProcessTemplate() which asserts Parameters
      this.logger.info(`Updating Gen 1 ${this.getStackCategoryName(category)} stack...`);

      const gen1StackUpdateStatus = await tryUpdateStack(this.cfnClient, sourceCategoryStackId, gen1StackParameters!, newTemplate);

      if (gen1StackUpdateStatus !== CFNStackStatus.UPDATE_COMPLETE) {
        throw new AmplifyError('InvalidStackError', {
          message: `Gen 1 stack is in an invalid state: ${gen1StackUpdateStatus}`,
          resolution: 'Check the CloudFormation console for details on the failed stack update.',
        });
      }
      this.logger.info(`Updated Gen 1 ${this.getStackCategoryName(category)} stack successfully`);

      return [newTemplate, gen1StackParameters];
    } catch (e) {
      if (this.isNoResourcesError(e)) {
        this.logger.info(`No resources found to move in Gen 1 ${this.getStackCategoryName(category)} stack. Skipping update.`);
        return undefined;
      }
      throw e;
    }
  }

  private async processGen2Stack(
    category: string,
    categoryTemplateGenerator: CategoryTemplateGenerator<CFN_CATEGORY_TYPE>,
    destinationCategoryStackId: string,
  ): Promise<{
    newTemplate: CFNTemplate;
    oldTemplate: CFNTemplate;
    parameters?: Parameter[];
  }> {
    try {
      const { newTemplate, oldTemplate, parameters } = await categoryTemplateGenerator.generateGen2ResourceRemovalTemplate();

      this.logger.info(`Updating Gen 2 ${this.getStackCategoryName(category)} stack...`);

      const gen2StackUpdateStatus = await tryUpdateStack(this.cfnClient, destinationCategoryStackId, parameters ?? [], newTemplate);

      if (gen2StackUpdateStatus !== CFNStackStatus.UPDATE_COMPLETE) {
        throw new AmplifyError('InvalidStackError', {
          message: `Gen 2 stack is in an invalid state: ${gen2StackUpdateStatus}`,
          resolution: 'Check the CloudFormation console for details on the failed stack update.',
        });
      }
      this.logger.info(`Updated Gen 2 ${this.getStackCategoryName(category)} stack successfully`);

      return { newTemplate, oldTemplate, parameters };
    } catch (e) {
      if (this.isNoResourcesError(e)) {
        const currentTemplate = categoryTemplateGenerator.gen2Template;
        // gen2Template guaranteed set by generateGen2ResourceRemovalTemplate() before this catch path
        const parameters = categoryTemplateGenerator.gen2StackParameters;
        return { newTemplate: currentTemplate!, oldTemplate: currentTemplate!, parameters };
      }
      throw e;
    }
  }

  private initializeCategoryGenerators(customResourceMap?: ResourceMapping[]) {
    for (const [category, [sourceStackId, destinationStackId]] of this.categoryStackMap.entries()) {
      const config = this.categoryGeneratorConfig[category as keyof typeof this.categoryGeneratorConfig];

      if (config) {
        this.categoryTemplateGenerators.push([
          category,
          sourceStackId,
          destinationStackId,
          this.createCategoryTemplateGenerator(sourceStackId, destinationStackId, config.resourcesToRefactor),
        ]);
      }
      // Only use the customResourceMap as a fallback, if its not in the TemplateGenerator config
      else if (customResourceMap && this.isCustomResource(category)) {
        this.categoryTemplateGenerators.push([
          category,
          sourceStackId,
          destinationStackId,
          this.createCategoryTemplateGenerator(sourceStackId, destinationStackId, [], customResourceMap),
        ]);
      }
    }
  }

  private createCategoryTemplateGenerator(
    sourceStackId: string,
    destinationStackId: string,
    resourcesToRefactor: CFN_CATEGORY_TYPE[],
    customResourceMap?: ResourceMapping[],
  ): CategoryTemplateGenerator<CFN_CATEGORY_TYPE> {
    return new CategoryTemplateGenerator({
      logger: this.logger,
      gen1StackId: sourceStackId,
      gen2StackId: destinationStackId,
      region: this.region,
      accountId: this.accountId,
      cfnClient: this.cfnClient,
      ssmClient: this.ssmClient,
      cognitoIdpClient: this.cognitoIdpClient,
      appId: this.appId,
      environmentName: this.environmentName,
      resourcesToMove: resourcesToRefactor,
      resourcesToMovePredicate: customResourceMap
        ? (_resourcesToMove: CFN_CATEGORY_TYPE[], cfnResource: [string, CFNResource]) => {
            const [logicalId] = cfnResource;
            return (
              customResourceMap?.some(
                (resourceMapping) =>
                  resourceMapping.Source.LogicalResourceId === logicalId || resourceMapping.Destination.LogicalResourceId === logicalId,
              ) ?? false
            );
          }
        : undefined,
    });
  }

  private isCustomResource(category: string) {
    return !Object.values(NON_CUSTOM_RESOURCE_CATEGORY)
      .map((nonCustomCategory) => nonCustomCategory.valueOf())
      .includes(category);
  }

  private async generateCategoryTemplates(isRollback = false, customResourceMap?: ResourceMapping[]) {
    this.initializeCategoryGenerators(customResourceMap);
    for (const [category, sourceCategoryStackId, destinationCategoryStackId, categoryTemplateGenerator] of this
      .categoryTemplateGenerators) {
      let result: CategoryRefactorResult | undefined;

      if (customResourceMap && this.isCustomResource(category)) {
        result = await this.prepareCategoryForCustomResourceRefactor(
          category,
          categoryTemplateGenerator,
          sourceCategoryStackId,
          destinationCategoryStackId,
          customResourceMap,
        );
      } else if (!isRollback) {
        result = await this.prepareCategoryForForwardRefactor(
          category,
          categoryTemplateGenerator,
          sourceCategoryStackId,
          destinationCategoryStackId,
        );
      } else {
        result = await this.prepareCategoryForRollback(
          category,
          categoryTemplateGenerator,
          sourceCategoryStackId,
          destinationCategoryStackId,
        );
      }

      if (!result) continue;

      this.logger.info(
        `Moving ${this.getStackCategoryName(category)} resources from ${this.getSourceToDestinationMessage(isRollback)} stack...`,
      );
      const { success, failedRefactorMetadata } = await this.refactorResources(
        result.logicalIdMapping,
        sourceCategoryStackId,
        destinationCategoryStackId,
        category,
        isRollback,
        result.sourceTemplate,
        result.destinationTemplate,
      );
      if (!success) {
        this.logger.info(
          `Moving ${this.getStackCategoryName(category)} resources from ${this.getSourceToDestinationMessage(
            isRollback,
          )} stack failed. Reason: ${failedRefactorMetadata?.reason}. Status: ${failedRefactorMetadata?.status}. RefactorId: ${
            failedRefactorMetadata?.stackRefactorId
          }.`,
        );
        await pollStackForCompletionState(this.cfnClient, destinationCategoryStackId, 30);
        if (!isRollback && result.oldDestinationTemplate) {
          await this.rollbackGen2Stack(
            category,
            destinationCategoryStackId,
            result.destinationStackParameters,
            result.oldDestinationTemplate,
          );
        }
        return false;
      } else {
        this.logger.info(
          `Moved ${this.getStackCategoryName(category)} resources from ${this.getSourceToDestinationMessage(
            isRollback,
          )} stack successfully`,
        );
      }
    }
    return true;
  }

  private async prepareCategoryForCustomResourceRefactor(
    category: string,
    categoryTemplateGenerator: CategoryTemplateGenerator<CFN_CATEGORY_TYPE>,
    sourceCategoryStackId: string,
    destinationCategoryStackId: string,
    customResourceMap: ResourceMapping[],
  ): Promise<CategoryRefactorResult | undefined> {
    const processGen1StackResponse = await this.processGen1Stack(category, categoryTemplateGenerator, sourceCategoryStackId);
    if (!processGen1StackResponse) return undefined;
    const [newGen1Template] = processGen1StackResponse;

    const { newTemplate: newGen2Template } = await this.processGen2Stack(category, categoryTemplateGenerator, destinationCategoryStackId);

    const sourceToDestinationMap = new Map<string, string>();
    for (const { Source, Destination } of customResourceMap) {
      if (Source.LogicalResourceId && Destination.LogicalResourceId) {
        sourceToDestinationMap.set(Source.LogicalResourceId, Destination.LogicalResourceId);
      }
    }

    const { sourceTemplate, destinationTemplate, logicalIdMapping } = categoryTemplateGenerator.generateRefactorTemplates(
      categoryTemplateGenerator.gen1ResourcesToMove,
      categoryTemplateGenerator.gen2ResourcesToRemove,
      newGen1Template,
      newGen2Template,
      sourceToDestinationMap,
    );
    return { sourceTemplate, destinationTemplate, logicalIdMapping };
  }

  private async prepareCategoryForForwardRefactor(
    category: string,
    categoryTemplateGenerator: CategoryTemplateGenerator<CFN_CATEGORY_TYPE>,
    sourceCategoryStackId: string,
    destinationCategoryStackId: string,
  ): Promise<CategoryRefactorResult | undefined> {
    const processGen1StackResponse = await this.processGen1Stack(category, categoryTemplateGenerator, sourceCategoryStackId);
    if (!processGen1StackResponse) return undefined;
    const [newGen1Template] = processGen1StackResponse;

    const { newTemplate, oldTemplate, parameters } = await this.processGen2Stack(
      category,
      categoryTemplateGenerator,
      destinationCategoryStackId,
    );
    const { sourceTemplate, destinationTemplate, logicalIdMapping } = categoryTemplateGenerator.generateStackRefactorTemplates(
      newGen1Template,
      newTemplate,
    );
    return {
      sourceTemplate,
      destinationTemplate,
      logicalIdMapping,
      oldDestinationTemplate: oldTemplate,
      destinationStackParameters: parameters,
    };
  }

  private async prepareCategoryForRollback(
    category: string,
    categoryTemplateGenerator: CategoryTemplateGenerator<CFN_CATEGORY_TYPE>,
    sourceCategoryStackId: string,
    destinationCategoryStackId: string,
  ): Promise<CategoryRefactorResult | undefined> {
    const sourceTemplate = await categoryTemplateGenerator.readTemplate(sourceCategoryStackId);
    const destinationTemplate = await categoryTemplateGenerator.readTemplate(destinationCategoryStackId);
    try {
      return await this.generateRefactorTemplatesForRollback(
        sourceTemplate,
        destinationTemplate,
        categoryTemplateGenerator,
        sourceCategoryStackId,
        category,
      );
    } catch (e) {
      if (this.isNoResourcesError(e)) return undefined;
      throw e;
    }
  }

  private async refactorResources(
    logicalIdMappingForRefactor: Map<string, string>,
    sourceCategoryStackId: string,
    destinationCategoryStackId: string,
    category: 'auth' | 'storage' | 'auth-user-pool-group' | string,
    isRollback: boolean,
    sourceTemplateForRefactor: CFNTemplate,
    destinationTemplateForRefactor: CFNTemplate,
  ) {
    const resourceMappings: ResourceMapping[] = [];
    for (const [sourceLogicalId, destinationLogicalId] of logicalIdMappingForRefactor) {
      resourceMappings.push({
        Source: {
          StackName: sourceCategoryStackId,
          LogicalResourceId: sourceLogicalId,
        },
        Destination: {
          StackName: destinationCategoryStackId,
          LogicalResourceId: destinationLogicalId,
        },
      });
    }
    const [success, failedRefactorMetadata] = await tryRefactorStack(this.cfnClient, {
      StackDefinitions: [
        {
          TemplateBody: JSON.stringify(sourceTemplateForRefactor),
          StackName: sourceCategoryStackId,
        },
        {
          TemplateBody: JSON.stringify(destinationTemplateForRefactor),
          StackName: destinationCategoryStackId,
        },
      ],
      ResourceMappings: resourceMappings,
    });
    return { success, failedRefactorMetadata };
  }

  private async rollbackGen2Stack(
    category: CATEGORY,
    gen2CategoryStackId: string,
    gen2StackParameters: Parameter[] | undefined,
    oldGen2Template: CFNTemplate,
  ) {
    this.logger.info(`Rolling back Gen 2 ${this.getStackCategoryName(category)} stack...`);
    const gen2StackUpdateStatus = await tryUpdateStack(this.cfnClient, gen2CategoryStackId, gen2StackParameters ?? [], oldGen2Template);
    if (gen2StackUpdateStatus !== CFNStackStatus.UPDATE_COMPLETE) {
      throw new AmplifyError('InvalidStackError', {
        message: `Gen 2 stack is in a failed state: ${gen2StackUpdateStatus}`,
        resolution: 'Check the CloudFormation console for details on the failed stack rollback.',
      });
    }
    this.logger.info(`Rolled back Gen 2 ${this.getStackCategoryName(category)} stack successfully`);
  }

  private async generateRefactorTemplatesForRollback(
    newSourceTemplate: CFNTemplate,
    newDestinationTemplate: CFNTemplate,
    categoryTemplateGenerator: CategoryTemplateGenerator<CFN_CATEGORY_TYPE>,
    sourceCategoryStackId: string,
    category: CATEGORY,
  ) {
    if (!newSourceTemplate.Resources) {
      throw new AmplifyError('CloudFormationTemplateError', {
        message: 'Source template is missing a Resources section',
        resolution: 'Ensure the CloudFormation template contains a valid Resources section.',
      });
    }
    const sourceResourcesToRemove: Map<string, CFNResource> = new Map(
      Object.entries(newSourceTemplate.Resources).filter(([, value]) =>
        LOGICAL_IDS_TO_REMOVE_FOR_ROLLBACK_MAP.get(category)?.some((resourceToMove) => resourceToMove.valueOf() === value.Type),
      ),
    );
    if (sourceResourcesToRemove.size === 0) {
      // Internal sentinel — caught by isNoResourcesError() for control flow (skips category)
      throw new NoResourcesError(`No resources to move in ${category} stack.`);
    }
    const describeStackResponseForSourceTemplate = await categoryTemplateGenerator.describeStack(sourceCategoryStackId);
    if (!describeStackResponseForSourceTemplate) {
      throw new AmplifyError('InvalidStackError', {
        message: `Failed to describe source stack '${sourceCategoryStackId}'`,
        resolution: 'Ensure the stack exists and is accessible.',
      });
    }
    const sourceLogicalIds = [...sourceResourcesToRemove.keys()];
    const { Outputs, Parameters } = describeStackResponseForSourceTemplate;
    if (!Outputs) {
      throw new AmplifyError('InvalidStackError', {
        message: `Source stack '${sourceCategoryStackId}' has no outputs`,
        resolution: 'Ensure the stack has outputs defined for the resources being migrated.',
      });
    }
    const { StackResources } = await this.cfnClient.send(
      new DescribeStackResourcesCommand({
        StackName: sourceCategoryStackId,
      }),
    );
    if (!StackResources) {
      throw new AmplifyError('InvalidStackError', {
        message: `No resources found in stack '${sourceCategoryStackId}'`,
        resolution: 'Ensure the stack exists and contains resources.',
      });
    }
    const newSourceTemplateWithParametersResolved = new CfnParameterResolver(newSourceTemplate).resolve(Parameters ?? []);
    const newSourceTemplateWithOutputsResolved = new CfnOutputResolver(
      newSourceTemplateWithParametersResolved,
      this.region,
      this.accountId,
    ).resolve(sourceLogicalIds, Outputs, StackResources);
    const newSourceTemplateWithDepsResolved = new CfnDependencyResolver(newSourceTemplateWithOutputsResolved).resolve(sourceLogicalIds);
    return categoryTemplateGenerator.generateRefactorTemplates(
      sourceResourcesToRemove,
      new Map<string, CFNResource>(),
      newSourceTemplateWithDepsResolved,
      newDestinationTemplate,
      this.buildSourceToDestinationMapForRollback(sourceResourcesToRemove),
    );
  }

  private getSourceToDestinationMessage(rollback: boolean) {
    const SOURCE_TO_DESTINATION_STACKS = [GEN1, GEN2];
    return rollback ? SOURCE_TO_DESTINATION_STACKS.reverse().join(' to ') : SOURCE_TO_DESTINATION_STACKS.join(' to ');
  }

  private buildSourceToDestinationMapForRollback(sourceResourcesToRemove: Map<string, CFNResource>): Map<string, string> {
    const sourceToDestinationLogicalIdsMap = new Map<string, string>();
    for (const [sourceLogicalId, resource] of sourceResourcesToRemove) {
      if (sourceLogicalId.includes(GEN2_NATIVE_APP_CLIENT)) {
        sourceToDestinationLogicalIdsMap.set(sourceLogicalId, 'UserPoolClient');
      } else if (resource.Type === CFN_AUTH_TYPE.UserPoolGroup) {
        const [, sourceLogicalIdSuffix] = sourceLogicalId.split(GEN2_AMPLIFY_AUTH_LOGICAL_ID_PREFIX);
        // last 8 digits are always a CDK HASH
        // amplifyAuth<destinationLogicalId>8digitCDKHASH
        const destinationLogicalId = sourceLogicalIdSuffix.slice(0, sourceLogicalIdSuffix.length - CDK_HASH_LENGTH);
        sourceToDestinationLogicalIdsMap.set(sourceLogicalId, destinationLogicalId);
      } else {
        const destinationLogicalId = GEN1_RESOURCE_TYPE_TO_LOGICAL_RESOURCE_IDS_MAP.get(resource.Type);
        if (!destinationLogicalId) {
          throw new AmplifyError('InvalidStackError', {
            message: `No rollback mapping found for resource type '${resource.Type}' (logical ID: '${sourceLogicalId}')`,
            resolution: 'This resource type is not supported for rollback. Check the migration documentation for supported resource types.',
          });
        }
        sourceToDestinationLogicalIdsMap.set(sourceLogicalId, destinationLogicalId);
      }
    }

    return sourceToDestinationLogicalIdsMap;
  }
}

export { TemplateGenerator };
