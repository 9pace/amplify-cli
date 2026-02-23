import { CFN_RESOURCE_TYPES, CFNTemplate } from '../types';
import { Output, StackResource } from '@aws-sdk/client-cloudformation';
import { AmplifyError } from '@aws-amplify/amplify-cli-core';

const REF = 'Ref';
const GET_ATT = 'Fn::GetAtt';

/**
 * This class is responsible for resolving logical resource ids in a CloudFormation template
 * with their corresponding stack outputs.
 */
class CfnOutputResolver {
  constructor(private readonly template: CFNTemplate, private readonly region: string, private readonly accountId: string) {}

  public resolve(logicalResourceIds: string[], stackOutputs: Output[], stackResources: StackResource[]): CFNTemplate {
    const clonedStackTemplate = JSON.parse(JSON.stringify(this.template)) as CFNTemplate;
    const stackTemplateOutputs = this.template?.Outputs;
    const stackTemplateResources = this.template?.Resources;
    if (!stackTemplateResources) {
      throw new AmplifyError('CloudFormationTemplateError', {
        message: 'Template is missing a Resources section',
        resolution: 'Ensure the CloudFormation template contains a valid Resources section.',
      });
    }
    if (!stackTemplateOutputs) {
      throw new AmplifyError('CloudFormationTemplateError', {
        message: 'Template is missing an Outputs section',
        resolution: 'Ensure the CloudFormation template contains an Outputs section with the expected output keys.',
      });
    }
    let stackTemplateResourcesString = JSON.stringify(stackTemplateResources);

    Object.entries(stackTemplateOutputs).forEach(([outputKey, outputValue]) => {
      const value = outputValue.Value;
      const stackOutputValue = stackOutputs?.find((op) => op.OutputKey === outputKey)?.OutputValue;
      if (!stackOutputValue) {
        throw new AmplifyError('InvalidStackError', {
          message: `Stack output '${outputKey}' not found in stack outputs`,
          resolution:
            'Ensure the stack is in a stable state and all outputs are available. Try describing the stack manually with the AWS CLI.',
        });
      }

      if (typeof value !== 'object') {
        return;
      }

      let logicalResourceId: string | undefined;
      // Replace logicalId references using stack output values
      if (REF in value && typeof value[REF] === 'string') {
        logicalResourceId = value[REF];
        const outputRegexp = new RegExp(`{"${REF}":"${logicalResourceId}"}`, 'g');
        stackTemplateResourcesString = stackTemplateResourcesString.replaceAll(outputRegexp, `"${stackOutputValue}"`);
      } else if (GET_ATT in value && Array.isArray(value[GET_ATT])) {
        logicalResourceId = value[GET_ATT][0];
      } else {
        return;
      }
      if (!logicalResourceId) {
        throw new AmplifyError('CloudFormationTemplateError', {
          message: `Output '${outputKey}' contains an empty Ref or Fn::GetAtt reference`,
          resolution: 'Ensure all Ref and Fn::GetAtt references in the template Outputs section have valid logical resource IDs.',
        });
      }

      // Replace Fn:GetAtt references using stack output values
      const fnGetAttRegExp = new RegExp(`{"${GET_ATT}":\\["${logicalResourceId}","(?<AttributeName>\\w+)"]}`, 'g');
      const fnGetAttRegExpResult = stackTemplateResourcesString.matchAll(fnGetAttRegExp).next();
      if (!fnGetAttRegExpResult.done) {
        const resourceType = this.template.Resources[logicalResourceId].Type as CFN_RESOURCE_TYPES;
        // groups! is safe: the regex named capture group (?<AttributeName>\w+) guarantees a match
        const attributeName = fnGetAttRegExpResult.value.groups!.AttributeName;
        const arn = this.getResourceArn(resourceType, stackOutputValue);
        if (arn) {
          stackTemplateResourcesString = stackTemplateResourcesString.replaceAll(fnGetAttRegExp, `"${arn}"`);
        }
      }
    });

    // If not available in outputs, try to replace with their physical id counterparts.
    stackTemplateResourcesString = this.tryReplaceLogicalResourceRefWithPhysicalId(stackTemplateResourcesString, stackResources);

    clonedStackTemplate.Resources = JSON.parse(stackTemplateResourcesString);
    Object.entries(clonedStackTemplate.Outputs).forEach(([outputKey]) => {
      const stackOutputValue = stackOutputs?.find((op) => op.OutputKey === outputKey)?.OutputValue;
      if (!stackOutputValue) {
        throw new AmplifyError('InvalidStackError', {
          message: `Stack output '${outputKey}' not found in stack outputs`,
          resolution:
            'Ensure the stack is in a stable state and all outputs are available. Try describing the stack manually with the AWS CLI.',
        });
      }
      clonedStackTemplate.Outputs[outputKey].Value = stackOutputValue;
    });

    return clonedStackTemplate;
  }

