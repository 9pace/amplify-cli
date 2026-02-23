import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackResourcesCommand,
  GetTemplateCommand,
  Output,
  Stack,
  Parameter,
} from '@aws-sdk/client-cloudformation';
import { SSMClient } from '@aws-sdk/client-ssm';
import { AmplifyError } from '@aws-amplify/amplify-cli-core';
import {
  CFN_AUTH_TYPE,
  CFN_IAM_TYPE,
  CFNResource,
  CFNStackRefactorTemplates,
  CFNTemplate,
  CFN_RESOURCE_TYPES,
  Gen1PreProcessResult,
  Gen2ResourceRemovalResult,
  GEN1_WEB_APP_CLIENT,
  GEN2_NATIVE_APP_CLIENT,
} from '../types';
import { CfnConditionResolver } from '../resolvers/cfn-condition-resolver';
import { CfnParameterResolver } from '../resolvers/cfn-parameter-resolver';
import { CfnOutputResolver } from '../resolvers/cfn-output-resolver';
import { CfnDependencyResolver } from '../resolvers/cfn-dependency-resolver';
import { extractStackNameFromId } from '../utils';
import { retrieveOAuthValues } from '../oauth-values-retriever';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { Logger } from '../../../gen2-migration';

export const HOSTED_PROVIDER_META_PARAMETER_NAME = 'hostedUIProviderMeta';
const HOSTED_PROVIDER_CREDENTIALS_PARAMETER_NAME = 'hostedUIProviderCreds';
const USER_POOL_ID_OUTPUT_KEY_NAME = 'UserPoolId';

/**
 * Multi-instance resource types require custom matching logic to pair Gen1 → Gen2 resources.
 * Single-instance types match by type alone. Adding a new multi-instance type here
 * forces you to define its matching strategy — omission causes a compile error, not a silent skip.
 */
type PairMatchFn = (gen1LogicalId: string, gen2LogicalId: string) => boolean;
const MULTI_INSTANCE_MATCHERS = new Map<string, PairMatchFn>([
  // Web↔Web when both conditions true, Native↔Native when both false
  [CFN_AUTH_TYPE.UserPoolClient, (g1, g2) => (g1 === GEN1_WEB_APP_CLIENT) === !g2.includes(GEN2_NATIVE_APP_CLIENT)],
  [CFN_AUTH_TYPE.UserPoolGroup, (g1, g2) => g2.includes(g1)],
  [CFN_IAM_TYPE.Role, (g1, g2) => g2.includes(g1)],
]);

export interface CategoryTemplateGeneratorConfig {
  logger: Logger;
  gen1StackId: string;
  gen2StackId: string;
  region: string;
  accountId: string;
  cfnClient: CloudFormationClient;
  ssmClient: SSMClient;
  cognitoIdpClient: CognitoIdentityProviderClient;
  appId: string;
  environmentName: string;
  resourcesToMove: CFN_RESOURCE_TYPES[];
}

class CategoryTemplateGenerator {
  private readonly logger: Logger;
  private readonly gen1StackId: string;
  private readonly gen2StackId: string;
  private readonly region: string;
  private readonly accountId: string;
  private readonly cfnClient: CloudFormationClient;
  private readonly ssmClient: SSMClient;
  private readonly cognitoIdpClient: CognitoIdentityProviderClient;
  private readonly appId: string;
  private readonly environmentName: string;
  private readonly resourcesToMove: CFN_RESOURCE_TYPES[];

  constructor(config: CategoryTemplateGeneratorConfig) {
    this.logger = config.logger;
    this.gen1StackId = config.gen1StackId;
    this.gen2StackId = config.gen2StackId;
    this.region = config.region;
    this.accountId = config.accountId;
    this.cfnClient = config.cfnClient;
    this.ssmClient = config.ssmClient;
    this.cognitoIdpClient = config.cognitoIdpClient;
    this.appId = config.appId;
    this.environmentName = config.environmentName;
    this.resourcesToMove = config.resourcesToMove;
  }

