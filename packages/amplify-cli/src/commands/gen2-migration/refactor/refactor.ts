/* eslint-disable spellcheck/spell-checker */
import { AmplifyMigrationStep } from '../_step';
import { AmplifyMigrationOperation } from '../_operation';
import { AmplifyError } from '@aws-amplify/amplify-cli-core';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { AmplifyGen2MigrationValidations } from '../_validations';
import { TemplateGenerator } from './generators/template-generator';

const createAccountIdError = () =>
  new AmplifyError('ConfigurationError', {
    message: 'Unable to determine AWS account ID',
    resolution:
      'Verify your AWS credentials are configured and have permission to call sts:GetCallerIdentity. Run "aws sts get-caller-identity" to test.',
  });

interface CategoryAssessment {
  category: string;
  resourceCount: number;
  resourceTypes: string[];
  hasOAuth: boolean;
  stackId: string;
}

export class AmplifyMigrationRefactorStep extends AmplifyMigrationStep {
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
          const toStack = this.extractParameters();
          await this.executeStackRefactor(toStack);
        },
      },
    ];
  }

  public async rollback(): Promise<AmplifyMigrationOperation[]> {
    return [
      {
        describe: async () => ['Move stateful resources from your Gen2 app back to your Gen1 app'],
        execute: async () => {
          const toStack = this.extractParameters();
          await this.executeRollback(toStack);
        },
      },
    ];
  }

  private extractParameters(): string {
    const toStack = this.context.parameters?.options?.to;

    if (!toStack) {
      throw new AmplifyError('InputValidationError', { message: '--to is required' });
    }

    return toStack;
  }

  private async executeRollback(toStack: string): Promise<void> {
    const templateGenerator = await this.initializeTemplateGenerator('rollback', toStack);
    this.logger.info('🔧 Executing CloudFormation stack rollback...');
    await templateGenerator.rollback();
  }

  private async executeStackRefactor(toStack: string): Promise<void> {
    const templateGenerator = await this.initializeTemplateGenerator('forward', toStack);

    // Initialize template generator (parse category stacks for assessment)
    // Populates _categoryStackMap with: category → [sourceStackId, destinationStackId]
    await templateGenerator.initializeForAssessment();

    // Assess available category stacks for migration
    const categoriesToMigrate = await this.assessCategories(templateGenerator);

    if (categoriesToMigrate.length === 0) {
      this.logger.info('ℹ️  No categories found for migration. Exiting.');
      return;
    }

    this.logger.info('🔧 Executing CloudFormation stack refactor...');
    this.logger.info(`📋 Categories to migrate: ${categoriesToMigrate.join(', ')}`);

    const success = await templateGenerator.generateSelectedCategories(categoriesToMigrate);

    if (!success) {
      throw new AmplifyError('DeploymentError', {
        message: 'Failed to execute CloudFormation stack refactor',
        resolution: 'Check the CloudFormation console for details on the failed stack refactor operation.',
      });
    }
  }

  private async assessCategories(templateGenerator: TemplateGenerator): Promise<string[]> {
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
  private async assessCategoryResources(templateGenerator: TemplateGenerator): Promise<CategoryAssessment[]> {
    const assessments: CategoryAssessment[] = [];

    for (const [category, [sourceCategoryStackId]] of templateGenerator.categoryStackMap.entries()) {
      const sourceTemplate = await templateGenerator.getStackTemplate(sourceCategoryStackId);
      if (!sourceTemplate?.Resources) continue;

      const resourcesToMigrate = templateGenerator.getResourcesToMigrate(sourceTemplate, category);

      if (resourcesToMigrate.length === 0) continue;

      // Get resource types
      const resourceTypes = [...new Set(resourcesToMigrate.map((logicalId) => sourceTemplate.Resources[logicalId]?.Type).filter(Boolean))];

      // Check for OAuth (auth category only)
      let hasOAuth = false;
      if (category === 'auth') {
        hasOAuth = await templateGenerator.hasOAuthParameter(sourceCategoryStackId);
      }

      assessments.push({
        category,
        resourceCount: resourcesToMigrate.length,
        resourceTypes,
        hasOAuth,
        stackId: sourceCategoryStackId,
      });
    }

    return assessments;
  }

  private async initializeTemplateGenerator(direction: 'forward' | 'rollback', toStack: string): Promise<TemplateGenerator> {
    const stsClient = new STSClient({});
    const callerIdentityResult = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = callerIdentityResult.Account;

    if (!accountId) {
      throw createAccountIdError();
    }

    const cfnClient = new CloudFormationClient({});
    const ssmClient = new SSMClient({});
    const cognitoIdpClient = new CognitoIdentityProviderClient({});

    const [gen1Stack, gen2Stack] = direction === 'forward' ? [this.rootStackName, toStack] : [toStack, this.rootStackName];

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
}
