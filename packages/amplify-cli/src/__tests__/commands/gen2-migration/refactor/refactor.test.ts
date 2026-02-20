import { isResourceMappingValid, AmplifyMigrationRefactorStep } from '../../../../commands/gen2-migration/refactor/refactor';
import fs from 'fs-extra';
import { Logger } from '../../../../commands/gen2-migration';

jest.mock('fs-extra');

const mockFs = fs as jest.Mocked<typeof fs>;

const VALID_MAPPING = {
  Source: { StackName: 'source-stack', LogicalResourceId: 'MyBucket' },
  Destination: { StackName: 'dest-stack', LogicalResourceId: 'DestBucket' },
};

function createStep(resourceMappings?: string): AmplifyMigrationRefactorStep {
  const logger = new Logger('mock', 'mock', 'mock');
  const context = { parameters: { options: { to: 'gen2-stack', resourceMappings } } } as any;
  const step = new AmplifyMigrationRefactorStep(logger, 'dev', 'myapp', 'app-123', 'gen1-stack', 'us-east-1', context);
  // Set private field so processResourceMappings has something to process
  (step as any).resourceMappings = resourceMappings;
  return step;
}

async function callProcessResourceMappings(step: AmplifyMigrationRefactorStep): Promise<void> {
  return (step as any).processResourceMappings();
}

describe('isResourceMappingValid', () => {
  it('should accept a valid mapping', () => {
    expect(isResourceMappingValid(VALID_MAPPING)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string', 'not-an-object'],
    ['number', 42],
    ['array', [1, 2, 3]],
    ['empty object', {}],
  ])('should reject %s', (_label, input) => {
    expect(isResourceMappingValid(input)).toBe(false);
  });

  it('should reject when Source is missing', () => {
    expect(isResourceMappingValid({ Destination: VALID_MAPPING.Destination })).toBe(false);
  });

  it('should reject when Destination is missing', () => {
    expect(isResourceMappingValid({ Source: VALID_MAPPING.Source })).toBe(false);
  });

  it('should reject when Source is null', () => {
    expect(isResourceMappingValid({ Source: null, Destination: VALID_MAPPING.Destination })).toBe(false);
  });

  it('should reject when Destination is null', () => {
    expect(isResourceMappingValid({ Source: VALID_MAPPING.Source, Destination: null })).toBe(false);
  });

  it('should reject when Source.StackName is missing', () => {
    expect(
      isResourceMappingValid({
        Source: { LogicalResourceId: 'MyBucket' },
        Destination: VALID_MAPPING.Destination,
      }),
    ).toBe(false);
  });

  it('should reject when Source.LogicalResourceId is missing', () => {
    expect(
      isResourceMappingValid({
        Source: { StackName: 'source-stack' },
        Destination: VALID_MAPPING.Destination,
      }),
    ).toBe(false);
  });

  it('should reject when Destination.StackName is missing', () => {
    expect(
      isResourceMappingValid({
        Source: VALID_MAPPING.Source,
        Destination: { LogicalResourceId: 'DestBucket' },
      }),
    ).toBe(false);
  });

  it('should reject when Destination.LogicalResourceId is missing', () => {
    expect(
      isResourceMappingValid({
        Source: VALID_MAPPING.Source,
        Destination: { StackName: 'dest-stack' },
      }),
    ).toBe(false);
  });

  it('should reject when Source.StackName is not a string', () => {
    expect(
      isResourceMappingValid({
        Source: { StackName: 123, LogicalResourceId: 'MyBucket' },
        Destination: VALID_MAPPING.Destination,
      }),
    ).toBe(false);
  });

  it('should reject when Destination.LogicalResourceId is not a string', () => {
    expect(
      isResourceMappingValid({
        Source: VALID_MAPPING.Source,
        Destination: { StackName: 'dest-stack', LogicalResourceId: 42 },
      }),
    ).toBe(false);
  });
});

describe('processResourceMappings', () => {
  afterEach(() => jest.restoreAllMocks());

  it('should throw when path does not start with file://', async () => {
    const step = createStep('/path/to/file.json');
    await expect(callProcessResourceMappings(step)).rejects.toThrow('must start with file://');
  });

  it('should throw when path after file:// is empty', async () => {
    const step = createStep('file://');
    await expect(callProcessResourceMappings(step)).rejects.toThrow('Invalid resource mappings path');
  });

  it('should throw when file does not exist', async () => {
    mockFs.pathExists.mockResolvedValue(false as never);
    const step = createStep('file:///path/to/missing.json');
    await expect(callProcessResourceMappings(step)).rejects.toThrow('Resource mappings file not found');
  });

  it('should throw when file contains invalid JSON', async () => {
    mockFs.pathExists.mockResolvedValue(true as never);
    mockFs.readFile.mockResolvedValue('not json' as never);
    const step = createStep('file:///path/to/bad.json');
    await expect(callProcessResourceMappings(step)).rejects.toThrow('Failed to parse JSON');
  });

  it('should throw when file contains valid JSON but wrong structure', async () => {
    mockFs.pathExists.mockResolvedValue(true as never);
    mockFs.readFile.mockResolvedValue(JSON.stringify([{ bad: 'structure' }]) as never);
    const step = createStep('file:///path/to/wrong.json');
    await expect(callProcessResourceMappings(step)).rejects.toThrow('Invalid resource mappings structure');
  });

  it('should throw ResourceDoesNotExistError on ENOENT race condition', async () => {
    mockFs.pathExists.mockResolvedValue(true as never);
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValue(enoentError as never);
    const step = createStep('file:///path/to/deleted.json');
    await expect(callProcessResourceMappings(step)).rejects.toThrow('Resource mappings file not found');
  });

  it('should parse valid resource mappings successfully', async () => {
    mockFs.pathExists.mockResolvedValue(true as never);
    mockFs.readFile.mockResolvedValue(JSON.stringify([VALID_MAPPING]) as never);
    const step = createStep('file:///path/to/valid.json');
    await callProcessResourceMappings(step);
    expect((step as any).parsedResourceMappings).toEqual([VALID_MAPPING]);
  });
});