  /**
   * Prepares the Gen1 stack template for resource migration by resolving all dynamic references.
   *
   * Before resources can be moved to Gen2, all dynamic CloudFormation references must be
   * resolved to static values. Otherwise, references pointing to resources that will
   * be removed would break the stack.
   */
  public async generateGen1PreProcessTemplate(): Promise<Gen1PreProcessResult | undefined> {
    this.logger.debug(`Gen1 Stack ID: ${this.gen1StackId}`);

    const gen1DescribeStacksResponse = await this.describeStack(this.gen1StackId);
    if (!gen1DescribeStacksResponse) {
      throw new AmplifyError('InvalidStackError', {
        message: `Failed to describe Gen1 stack '${this.gen1StackId}'`,
        resolution: 'Ensure the stack exists and is accessible.',
      });
    }
    const { Parameters, Outputs } = gen1DescribeStacksResponse;
    if (!Parameters) {
      throw new AmplifyError('InvalidStackError', {
        message: `Gen1 stack '${this.gen1StackId}' has no parameters`,
        resolution: 'Ensure the Gen1 stack has parameters defined.',
      });
    }
    if (!Outputs) {
      throw new AmplifyError('InvalidStackError', {
        message: `Gen1 stack '${this.gen1StackId}' has no outputs`,
        resolution: 'Ensure the Gen1 stack has outputs defined for the resources being migrated.',
      });
    }
    this.logger.debug(`Gen1 Stack Parameters: ${JSON.stringify(Parameters, null, 2)}`);
    this.logger.debug(`Gen1 Stack Outputs: ${JSON.stringify(Outputs, null, 2)}`);

    const oldGen1Template = await this.readTemplate(this.gen1StackId);
    this.logger.debug(`Gen1 Template Resources count: ${Object.keys(oldGen1Template.Resources).length}`);
    const gen1ResourcesToMove: Map<string, CFNResource> = new Map(
      Object.entries(oldGen1Template.Resources).filter(([, value]) => {
        return this.resourcesToMove.some((resourceToMove) => resourceToMove.valueOf() === value.Type);
      }),
    );
    this.logger.debug(`Gen1 Resources to move: ${Array.from(gen1ResourcesToMove.keys())}`);
    for (const [logicalId, resource] of gen1ResourcesToMove) {
      this.logger.debug(`   - ${logicalId}: Type=${resource.Type}`);
      if (resource.DependsOn) {
        this.logger.debug(`     DependsOn: ${JSON.stringify(resource.DependsOn)}`);
      }
    }

    if (gen1ResourcesToMove.size === 0) return undefined;
    const logicalResourceIds = [...gen1ResourcesToMove.keys()];

    const gen1ParametersResolvedTemplate = new CfnParameterResolver(oldGen1Template, extractStackNameFromId(this.gen1StackId)).resolve(
      Parameters,
    );

    this.logger.debug('Describing Gen1 stack resources...');
    const stackResources = await this.describeStackResources(this.gen1StackId);
    this.logger.debug(`Gen1 Stack Resources count: ${stackResources.length}`);

    const gen1TemplateWithOutputsResolved = new CfnOutputResolver(gen1ParametersResolvedTemplate, this.region, this.accountId).resolve(
      logicalResourceIds,
      Outputs,
      stackResources,
    );

    const gen1TemplateWithDepsResolved = new CfnDependencyResolver(gen1TemplateWithOutputsResolved).resolve(logicalResourceIds);

    const gen1TemplateWithConditionsResolved = new CfnConditionResolver(gen1TemplateWithDepsResolved).resolve(Parameters);

    // CloudFormation requires at least one resource in a stack.
    // If all resources are being moved, add a placeholder resource now so it exists
    // in the stack before the refactor operation.
    const totalResources = Object.keys(oldGen1Template.Resources).length;
    if (totalResources === gen1ResourcesToMove.size) {
      this.logger.debug('All Gen1 resources will be moved, adding placeholder resource to Gen1 stack');
      gen1TemplateWithConditionsResolved.Resources['MigrationPlaceholder'] = {
        Type: 'AWS::CloudFormation::WaitConditionHandle',
        Properties: {},
      };
    }

    await this.resolveOAuthCredentials(Parameters, Outputs);

    return {
      oldTemplate: oldGen1Template,
      newTemplate: gen1TemplateWithConditionsResolved,
      parameters: Parameters,
      resourcesToMove: gen1ResourcesToMove,
    };
  }

