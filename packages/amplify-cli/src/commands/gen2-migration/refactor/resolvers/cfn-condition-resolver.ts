import {
  CFNConditionFunction,
  CFNConditionFunctionStatement,
  CFNFunction,
  CFNIntrinsicFunctionCondition,
  CFNResource,
  CFNTemplate,
} from '../types';
import { Parameter } from '@aws-sdk/client-cloudformation';
import { AmplifyError } from '@aws-amplify/amplify-cli-core';

/**
 * Class to resolve conditions in a CloudFormation template.
 * This is needed prior to a stack refactor since same conditions and params are not present in Gen1 and Gen2 stacks
 * and the resource being moved needs to have its condition resolved.
 */
class CFNConditionResolver {
  private readonly conditions: Record<string, CFNConditionFunction> | undefined;
  constructor(private readonly template: CFNTemplate) {
    this.conditions = template.Conditions;
  }

  public resolve(parameters: Parameter[]) {
    if (!this.conditions || Object.keys(this.conditions).length === 0) return this.template;

    const clonedTemplate = JSON.parse(JSON.stringify(this.template)) as CFNTemplate;
    const conditionValueMap = new Map<string, boolean>();
    Object.entries(this.conditions).forEach(([conditionKey, conditionValue]) => {
      const fnType = Object.keys(conditionValue)[0];
      if (Object.values(CFNFunction).includes(fnType as CFNFunction)) {
        const conditionStatements = conditionValue[fnType as keyof CFNConditionFunction] as CFNConditionFunctionStatement[];
        const result = this.resolveCondition(conditionStatements[0], conditionStatements[1], parameters, fnType as CFNFunction);
        conditionValueMap.set(conditionKey, result);
      }
    });

    this.resolveConditionInResources(clonedTemplate.Resources, conditionValueMap);

    return clonedTemplate;
  }

  private resolveCondition(
    leftStatement: CFNConditionFunctionStatement,
    rightStatement: CFNConditionFunctionStatement | undefined,
    params: Parameter[],
    fnType: CFNFunction,
  ): boolean {
    const resolvedLeft = this.resolveStatement(leftStatement, params);
    const resolvedRight = this.resolveStatement(rightStatement, params);

    switch (fnType) {
      case CFNFunction.Equals:
        return resolvedLeft === resolvedRight;
      case CFNFunction.Not:
        return !resolvedLeft;
      case CFNFunction.Or:
        return !!(resolvedLeft || resolvedRight);
      case CFNFunction.And:
        return !!(resolvedLeft && resolvedRight);
      default:
        // Internal assertion — unsupported CFN function type, not user-facing
        throw new Error(`Invalid ${fnType} condition`);
    }
  }

  /**
   * Resolves a single condition function statement to a primitive value.
   * Accepts undefined because Fn::Not has a single operand (no right statement).
   */
  private resolveStatement(statement: CFNConditionFunctionStatement | undefined, params: Parameter[]): boolean | string | undefined {
    if (statement === undefined || typeof statement !== 'object') {
      return statement as boolean | string | undefined;
    }

    // Nested condition reference: { Condition: "SomeCondName" }
    if ('Condition' in statement) {
      const name = (statement as CFNIntrinsicFunctionCondition).Condition;
      // this.conditions! is safe: resolve() returns early when conditions is falsy,
      // and resolveStatement is only reachable through resolve() → resolveCondition().
      const nested = this.conditions![name];
      const fnType = Object.keys(nested)[0] as CFNFunction;
      const operands = nested[fnType as keyof CFNConditionFunction] as CFNConditionFunctionStatement[];
      return this.resolveCondition(operands[0], operands[1], params, fnType);
    }

    // Nested CFN function: { "Fn::Equals": [...] }
    const firstKey = Object.keys(statement)[0];
    if (Object.values(CFNFunction).includes(firstKey as CFNFunction)) {
      const fnType = firstKey as CFNFunction;
      const operands = (statement as CFNConditionFunction)[fnType as keyof CFNConditionFunction] as CFNConditionFunctionStatement[];
      return this.resolveCondition(operands[0], operands[1], params, fnType);
    }

    // Parameter ref: { Ref: "ParamName" }
    if ('Ref' in statement) {
      const parameterKey = (statement as { Ref: string }).Ref;
      const value = params.find((p) => p.ParameterKey === parameterKey)?.ParameterValue;
      if (!value) {
        throw new AmplifyError('CloudFormationTemplateError', {
          message: `Parameter '${parameterKey}' referenced in condition could not be resolved`,
          resolution: 'Ensure all parameters referenced in CloudFormation conditions have values in the stack parameters.',
        });
      }
      return value;
    }

    throw new AmplifyError('CloudFormationTemplateError', {
      message: `Unsupported intrinsic function '${Object.keys(statement)[0]}' in condition expression`,
      resolution:
        'This CloudFormation condition uses a function that the migration tool does not support. ' +
        'Supported functions: Fn::Equals, Fn::Not, Fn::Or, Fn::And, Fn::If, Ref, and Condition references.',
    });
  }

  private resolveConditionInResources(resources: Record<string, CFNResource>, conditionValueMap: Map<string, boolean>) {
    Object.entries(resources).forEach(([logicalId, value]) => {
      const condition = value.Condition;
      if (condition && conditionValueMap.has(condition)) {
        const result = conditionValueMap.get(condition);
        // delete resources from template that have unmet condition
        if (!result) {
          delete resources[logicalId];
        }
      }
      const props = value.Properties;
      Object.entries(props).forEach(([propName, propValue]) => {
        if (Array.isArray(propValue)) {
          propValue.forEach((item, index) => {
            if (typeof item === 'object') {
              propValue[index] = this.resolveIfCondition(item, conditionValueMap);
            }
          });
        } else if (typeof propValue === 'object') {
          props[propName] = this.resolveIfCondition(propValue, conditionValueMap);
        }
      });
    });
    return resources;
  }

  private resolveIfCondition(propValue: object, conditionValueMap: Map<string, boolean>) {
    let result = propValue;
    if (CFNFunction.If in propValue) {
      const ifCondition = propValue[CFNFunction.If] as [string, object, object];
      const conditionName = ifCondition[0];
      if (conditionValueMap.has(conditionName)) {
        const conditionValue = conditionValueMap.get(conditionName);
        result = conditionValue ? ifCondition[1] : ifCondition[2];
      }
    }
    return result;
  }
}

export default CFNConditionResolver;
