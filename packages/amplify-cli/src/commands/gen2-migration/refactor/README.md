# Refactor Command

The entrypoint is `index.ts`, which exports `AmplifyMigrationRefactorStep` from `refactor.ts`.

## Overview

The `refactor` command moves CloudFormation resources from a Gen1 Amplify stack to a Gen2 stack using the CloudFormation Stack Refactor API. It supports forward migration and rollback.

## Limitations

- Storage refactor supports S3 and DynamoDB
- Auth OAuth providers may fail on deployment after refactor (IdP already exists)
- Data category is not refactored here — it's migrated in the "generate" step

## Command Structure

The refactor command implements `AmplifyMigrationStep` with two operations:

### `execute()`

1. **`extractParameters()`** — reads `--to` (Gen2 destination stack name) from CLI context
2. **`initializeTemplateGenerator('forward')`** — creates AWS clients (CFN, SSM, Cognito, STS), gets account ID, builds `TemplateGenerator`
3. **`templateGenerator.initializeForAssessment()`** — discovers category nested stacks via `discoverCategoryStacks()` in `generators/stack-discovery.ts`
4. **`assessCategories()`** — for each discovered category, retrieves the source template, counts migratable resources, checks for OAuth
5. **`templateGenerator.generateSelectedCategories()`** — runs the refactor pipeline for selected categories

### `rollback()`

1. **`extractParameters()`** — same as execute
2. **`initializeTemplateGenerator('rollback')`** — swaps Gen1/Gen2 stack order
3. **`templateGenerator.rollback()`** — discovers stacks in rollback mode and reverses the refactor

## Architecture

```
refactor.ts (orchestration)
  └── generators/
      ├── stack-discovery.ts        — discovers category stacks in Gen1/Gen2
      ├── template-generator.ts     — pipeline: discover → generate → refactor → rollback
      └── category-template-generator.ts — per-category template manipulation
  └── resolvers/
      ├── cfn-parameter-resolver.ts — resolves Ref to parameter values (incl. AWS::StackName)
      ├── cfn-output-resolver.ts    — resolves Ref/Fn::GetAtt to stack output values
      ├── cfn-dependency-resolver.ts — strips DependsOn edges crossing refactor boundary
      └── cfn-condition-resolver.ts — evaluates CFN conditions and resolves Fn::If
  └── cfn-stack-updater.ts          — UpdateStack + poll for terminal state
  └── cfn-stack-refactor-updater.ts — CreateStackRefactor + ExecuteStackRefactor + poll
  └── oauth-values-retriever.ts     — fetches OAuth credentials from Cognito/SSM
  └── types.ts                      — shared types, enums, interfaces
```

## Pipeline Flow (Forward Migration)

For each category (auth, storage, analytics):

1. **Resolve Gen1 template** (`generateGen1PreProcessTemplate`)
   - Describe stack → validate → filter resources by type
   - Resolve: parameters → outputs → dependencies → conditions
   - Add placeholder resource if all resources are being moved
   - Resolve OAuth credentials if auth category with OAuth

2. **Prepare Gen2 template** (`generateGen2ResourceRemovalTemplate`)
   - Remove Gen2 resources that will be replaced by Gen1 resources
   - Resolve dependencies and output references for removed resources

3. **Generate refactor templates** (`generateStackRefactorTemplates`)
   - Build Gen1→Gen2 logical ID mapping using `MULTI_INSTANCE_MATCHERS`
   - Remove resources from Gen1 template, add to Gen2 template with mapped IDs

4. **Execute refactor** (`tryRefactorStack`)
   - CreateStackRefactor → poll → ExecuteStackRefactor → poll
   - Poll both stacks for terminal state

5. **On failure** — rollback Gen2 stack to pre-refactor template

## Resolver Ordering

The resolvers run in a specific order enforced by data flow (each resolver's output is the next resolver's input):

1. `CfnParameterResolver` — resolves `{"Ref":"ParamName"}` to parameter values
2. `CfnOutputResolver` — resolves `{"Ref":"LogicalId"}` and `{"Fn::GetAtt":[...]}` to stack output values
3. `CfnDependencyResolver` — strips `DependsOn` edges crossing the refactor boundary
4. `CFNConditionResolver` — evaluates conditions and resolves `Fn::If` in properties

## Resource Type Matching

Multi-instance resource types (where Gen1 and Gen2 may have multiple resources of the same type) use explicit matching strategies defined in `MULTI_INSTANCE_MATCHERS`:

| Type | Strategy |
|------|----------|
| `UserPoolClient` | Web↔Web (non-Native), Native↔Native |
| `UserPoolGroup` | Gen2 logical ID contains Gen1 logical ID |
| `IAM::Role` | Gen2 logical ID contains Gen1 logical ID |

Single-instance types match by type alone.

## Supported Categories and Resource Types

Defined in `template-generator.ts:categoryGeneratorConfig`:

| Category | Resource Types |
|----------|---------------|
| auth | UserPool, UserPoolClient, IdentityPool, IdentityPoolRoleAttachment, UserPoolDomain |
| auth-user-pool-group | UserPoolGroup |
| storage | S3::Bucket, DynamoDB::Table |
| analytics | Kinesis::Stream |

## Key Types

- `NON_CUSTOM_RESOURCE_CATEGORY` — enum of known category names
- `CFN_RESOURCE_TYPES` — union of all supported CloudFormation resource type enums
- `CFNTemplate` — typed CloudFormation template structure
- `CategoryRefactorResult` — output of preparing a category for refactoring
- `ResourceMapping` — source/destination stack + logical ID pair for the CFN Refactor API