  /**
   * If OAuth is configured, fetches provider credentials from Cognito/SSM
   * and writes them into the hostedUIProviderCreds parameter.
   * Mutates the Parameters array in-place.
   */
  private async resolveOAuthCredentials(parameters: Parameter[], outputs: Output[]): Promise<void> {
    const oAuthProvidersParam = parameters.find((param) => param.ParameterKey === HOSTED_PROVIDER_META_PARAMETER_NAME);
    if (!oAuthProvidersParam) return;

    const userPoolId = outputs.find((op) => op.OutputKey === USER_POOL_ID_OUTPUT_KEY_NAME)?.OutputValue;
    if (!userPoolId) {
      throw new AmplifyError('InvalidStackError', {
        message: `Gen1 stack output '${USER_POOL_ID_OUTPUT_KEY_NAME}' not found`,
        resolution: 'Ensure the Gen1 auth stack has a UserPoolId output.',
      });
    }
    const oAuthValues = await retrieveOAuthValues({
      ssmClient: this.ssmClient,
      cognitoIdpClient: this.cognitoIdpClient,
      appId: this.appId,
      environmentName: this.environmentName,
      oAuthParameter: oAuthProvidersParam,
      userPoolId,
    });
    const oAuthProviderCredentialsParam = parameters.find((param) => param.ParameterKey === HOSTED_PROVIDER_CREDENTIALS_PARAMETER_NAME);
    if (!oAuthProviderCredentialsParam) {
      throw new AmplifyError('InvalidStackError', {
        message: `Gen1 stack parameter '${HOSTED_PROVIDER_CREDENTIALS_PARAMETER_NAME}' not found`,
        resolution: 'Ensure the Gen1 auth stack has the hostedUIProviderCreds parameter when OAuth is enabled.',
      });
    }
    oAuthProviderCredentialsParam.ParameterValue = JSON.stringify(oAuthValues);
  }

  public async generateGen2ResourceRemovalTemplate(): Promise<Gen2ResourceRemovalResult> {
    this.logger.debug(`Gen2 Stack ID: ${this.gen2StackId}`);

    const gen2DescribeStacksResponse = await this.describeStack(this.gen2StackId);
    if (!gen2DescribeStacksResponse) {
      throw new AmplifyError('InvalidStackError', {
        message: `Failed to describe Gen2 stack '${this.gen2StackId}'`,
        resolution: 'Ensure the stack exists and is accessible.',
      });
    }
    const { Parameters, Outputs } = gen2DescribeStacksResponse;
    if (!Outputs) {
      throw new AmplifyError('InvalidStackError', {
        message: `Gen2 stack '${this.gen2StackId}' has no outputs`,
        resolution: 'Ensure the Gen2 stack has outputs defined.',
      });
    }
    if (Parameters) {
      this.logger.debug(`Gen2 Stack Parameters: ${JSON.stringify(Parameters, null, 2)}`);
    }
    this.logger.debug(`Gen2 Stack Outputs: ${JSON.stringify(Outputs, null, 2)}`);

    const oldGen2Template = await this.readTemplate(this.gen2StackId);
    this.logger.debug(`Gen2 Template Resources count: ${Object.keys(oldGen2Template.Resources).length}`);

    const gen2ResourcesToRemove: Map<string, CFNResource> = new Map(
      Object.entries(oldGen2Template.Resources).filter(([, value]) => {
        return this.resourcesToMove.some((resourceToMove) => resourceToMove.valueOf() === value.Type);
      }),
    );
    this.logger.debug(`Gen2 Resources to remove: ${Array.from(gen2ResourcesToRemove.keys())}`);
    for (const [logicalId, resource] of gen2ResourcesToRemove) {
      this.logger.debug(`   - ${logicalId}: Type=${resource.Type}`);
      if (resource.DependsOn) {
        this.logger.debug(`     DependsOn: ${JSON.stringify(resource.DependsOn)}`);
      }
    }

    if (gen2ResourcesToRemove.size === 0) {
      return {
        oldTemplate: oldGen2Template,
        newTemplate: oldGen2Template,
        parameters: Parameters,
        resourcesToRemove: gen2ResourcesToRemove,
      };
    }
    const logicalResourceIds = [...gen2ResourcesToRemove.keys()];

    const updatedGen2Template = await this.removeGen2ResourcesFromGen2Stack(oldGen2Template, logicalResourceIds, Outputs);
    return {
      oldTemplate: oldGen2Template,
      newTemplate: updatedGen2Template,
      parameters: Parameters,
      resourcesToRemove: gen2ResourcesToRemove,
    };
  }

