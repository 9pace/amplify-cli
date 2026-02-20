import oauthValuesRetriever from '../../../../commands/gen2-migration/refactor/oauth-values-retriever';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

const INVALID_OAUTH_METADATA_PARAM = 'Invalid Gen1 OAuth provider metadata';
const APP_ID = 'appId';
const ENV_NAME = 'envName';
const USER_POOL_ID = 'userPoolId';

// This test suite covers negative cases. Happy path cases are covered in its consumer (category-template-generator.test.ts)
describe('OAuthValuesRetriever', () => {
  it('should fail if the oauth param is not an array', async () => {
    await expect(
      oauthValuesRetriever({
        appId: APP_ID,
        environmentName: ENV_NAME,
        userPoolId: USER_POOL_ID,
        oAuthParameter: {
          ParameterKey: 'hostedUIProviderMeta',
          ParameterValue: JSON.stringify({}),
        },
        ssmClient: new SSMClient(),
        cognitoIdpClient: new CognitoIdentityProviderClient(),
      }),
    ).rejects.toThrowError(INVALID_OAUTH_METADATA_PARAM);
  });
  it('should fail if the oauth param does not have provider info', async () => {
    await expect(
      oauthValuesRetriever({
        appId: APP_ID,
        environmentName: ENV_NAME,
        userPoolId: USER_POOL_ID,
        oAuthParameter: {
          ParameterKey: 'hostedUIProviderMeta',
          ParameterValue: JSON.stringify([{}]),
        },
        ssmClient: new SSMClient(),
        cognitoIdpClient: new CognitoIdentityProviderClient(),
      }),
    ).rejects.toThrowError(INVALID_OAUTH_METADATA_PARAM);
  });
});

it('should throw InvalidStackError when OAuth parameter has no value', async () => {
  await expect(
    oauthValuesRetriever({
      appId: APP_ID,
      environmentName: ENV_NAME,
      userPoolId: USER_POOL_ID,
      oAuthParameter: {
        ParameterKey: 'hostedUIProviderMeta',
        ParameterValue: undefined,
      },
      ssmClient: new SSMClient(),
      cognitoIdpClient: new CognitoIdentityProviderClient(),
    }),
  ).rejects.toThrow("OAuth parameter 'hostedUIProviderMeta' has no value");
});

it('should throw InvalidStackError when Cognito returns no provider details', async () => {
  const mockCognitoClient = {
    send: jest.fn().mockResolvedValue({ IdentityProvider: { ProviderDetails: undefined } }),
  } as unknown as CognitoIdentityProviderClient;
  await expect(
    oauthValuesRetriever({
      appId: APP_ID,
      environmentName: ENV_NAME,
      userPoolId: USER_POOL_ID,
      oAuthParameter: {
        ParameterKey: 'hostedUIProviderMeta',
        ParameterValue: JSON.stringify([{ ProviderName: 'Google' }]),
      },
      ssmClient: new SSMClient(),
      cognitoIdpClient: mockCognitoClient,
    }),
  ).rejects.toThrow("Cognito returned no provider details for 'Google'");
});
