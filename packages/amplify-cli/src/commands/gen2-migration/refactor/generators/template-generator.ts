import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  Parameter,
} from '@aws-sdk/client-cloudformation';
import CategoryTemplateGenerator, { HOSTED_PROVIDER_META_PARAMETER_NAME } from './category-template-generator';
import { discoverCategoryStacks } from './stack-discovery';
import {
  NON_CUSTOM_RESOURCE_CATEGORY,
  CFN_AUTH_TYPE,
  CFN_RESOURCE_TYPES,
  CFN_S3_TYPE,
  CFN_DYNAMODB_TYPE,
  CFNResource,
  CFNStackStatus,
  CFNTemplate,
  ResourceMapping,
  CFN_ANALYTICS_TYPE,
  CategoryRefactorResult,
} from '../types';
import { pollStackForTerminalState, tryUpdateStack } from '../cfn-stack-updater';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { tryRefactorStack } from '../cfn-stack-refactor-updater';
import CfnOutputResolver from '../resolvers/cfn-output-resolver';
import CfnDependencyResolver from '../resolvers/cfn-dependency-resolver';
import CfnParameterResolver from '../resolvers/cfn-parameter-resolver';
import { Logger } from '../../../gen2-migration';
import { AmplifyError } from '@aws-amplify/amplify-cli-core';

const GEN2_AMPLIFY_AUTH_LOGICAL_ID_PREFIX = 'amplifyAuth';
const CDK_HASH_LENGTH = 8;

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
const LOGICAL_IDS_TO_REMOVE_FOR_ROLLBACK_MAP = new Map<NON_CUSTOM_RESOURCE_CATEGORY, CFN_RESOURCE_TYPES[]>([
  [NON_CUSTOM_RESOURCE_CATEGORY.AUTH, AUTH_RESOURCES_TO_REFACTOR],
  [NON_CUSTOM_RESOURCE_CATEGORY.AUTH_USER_POOL_GROUP, AUTH_USER_POOL_GROUP_RESOURCES_TO_REFACTOR],
  [NON_CUSTOM_RESOURCE_CATEGORY.STORAGE, [CFN_S3_TYPE.Bucket, CFN_DYNAMODB_TYPE.Table]],
  [NON_CUSTOM_RESOURCE_CATEGORY.ANALYTICS, ANALYTICS_RESOURCES_TO_REFACTOR],
]);
const GEN2_NATIVE_APP_CLIENT = 'UserPoolNativeAppClient';

/**
 * Orchestrates CloudFormation stack refactoring between Gen1 and Gen2 stacks.
 *
 * This class follows a pipeline pattern: discover → assess → generate → execute → rollback.
 * If it crosses 1000 lines or gains methods outside this pipeline flow, revisit decomposition.
 * See git history for the analysis that deferred the split (KIRO-refactor branch).
 */

interface TemplateGeneratorConfig {
  gen1RootStack: string;
  gen2RootStack: string;
  accountId: string;
  cfnClient: CloudFormationClient;
  ssmClient: SSMClient;
  cognitoIdpClient: CognitoIdentityProviderClient;
  appId: string;
  environmentName: string;
  logger: Logger;
  region: string;
}

interface CategoryGeneratorEntry {
  category: NON_CUSTOM_RESOURCE_CATEGORY;
  sourceStackId: string;
  destinationStackId: string;
  generator: CategoryTemplateGenerator;
}

class TemplateGenerator {
  private _categoryStackMap: Map<NON_CUSTOM_RESOURCE_CATEGORY, [string, string]>;
  private readonly categoryTemplateGenerators: CategoryGeneratorEntry[];
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

  private readonly gen1RootStack: string;
  private readonly gen2RootStack: string;
  private readonly accountId: string;
  private readonly ssmClient: SSMClient;
  private readonly cognitoIdpClient: CognitoIdentityProviderClient;
  private readonly appId: string;
  private readonly environmentName: string;
  private readonly logger: Logger;
  private readonly region: string;

