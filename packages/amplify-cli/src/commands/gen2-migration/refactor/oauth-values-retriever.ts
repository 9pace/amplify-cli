import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { CognitoIdentityProviderClient, DescribeIdentityProviderCommand } from '@aws-sdk/client-cognito-identity-provider';
import { Parameter } from '@aws-sdk/client-cloudformation';
import { HostedUIProviderMeta, OAuthClient } from './types';
import { AmplifyError } from '@aws-amplify/amplify-cli-core';

const INVALID_OAUTH_GEN1_PROVIDER_METADATA_ERROR = 'Invalid Gen1 OAuth provider metadata';

const isHostedProviderMetadata = (parsedValue: unknown): parsedValue is HostedUIProviderMeta => {
  return typeof parsedValue === 'object' && parsedValue !== null && 'ProviderName' in parsedValue;
};

export const constructSignInWithApplePrivateKeyParamName = (appId: string, environment: string): string => {
  return `/amplify/${appId}/${environment}/AMPLIFY_SIWA_PRIVATE_KEY`;
};

type RetrieveOAuthValuesParameters = {
  ssmClient: SSMClient;
  cognitoIdpClient: CognitoIdentityProviderClient;
  oAuthParameter: Parameter;
  userPoolId: string;
  appId: string;
  environmentName: string;
};
/**
 * Retrieves OAuth values from Cognito and SSM
 * @param ssmClient
 * @param cognitoIdpClient
 * @param oAuthParameter
 * @param userPoolId
 * @param appId
 * @param environmentName
 * @returns OAuthClient[]
 */
const retrieveOAuthValues = async ({
  ssmClient,
  cognitoIdpClient,
  oAuthParameter,
  userPoolId,
  appId,
  environmentName,
}: RetrieveOAuthValuesParameters) => {
  const value = oAuthParameter.ParameterValue;
  if (!value) {
    throw new AmplifyError('InvalidStackError', {
      message: `OAuth parameter '${oAuthParameter.ParameterKey}' has no value`,
      resolution: 'Ensure the Gen1 stack has a valid hostedUIProviderMeta parameter with OAuth provider configurations.',
    });
  }
  const parsedValue = JSON.parse(value);
  if (!Array.isArray(parsedValue) || parsedValue.length === 0) {
    throw new AmplifyError('InputValidationError', {
      message: INVALID_OAUTH_GEN1_PROVIDER_METADATA_ERROR,
      resolution: 'Verify your Gen1 hostedUIProviderMeta parameter contains a valid JSON array of OAuth provider configurations.',
    });
  }

  const oAuthClientValues: OAuthClient[] = [];
  for (const provider of parsedValue) {
    if (!isHostedProviderMetadata(provider)) {
      throw new AmplifyError('InputValidationError', {
        message: INVALID_OAUTH_GEN1_PROVIDER_METADATA_ERROR,
        resolution: 'Each OAuth provider entry must include a ProviderName field. Check your Gen1 hostedUIProviderMeta parameter.',
      });
    }

    const { ProviderName } = provider;
    const { IdentityProvider } = await cognitoIdpClient.send(
      new DescribeIdentityProviderCommand({
        UserPoolId: userPoolId,
        ProviderName,
      }),
    );
    const providerDetails = IdentityProvider?.ProviderDetails;
    if (!providerDetails) {
      throw new AmplifyError('InvalidStackError', {
        message: `Cognito returned no provider details for '${ProviderName}'`,
        resolution: `Verify the identity provider '${ProviderName}' is correctly configured in your Cognito User Pool.`,
      });
    }
    const { client_id, client_secret, team_id, key_id } = providerDetails;
    if (!client_id) {
      throw new AmplifyError('InvalidStackError', {
        message: `Missing client_id for OAuth provider '${ProviderName}'`,
        resolution: `Verify the identity provider '${ProviderName}' has a client_id configured in your Cognito User Pool.`,
      });
    }
    if (ProviderName === 'SignInWithApple') {
      if (!team_id) {
        throw new AmplifyError('InvalidStackError', {
          message: `Missing team_id for OAuth provider '${ProviderName}'`,
          resolution: `Verify the Sign in with Apple provider has a team_id configured in your Cognito User Pool.`,
        });
      }
      if (!key_id) {
        throw new AmplifyError('InvalidStackError', {
          message: `Missing key_id for OAuth provider '${ProviderName}'`,
          resolution: `Verify the Sign in with Apple provider has a key_id configured in your Cognito User Pool.`,
        });
      }
      // Retrieve private key
      const ssmParamName = constructSignInWithApplePrivateKeyParamName(appId, environmentName);
      const { Parameter: PrivateKeyParameter } = await ssmClient.send(
        new GetParameterCommand({
          Name: ssmParamName,
          WithDecryption: true,
        }),
      );
      const privateKey = PrivateKeyParameter?.Value;
      if (!privateKey) {
        throw new AmplifyError('InvalidStackError', {
          message: `Failed to retrieve Sign in with Apple private key from SSM parameter '${ssmParamName}'`,
          resolution:
            'Ensure the SSM parameter exists and contains the private key value. You can verify with: aws ssm get-parameter --name "' +
            ssmParamName +
            '" --with-decryption',
        });
      }
      oAuthClientValues.push({
        ProviderName,
        client_id,
        team_id,
        key_id,
        private_key: privateKey,
      });
    } else {
      if (!client_secret) {
        throw new AmplifyError('InvalidStackError', {
          message: `Missing client_secret for OAuth provider '${ProviderName}'`,
          resolution: `Verify the identity provider '${ProviderName}' has a client_secret configured in your Cognito User Pool.`,
        });
      }
      oAuthClientValues.push({
        ProviderName,
        client_id,
        client_secret,
      });
    }
  }
  return oAuthClientValues;
};

export default retrieveOAuthValues;