  /**
   * Currently, we only look for Fn:GetAtt references in the template and try to replace with physical resource ids (if they are not available in outputs)
   * before performing the refactor. We can expand to look for other cases if need be.
   * If this function expands, we can always move it into its own resolver.
   * @param stackTemplateResourcesString
   * @param stackResources
   * @private
   */
  private tryReplaceLogicalResourceRefWithPhysicalId(stackTemplateResourcesString: string, stackResources: StackResource[]) {
    const fnGetAttRegExp = new RegExp(`{"${GET_ATT}":\\["(?<LogicalResourceId>\\w+)","(?<AttributeName>\\w+)"]}`, 'g');
    const fnGetAttRegExpResult = stackTemplateResourcesString.matchAll(fnGetAttRegExp);

    for (const fnGetAttRegExpResultItem of fnGetAttRegExpResult) {
      const groups = fnGetAttRegExpResultItem.groups;
      if (groups && groups.LogicalResourceId) {
        const stackResourceWithMatchingLogicalId = stackResources.find(
          (resource) => resource.LogicalResourceId === groups.LogicalResourceId,
        );
        if (stackResourceWithMatchingLogicalId) {
          const fnGetAttRegExpPerLogicalId = new RegExp(`{"${GET_ATT}":\\["${groups.LogicalResourceId}","(?<AttributeName>\\w+)"]}`, 'g');
          const stackResourcePhysicalId = stackResourceWithMatchingLogicalId.PhysicalResourceId;
          if (!stackResourcePhysicalId) {
            throw new AmplifyError('InvalidStackError', {
              message: `Resource '${groups.LogicalResourceId}' does not have a physical resource ID`,
              resolution:
                'Ensure the stack is in a stable state (not currently being created, updated, or deleted) before running the migration.',
            });
          }

          // Kinesis streams require their ARN to be exposed in CloudFormation outputs.
          // The physical resource ID for Kinesis streams is the stream name, not the ARN.
          if (
            stackResourceWithMatchingLogicalId.ResourceType === 'AWS::Kinesis::Stream' &&
            groups.AttributeName === 'Arn' &&
            !stackResourcePhysicalId.startsWith('arn:aws:kinesis')
          ) {
            throw new AmplifyError('CloudFormationTemplateError', {
              message: `Kinesis stream physical resource ID '${stackResourcePhysicalId}' for logical resource '${groups.LogicalResourceId}' is not a valid ARN.`,
              resolution:
                'Add a CloudFormation output with Fn::GetAtt for the Kinesis stream Arn attribute so the migration can resolve the resource ARN.',
            });
          }

          let replacement = stackResourcePhysicalId;
          if (groups.AttributeName === 'Arn') {
            // Few resources like SQS have their physical ids as their HTTP URLs. We need to construct the arn manually in such cases.
            const resourceId = stackResourcePhysicalId.startsWith('http') ? stackResourcePhysicalId.split('/')[2] : stackResourcePhysicalId;
            replacement =
              this.getResourceArn(stackResourceWithMatchingLogicalId.ResourceType as CFN_RESOURCE_TYPES, resourceId) ??
              stackResourcePhysicalId;
          }
          stackTemplateResourcesString = stackTemplateResourcesString.replaceAll(fnGetAttRegExpPerLogicalId, `"${replacement}"`);
        }
      }
    }
    return stackTemplateResourcesString;
  }

  /**
   * Constructs an ARN for a given resource type and identifier.
   * Returns undefined for unrecognized resource types.
   */
  private getResourceArn(resourceType: CFN_RESOURCE_TYPES, resourceIdentifier: string): string | undefined {
    switch (resourceType) {
      case 'AWS::S3::Bucket':
        return `arn:aws:s3:::${resourceIdentifier}`;
      case 'AWS::DynamoDB::Table':
        return `arn:aws:dynamodb:${this.region}:${this.accountId}:table/${resourceIdentifier}`;
      case 'AWS::Cognito::UserPool':
        return `arn:aws:cognito-idp:${this.region}:${this.accountId}:userpool/${resourceIdentifier}`;
      case 'AWS::IAM::Role':
        return resourceIdentifier.startsWith('arn:aws:iam')
          ? resourceIdentifier
          : `arn:aws:iam::${this.accountId}:role/${resourceIdentifier}`;
      case 'AWS::SQS::Queue':
        return `arn:aws:sqs:${this.region}:${this.accountId}:${resourceIdentifier}`;
      case 'AWS::Lambda::Function':
        return `arn:aws:lambda:${this.region}:${this.accountId}:function:${resourceIdentifier}`;
      case 'AWS::Kinesis::Stream':
        return resourceIdentifier;
      default:
        return undefined;
    }
  }
}

export default CfnOutputResolver;