  constructor(config: TemplateGeneratorConfig) {
    this.gen1RootStack = config.gen1RootStack;
    this.gen2RootStack = config.gen2RootStack;
    this.accountId = config.accountId;
    this._cfnClient = config.cfnClient;
    this.ssmClient = config.ssmClient;
    this.cognitoIdpClient = config.cognitoIdpClient;
    this.appId = config.appId;
    this.environmentName = config.environmentName;
    this.logger = config.logger;
    this.region = config.region;
    this._categoryStackMap = new Map<NON_CUSTOM_RESOURCE_CATEGORY, [string, string]>();
    this.categoryTemplateGenerators = [];
  }

  // Public getter for categoryStackMap
  public get categoryStackMap() {
    return this._categoryStackMap;
  }

  // Checks whether a stack has OAuth configured by looking for the hostedUIProviderMeta parameter
  public async hasOAuthParameter(stackId: string): Promise<boolean> {
    const stackInfo = await this._cfnClient.send(new DescribeStacksCommand({ StackName: stackId }));
    const parameters = stackInfo.Stacks?.[0]?.Parameters || [];
    return parameters.some((param) => param.ParameterKey === HOSTED_PROVIDER_META_PARAMETER_NAME);
  }

  // Initialize for assessment - parse category stacks without generating templates
  public async initializeForAssessment(): Promise<void> {
    this._categoryStackMap = await discoverCategoryStacks(this._cfnClient, this.gen1RootStack, this.gen2RootStack, false);
  }