  public generateStackRefactorTemplates(
    gen1Template: CFNTemplate,
    gen2Template: CFNTemplate,
    gen1ResourcesToMove: ReadonlyMap<string, CFNResource>,
    gen2ResourcesToRemove: ReadonlyMap<string, CFNResource>,
  ): CFNStackRefactorTemplates {
    if (gen1ResourcesToMove.size === 0 && gen2ResourcesToRemove.size === 0) {
      throw new AmplifyError('InvalidStackError', {
        message: 'No resources identified for refactoring',
        resolution: 'Ensure at least one resource map is non-empty before generating refactor templates.',
      });
    }
    return this.generateRefactorTemplates(gen1ResourcesToMove, gen2ResourcesToRemove, gen1Template, gen2Template);
  }

  public async readTemplate(stackId: string) {
    const getTemplateResponse = await this.cfnClient.send(
      new GetTemplateCommand({
        StackName: stackId,
      }),
    );
    const templateBody = getTemplateResponse.TemplateBody;
    if (!templateBody) {
      throw new AmplifyError('InvalidStackError', {
        message: `Stack '${stackId}' returned an empty template body`,
        resolution: 'Ensure the stack exists and has a valid template.',
      });
    }
    return JSON.parse(templateBody) as CFNTemplate;
  }

  public async describeStack(stackId: string) {
    return (
      await this.cfnClient.send(
        new DescribeStacksCommand({
          StackName: stackId,
        }),
      )
    ).Stacks?.[0];
  }

  public async describeStackResources(stackId: string) {
    const { StackResources } = await this.cfnClient.send(
      new DescribeStackResourcesCommand({
        StackName: stackId,
      }),
    );

    if (!StackResources || StackResources.length === 0) {
      throw new AmplifyError('InvalidStackError', {
        message: `No resources found in stack '${stackId}'`,
        resolution: 'Ensure the stack exists and contains resources.',
      });
    }

    return StackResources;
  }

  private removeGen1ResourcesFromGen1Stack(gen1Template: CFNTemplate, resourcesToRefactor: string[]) {
    this.logger.debug(`Removing Gen1 resources: ${resourcesToRefactor}`);
    const resources = gen1Template.Resources;
    for (const resourceToRefactor of resourcesToRefactor) {
      delete resources[resourceToRefactor];
    }
    this.logger.debug(`Gen1 template resources remaining: ${Object.keys(resources).length}`);
    return gen1Template;
  }

