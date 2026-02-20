/* eslint-disable spellcheck/spell-checker */
import { AmplifyMigrationStep } from '../_step';
import { AmplifyMigrationOperation } from '../_operation';
import { AmplifyError } from '@aws-amplify/amplify-cli-core';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { AmplifyGen2MigrationValidations } from '../_validations';
import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { TemplateGenerator } from './generators/template-generator';

const createAccountIdError = () =>
  new AmplifyError('ConfigurationError', {
    message: 'Unable to determine AWS account ID',
    resolution:
      'Verify your AWS credentials are configured and have permission to call sts:GetCallerIdentity. Run "aws sts get-caller-identity" to test.',
  });

export class AmplifyMigrationRefactorStep extends AmplifyMigrationStep {
  private toStack?: string;

  public async executeImplications(): Promise<string[]> {
    return ['Move stateful resources from your Gen1 app to be managed by your Gen2 app'];
  }

  public async rollbackImplications(): Promise<string[]> {
    return ['Move stateful resources from your Gen2 app back to your Gen1 app'];
  }

  public async executeValidate(): Promise<void> {
    const validations = new AmplifyGen2MigrationValidations(this.logger, this.rootStackName, this.currentEnvName, this.context);
    await validations.validateLockStatus();
    return;
  }

  public async rollbackValidate(): Promise<void> {
    // https://github.com/aws-amplify/amplify-cli/issues/14579
    return;
  }

  public async execute(): Promise<AmplifyMigrationOperation[]> {
    return [
      {
        describe: async () => ['Move stateful resources from your Gen1 app to be managed by your Gen2 app'],
        execute: async () => {
          // Extract parameters from context
          this.extractParameters();

          // Execute the stack refactoring
          await this.executeStackRefactor();
        },
      },
    ];
  }

  public async rollback(): Promise<AmplifyMigrationOperation[]> {
    return [
      {
        describe: async () => ['Move stateful resources from your Gen2 app back to your Gen1 app'],
        execute: async () => {
          this.extractParameters();
          await this.executeRollback();
        },
      },
    ];
  }

  private extractParameters(): void {
    this.toStack = this.context.parameters?.options?.to;

    if (!this.toStack) {
      throw new AmplifyError('InputValidationError', { message: '--to is required' });
    }
  }

  private async executeRollback(): Promise<void> {
    const templateGenerator = await this.initializeTemplateGenerator('rollback');
    this.logger.info('🔧 Executing CloudFormation stack rollback...');
    await templateGenerator.rollback();
    await this.emitUsageAnalytics(this.currentEnvName, true);
  }

  private async executeStackRefactor(): Promise<void> {
    // Initialize template generator and clients
    const templateGenerator = await this.initializeTemplateGenerator('forward');

    // Initialize template generator (parse category stacks for assessment)
    // Populates _categoryStackMap with: category → [sourceStackId, destinationStackId]
    await templateGenerator.initializeForAssessment();

    // Interactive assessment and selection
    const selectedCategories = await this.assessAndSelectCategories(templateGenerator);

    if (selectedCategories.length === 0) {
      this.logger.info('ℹ️  No categories selected for migration. Exiting.');
      return;
    }

    this.logger.info('🔧 Executing CloudFormation stack refactor...');
    this.logger.info(`📋 Selected categories: ${selectedCategories.join(', ')}`);

    const success = await templateGenerator.generateSelectedCategories(selectedCategories);

    if (success) {
      // Emit usage analytics
      await this.emitUsageAnalytics(this.currentEnvName, true);
    } else {
      await this.emitUsageAnalytics(this.currentEnvName, false);
      throw new AmplifyError('DeploymentError', {
        message: 'Failed to execute CloudFormation stack refactor',
        resolution: 'Check the CloudFormation console for details on the failed stack refactor operation.',
      });
    }
  }

