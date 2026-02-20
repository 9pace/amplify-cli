import oauthValuesRetriever from '../../../../commands/gen2-migration/refactor/oauth-values-retriever';
import { SSMClient } from '@aws-sdk/client-ssm';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

const INVALID_OAUTH_METADATA_PARAM = 'Invalid Gen1 OAuth provider metadata';
const APP_ID = 'appId';
const ENV_NAME = 'envName';
const USER_POOL_ID = 'userPoolId';

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

  it('should retrieve OAuth values for non-Apple provider', async () => {
    const mockCognitoClient = {
      send: jest.fn().mockResolvedValue({
        IdentityProvider: { ProviderDetails: { client_id: 'google-id', client_secret: 'google-secret' } },
      }),
    } as unknown as CognitoIdentityProviderClient;
    const result = await oauthValuesRetriever({
      appId: APP_ID,
      environmentName: ENV_NAME,
      userPoolId: USER_POOL_ID,
      oAuthParameter: {
        ParameterKey: 'hostedUIProviderMeta',
        ParameterValue: JSON.stringify([{ ProviderName: 'Google' }]),
      },
      ssmClient: new SSMClient(),
      cognitoIdpClient: mockCognitoClient,
    });
    expect(result).toEqual([{ ProviderName: 'Google', client_id: 'google-id', client_secret: 'google-secret' }]);
  });

  it('should retrieve OAuth values for SignInWithApple provider', async () => {
    const mockCognitoClient = {
      send: jest.fn().mockResolvedValue({
        IdentityProvider: { ProviderDetails: { client_id: 'apple-id', team_id: 'TEAM123', key_id: 'KEY456' } },
      }),
    } as unknown as CognitoIdentityProviderClient;
    const mockSsmClient = {
      send: jest.fn().mockResolvedValue({
        Parameter: { Value: 'apple-private-key-content' },
      }),
    } as unknown as SSMClient;
    const result = await oauthValuesRetriever({
      appId: APP_ID,
      environmentName: ENV_NAME,
      userPoolId: USER_POOL_ID,
      oAuthParameter: {
        ParameterKey: 'hostedUIProviderMeta',
        ParameterValue: JSON.stringify([{ ProviderName: 'SignInWithApple' }]),
      },
      ssmClient: mockSsmClient,
      cognitoIdpClient: mockCognitoClient,
    });
    expect(result).toEqual([
      {
        ProviderName: 'SignInWithApple',
        client_id: 'apple-id',
        team_id: 'TEAM123',
        key_id: 'KEY456',
        private_key: 'apple-private-key-content',
      },
    ]);
    expect(mockSsmClient.send).toHaveBeenCalledWith(
      expect.objectContaining({ input: { Name: `/amplify/${APP_ID}/${ENV_NAME}/AMPLIFY_SIWA_PRIVATE_KEY`, WithDecryption: true } }),
    );
  });
});