  private addGen1ResourcesToGen2Stack(
    resolvedGen1Template: CFNTemplate,
    resourcesToRefactor: string[],
    gen1ToGen2ResourceLogicalIdMapping: Map<string, string>,
    gen2Template: CFNTemplate,
  ) {
    this.logger.debug(`Resources to add: ${resourcesToRefactor}`);
    this.logger.debug(`Resource mapping: ${Array.from(gen1ToGen2ResourceLogicalIdMapping.entries())}`);
    const resources = gen2Template.Resources;
    for (const resourceToRefactor of resourcesToRefactor) {
      const gen2ResourceLogicalId = gen1ToGen2ResourceLogicalIdMapping.get(resourceToRefactor);
      if (!gen2ResourceLogicalId) {
        throw new AmplifyError('InvalidStackError', {
          message: `No Gen2 resource mapping found for Gen1 resource '${resourceToRefactor}'`,
          resolution: 'Ensure the Gen2 stack has corresponding resources for all Gen1 resources being migrated.',
        });
      }
      this.logger.debug(` Adding resource: ${resourceToRefactor} -> ${gen2ResourceLogicalId}`);
      resources[gen2ResourceLogicalId] = resolvedGen1Template.Resources[resourceToRefactor];
      // replace Gen1 dependency with Gen2 counterparts for Gen1 resources being moved over to Gen2
      const dependencies = resources[gen2ResourceLogicalId].DependsOn;
      if (!dependencies) {
        continue;
      }
      this.logger.debug(` Original dependencies for ${gen2ResourceLogicalId}: ${dependencies}`);
      const dependenciesArray = Array.isArray(dependencies) ? dependencies : [dependencies];
      resources[gen2ResourceLogicalId].DependsOn = dependenciesArray.map((dependency) => {
        if (gen1ToGen2ResourceLogicalIdMapping.has(dependency)) {
          const gen2DependencyName = gen1ToGen2ResourceLogicalIdMapping.get(dependency)!;
          this.logger.debug(` Mapping dependency: ${dependency} -> ${gen2DependencyName}`);
          return gen2DependencyName;
        } else {
          return dependency;
        }
      });
      this.logger.debug(` Updated dependencies for ${gen2ResourceLogicalId}: ${resources[gen2ResourceLogicalId].DependsOn}`);
    }
    this.logger.debug(`Gen2 template resources after adding Gen1 resources: ${Object.keys(resources).length}`);
    return gen2Template;
  }

  private buildGen1ToGen2ResourceLogicalIdMapping(
    gen1ResourceMap: ReadonlyMap<string, CFNResource>,
    gen2ResourceMap: ReadonlyMap<string, CFNResource>,
  ) {
    const clonedGen1ResourceMap = new Map(gen1ResourceMap);
    const clonedGen2ResourceMap = new Map(gen2ResourceMap);
    const gen1ToGen2ResourceLogicalIdMapping = new Map<string, string>();
    for (const [gen1ResourceLogicalId, gen1Resource] of clonedGen1ResourceMap) {
      for (const [gen2ResourceLogicalId, gen2Resource] of clonedGen2ResourceMap) {
        if (gen2Resource.Type !== gen1Resource.Type) {
          continue;
        }
        const matcher = MULTI_INSTANCE_MATCHERS.get(gen1Resource.Type);
        if (!matcher || matcher(gen1ResourceLogicalId, gen2ResourceLogicalId)) {
          this.logger.debug(`Mapping found: ${gen1ResourceLogicalId} -> ${gen2ResourceLogicalId}`);
          gen1ToGen2ResourceLogicalIdMapping.set(gen1ResourceLogicalId, gen2ResourceLogicalId);
          clonedGen1ResourceMap.delete(gen1ResourceLogicalId);
          clonedGen2ResourceMap.delete(gen2ResourceLogicalId);
          break;
        }
      }
    }
    this.logger.debug(`Final resource mapping: ${Array.from(gen1ToGen2ResourceLogicalIdMapping.entries())}`);
    this.logger.debug(`Un-mapped Gen1 resources: ${Array.from(clonedGen1ResourceMap.keys())}`);
    this.logger.debug(`Un-mapped Gen2 resources: ${Array.from(clonedGen2ResourceMap.keys())}`);
    return gen1ToGen2ResourceLogicalIdMapping;
  }