  // Get stack template for a given stack ID
  public async getStackTemplate(stackId: string): Promise<CFNTemplate | undefined> {
    const { TemplateBody } = await this._cfnClient.send(
      new GetTemplateCommand({
        StackName: stackId,
      }),
    );
    if (!TemplateBody) return undefined;
    return JSON.parse(TemplateBody);
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
  public async generateSelectedCategories(selectedCategories: string[]): Promise<boolean> {
    return this.generateCategoryTemplates(false, new Set(selectedCategories));
  }

  public async rollback() {
    this._categoryStackMap = await discoverCategoryStacks(this._cfnClient, this.gen1RootStack, this.gen2RootStack, true);
    return await this.generateCategoryTemplates(true);
  }

  private async processGen1Stack(
    category: string,
    categoryTemplateGenerator: CategoryTemplateGenerator,
    sourceCategoryStackId: string,
  ): Promise<{ newTemplate: CFNTemplate; resourcesToMove: ReadonlyMap<string, CFNResource> } | undefined> {
    const result = await categoryTemplateGenerator.generateGen1PreProcessTemplate();
    if (!result) {
      this.logger.info(`No resources found to move in Gen 1 ${category} stack. Skipping update.`);
      return undefined;
    }
    const { newTemplate, parameters: gen1StackParameters, resourcesToMove } = result;
    // gen1StackParameters guaranteed by generateGen1PreProcessTemplate() which asserts Parameters
    this.logger.info(`Updating Gen 1 ${category} stack...`);

    const gen1StackUpdateStatus = await tryUpdateStack(this._cfnClient, sourceCategoryStackId, gen1StackParameters!, newTemplate);

    if (gen1StackUpdateStatus !== CFNStackStatus.UPDATE_COMPLETE) {
      throw new AmplifyError('InvalidStackError', {
        message: `Gen 1 stack is in an invalid state: ${gen1StackUpdateStatus}`,
        resolution: 'Check the CloudFormation console for details on the failed stack update.',
      });
    }
    this.logger.info(`Updated Gen 1 ${category} stack successfully`);

    return { newTemplate, resourcesToMove };
  }

  private async processGen2Stack(
    category: string,
    categoryTemplateGenerator: CategoryTemplateGenerator,
    destinationCategoryStackId: string,
  ): Promise<{
    newTemplate: CFNTemplate;
    oldTemplate: CFNTemplate;
    parameters?: Parameter[];
    resourcesToRemove: ReadonlyMap<string, CFNResource>;
  }> {
    const result = await categoryTemplateGenerator.generateGen2ResourceRemovalTemplate();
    const { oldTemplate, parameters, resourcesToRemove } = result;

    if (resourcesToRemove.size === 0) {
      return { newTemplate: oldTemplate, oldTemplate, parameters, resourcesToRemove };
    }
    const { newTemplate } = result;

    this.logger.info(`Updating Gen 2 ${category} stack...`);

    const gen2StackUpdateStatus = await tryUpdateStack(this._cfnClient, destinationCategoryStackId, parameters ?? [], newTemplate);

    if (gen2StackUpdateStatus !== CFNStackStatus.UPDATE_COMPLETE) {
      throw new AmplifyError('InvalidStackError', {
        message: `Gen 2 stack is in an invalid state: ${gen2StackUpdateStatus}`,
        resolution: 'Check the CloudFormation console for details on the failed stack update.',
      });
    }
    this.logger.info(`Updated Gen 2 ${category} stack successfully`);

    return { newTemplate, oldTemplate, parameters, resourcesToRemove };
  }

  private initializeCategoryGenerators(categories?: Set<string>) {
    this.categoryTemplateGenerators.length = 0;
    for (const [category, [sourceStackId, destinationStackId]] of this.categoryStackMap.entries()) {
      if (categories && !categories.has(category)) continue;
      const config = this.categoryGeneratorConfig[category as keyof typeof this.categoryGeneratorConfig];

      if (config) {
        this.categoryTemplateGenerators.push({
          category,
          sourceStackId,
          destinationStackId,
          generator: this.createCategoryTemplateGenerator(sourceStackId, destinationStackId, config.resourcesToRefactor),
        });
      }
    }
  }

  private createCategoryTemplateGenerator(
    sourceStackId: string,
    destinationStackId: string,
    resourcesToRefactor: CFN_RESOURCE_TYPES[],
  ): CategoryTemplateGenerator {
    return new CategoryTemplateGenerator({
      logger: this.logger,
      gen1StackId: sourceStackId,
      gen2StackId: destinationStackId,
      region: this.region,
      accountId: this.accountId,
      cfnClient: this._cfnClient,
      ssmClient: this.ssmClient,
      cognitoIdpClient: this.cognitoIdpClient,
      appId: this.appId,
      environmentName: this.environmentName,
      resourcesToMove: resourcesToRefactor,
    });
  }

  private async generateCategoryTemplates(isRollback = false, categories?: Set<string>) {
    this.initializeCategoryGenerators(categories);
    for (const {
      category,
      sourceStackId: sourceCategoryStackId,
      destinationStackId: destinationCategoryStackId,
      generator: categoryTemplateGenerator,
    } of this.categoryTemplateGenerators) {
      let result: CategoryRefactorResult | undefined;

      if (!isRollback) {
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

      this.logger.info(`Moving ${category} resources from ${this.getSourceToDestinationMessage(isRollback)} stack...`);
      const { success, failedRefactorMetadata } = await this.refactorResources(
        result.logicalIdMapping,
        sourceCategoryStackId,
        destinationCategoryStackId,
        result.sourceTemplate,
        result.destinationTemplate,
      );
      if (!success) {
        this.logger.info(
          `Moving ${category} resources from ${this.getSourceToDestinationMessage(isRollback)} stack failed. Reason: ${
            failedRefactorMetadata?.reason
          }. Status: ${failedRefactorMetadata?.status}. RefactorId: ${failedRefactorMetadata?.stackRefactorId}.`,
        );
        await pollStackForTerminalState(this._cfnClient, destinationCategoryStackId, 30, false);
        if (!isRollback && result.oldDestinationTemplate) {
          // Gen1 rollback is unnecessary here: processGen1Stack resolved dynamic references
          // (!Ref, !GetAtt) to static values, but those values are correct. The resources
          // haven't moved (refactor failed), so Gen1 is functional with the resolved template.
          await this.rollbackGen2Stack(
            category,
            destinationCategoryStackId,
            result.destinationStackParameters,
            result.oldDestinationTemplate,
          );
        }
        return false;
      } else {
        this.logger.info(`Moved ${category} resources from ${this.getSourceToDestinationMessage(isRollback)} stack successfully`);
      }
    }
    return true;
  }

  private async prepareCategoryForForwardRefactor(
    category: string,
    categoryTemplateGenerator: CategoryTemplateGenerator,
    sourceCategoryStackId: string,
    destinationCategoryStackId: string,
  ): Promise<CategoryRefactorResult | undefined> {
    const gen1Result = await this.processGen1Stack(category, categoryTemplateGenerator, sourceCategoryStackId);
    if (!gen1Result) return undefined;
    const { newTemplate: newGen1Template, resourcesToMove } = gen1Result;

    const {
      newTemplate: newGen2Template,
      oldTemplate,
      parameters,
      resourcesToRemove,
    } = await this.processGen2Stack(category, categoryTemplateGenerator, destinationCategoryStackId);
    const { sourceTemplate, destinationTemplate, logicalIdMapping } = categoryTemplateGenerator.generateStackRefactorTemplates(
      newGen1Template,
      newGen2Template,
      resourcesToMove,
      resourcesToRemove,
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
    category: NON_CUSTOM_RESOURCE_CATEGORY,
    categoryTemplateGenerator: CategoryTemplateGenerator,
    sourceCategoryStackId: string,
    destinationCategoryStackId: string,
  ): Promise<CategoryRefactorResult | undefined> {
    const sourceTemplate = await categoryTemplateGenerator.readTemplate(sourceCategoryStackId);
    const destinationTemplate = await categoryTemplateGenerator.readTemplate(destinationCategoryStackId);
    return this.generateRefactorTemplatesForRollback(
      sourceTemplate,
      destinationTemplate,
      categoryTemplateGenerator,
      sourceCategoryStackId,
      category,
    );
  }

  private async refactorResources(
    logicalIdMappingForRefactor: Map<string, string>,
    sourceCategoryStackId: string,
    destinationCategoryStackId: string,
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
    const [success, failedRefactorMetadata] = await tryRefactorStack(this._cfnClient, {
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
    category: NON_CUSTOM_RESOURCE_CATEGORY,
    gen2CategoryStackId: string,
    gen2StackParameters: Parameter[] | undefined,
    oldGen2Template: CFNTemplate,
  ) {
    this.logger.info(`Rolling back Gen 2 ${category} stack...`);
    const gen2StackUpdateStatus = await tryUpdateStack(this._cfnClient, gen2CategoryStackId, gen2StackParameters ?? [], oldGen2Template);
    if (gen2StackUpdateStatus !== CFNStackStatus.UPDATE_COMPLETE) {
      throw new AmplifyError('InvalidStackError', {
        message: `Gen 2 stack is in a failed state: ${gen2StackUpdateStatus}`,
        resolution: 'Check the CloudFormation console for details on the failed stack rollback.',
      });
    }
    this.logger.info(`Rolled back Gen 2 ${category} stack successfully`);
  }

  private async generateRefactorTemplatesForRollback(
    newSourceTemplate: CFNTemplate,
    newDestinationTemplate: CFNTemplate,
    categoryTemplateGenerator: CategoryTemplateGenerator,
    sourceCategoryStackId: string,
    category: NON_CUSTOM_RESOURCE_CATEGORY,
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
      return undefined;
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
    const { StackResources } = await this._cfnClient.send(
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
    return rollback ? `${GEN2} to ${GEN1}` : `${GEN1} to ${GEN2}`;
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