  private async assessAndSelectCategories(templateGenerator: TemplateGenerator): Promise<string[]> {
    this.logger.info('');
    this.logger.info('🔍 Assessing available resources for migration...');

    const categoryAssessments = await this.assessCategoryResources(templateGenerator);

    if (categoryAssessments.length === 0) {
      this.logger.info('⚠️  No resources found in any category for migration.');
      return [];
    }

    // Display assessment results
    this.logger.info('');
    this.logger.info('📊 Migration Assessment Results:');
    this.logger.info('');

    for (const assessment of categoryAssessments) {
      const { category, resourceCount, resourceTypes, hasOAuth, stackId } = assessment;

      this.logger.info(`🔹 ${category.toUpperCase()} Category:`);
      this.logger.info(`   • Resources to migrate: ${resourceCount}`);
      this.logger.info(`   • Resource types: ${resourceTypes.join(', ')}`);
      if (hasOAuth) {
        this.logger.info(`   • OAuth providers detected: Yes`);
      }
      this.logger.info(`   • Source stack: ${stackId}`);
      this.logger.info('');
    }

    return categoryAssessments.map((a) => a.category);
  }

  // Add all resources that match the categoryGeneratorConfig filters to assessments
  private async assessCategoryResources(templateGenerator: TemplateGenerator): Promise<
    Array<{
      category: string;
      resourceCount: number;
      resourceTypes: string[];
      hasOAuth: boolean;
      stackId: string;
    }>
  > {
    const assessments: Array<{
      category: string;
      resourceCount: number;
      resourceTypes: string[];
      hasOAuth: boolean;
      stackId: string;
    }> = [];

    for (const [category, [sourceCategoryStackId]] of templateGenerator.categoryStackMap.entries()) {
      try {
        const sourceTemplate = await templateGenerator.getStackTemplate(sourceCategoryStackId);
        if (!sourceTemplate?.Resources) continue;

        const resourcesToMigrate = templateGenerator.getResourcesToMigrate(sourceTemplate, category);

        if (resourcesToMigrate.length === 0) continue;

        // Get resource types
        const resourceTypes = [
          ...new Set(resourcesToMigrate.map((logicalId) => sourceTemplate.Resources[logicalId]?.Type).filter(Boolean)),
        ];

        // Check for OAuth (auth category only)
        let hasOAuth = false;
        if (category === 'auth') {
          const stackInfo = await templateGenerator.cfnClient.send(new DescribeStacksCommand({ StackName: sourceCategoryStackId }));
          const parameters = stackInfo.Stacks?.[0]?.Parameters || [];
          hasOAuth = parameters.some((param) => param.ParameterKey === 'hostedUIProviderMeta');
        }

        assessments.push({
          category,
          resourceCount: resourcesToMigrate.length,
          resourceTypes,
          hasOAuth,
          stackId: sourceCategoryStackId,
        });
      } catch (error) {
        this.logger.debug(`Failed to assess ${category} category: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return assessments;
  }

  private async initializeTemplateGenerator(direction: 'forward' | 'rollback'): Promise<TemplateGenerator> {
    const stsClient = new STSClient({});
    const callerIdentityResult = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = callerIdentityResult.Account;

    if (!accountId) {
      throw createAccountIdError();
    }

    const cfnClient = new CloudFormationClient({});
    const ssmClient = new SSMClient({});
    const cognitoIdpClient = new CognitoIdentityProviderClient({});

    // toStack is guaranteed set by extractParameters() which runs before this method
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const [gen1Stack, gen2Stack] = direction === 'forward' ? [this.rootStackName, this.toStack!] : [this.toStack!, this.rootStackName];

    return new TemplateGenerator({
      gen1RootStack: gen1Stack,
      gen2RootStack: gen2Stack,
      accountId,
      cfnClient,
      ssmClient,
      cognitoIdpClient,
      appId: this.appId,
      environmentName: this.currentEnvName,
      logger: this.logger,
      region: this.region,
    });
  }

  private async emitUsageAnalytics(envName: string, success: boolean): Promise<void> {
    // Simplified usage analytics (would normally use UsageData.Instance)
    try {
      this.logger.debug(`Analytics: refactor command ${success ? 'succeeded' : 'failed'} for env: ${envName}`);
    } catch (error) {
      // Ignore analytics errors
    }
  }
}