  private async removeGen2ResourcesFromGen2Stack(gen2Template: CFNTemplate, resourcesToRemove: string[], stackOutputs: Output[]) {
    this.logger.debug(`Gen2 resources to remove from stack: ${resourcesToRemove}`);
    const clonedGen2Template = JSON.parse(JSON.stringify(gen2Template));

    this.logger.debug('Describing Gen2 stack resources...');
    const stackResources = await this.describeStackResources(this.gen2StackId);
    this.logger.debug(`Gen2 Stack Resources count: ${stackResources.length}`);

    // Resolver ordering differs from Gen1 path (parameter → output → dependency → condition).
    // Gen2 removal only needs dependency + output resolution — no parameters or conditions to resolve
    // because Gen2 templates are CDK-generated with static values. Dependencies are stripped first
    // so the output resolver doesn't try to resolve refs from resources about to be deleted.
    const gen2TemplateWithDepsResolved = new CfnDependencyResolver(clonedGen2Template).resolve(resourcesToRemove);

    const resolvedRefsGen2Template = new CfnOutputResolver(gen2TemplateWithDepsResolved, this.region, this.accountId).resolve(
      resourcesToRemove,
      stackOutputs,
      stackResources,
    );

    resourcesToRemove.forEach((logicalResourceId) => {
      delete resolvedRefsGen2Template.Resources[logicalResourceId];
    });
    this.logger.debug(`Gen2 template resources after removal: ${Object.keys(resolvedRefsGen2Template.Resources).length}`);
    return resolvedRefsGen2Template;
  }

  public generateRefactorTemplates(
    gen1ResourcesToMove: ReadonlyMap<string, CFNResource>,
    gen2ResourcesToRemove: ReadonlyMap<string, CFNResource>,
    gen1Template: CFNTemplate,
    gen2Template: CFNTemplate,
    sourceToDestinationResourceLogicalIdMapping?: Map<string, string>,
  ): CFNStackRefactorTemplates {
    this.logger.debug(`Gen1 resources to move: ${Array.from(gen1ResourcesToMove.keys())}`);
    this.logger.debug(`Gen2 resources to remove: ${Array.from(gen2ResourcesToRemove.keys())}`);

    const gen1LogicalResourceIds = [...gen1ResourcesToMove.keys()];

    if (sourceToDestinationResourceLogicalIdMapping) {
      this.logger.debug(`Using provided resource mapping: ${Array.from(sourceToDestinationResourceLogicalIdMapping.entries())}`);
    }

    const gen1ToGen2ResourceLogicalIdMapping =
      sourceToDestinationResourceLogicalIdMapping ??
      this.buildGen1ToGen2ResourceLogicalIdMapping(gen1ResourcesToMove, gen2ResourcesToRemove);

    const clonedGen1Template = JSON.parse(JSON.stringify(gen1Template));
    const clonedGen2Template = JSON.parse(JSON.stringify(gen2Template));

    const gen2TemplateForRefactor = this.addGen1ResourcesToGen2Stack(
      clonedGen1Template,
      gen1LogicalResourceIds,
      gen1ToGen2ResourceLogicalIdMapping,
      clonedGen2Template,
    );

    const gen1TemplateForRefactor = this.removeGen1ResourcesFromGen1Stack(clonedGen1Template, gen1LogicalResourceIds);

    this.logger.debug(`Source template resources: ${Object.keys(gen1TemplateForRefactor.Resources).length}`);
    this.logger.debug(`Destination template resources: ${Object.keys(gen2TemplateForRefactor.Resources).length}`);

    return {
      sourceTemplate: gen1TemplateForRefactor,
      destinationTemplate: gen2TemplateForRefactor,
      logicalIdMapping: gen1ToGen2ResourceLogicalIdMapping,
    };
  }
}

export { CategoryTemplateGenerator };
