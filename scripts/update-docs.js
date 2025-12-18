#!/usr/bin/env node

/**
 * LLM Documentation Updater - MVP
 *
 * Automatically updates documentation when code changes are pushed.
 * Processes single file at a time for MVP.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

// Configuration
const BEDROCK_CONFIG = {
  region: process.env.AWS_REGION || 'us-east-1',
  modelId: process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
};

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Get list of changed TypeScript files in packages/amplify-cli/src/commands/
 */
function getChangedFiles() {
  try {
    // Try to get files from last commit first (most recent changes)
    let output;
    try {
      output = execSync('git diff --name-only HEAD~1 HEAD', {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
      console.log('Using files from last commit (HEAD~1..HEAD)');
    } catch {
      // Fallback to comparing against origin/main
      output = execSync('git diff --name-only origin/main...HEAD', {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });
      console.log('Using files from origin/main...HEAD');
    }

    const files = output
      .split('\n')
      .filter((f) => f.trim())
      .filter((f) => f.startsWith('packages/amplify-cli/src/commands/'))
      .filter((f) => f.endsWith('.ts'));

    console.log(`Found ${files.length} changed TypeScript files in commands/`);

    if (files.length > 0) {
      console.log('Changed files:');
      files.forEach((f) => console.log(`  - ${f}`));
    }

    return files;
  } catch (error) {
    console.error('Failed to get changed files:', error.message);
    process.exit(1);
  }
}

/**
 * Map source file path to documentation file path
 * packages/amplify-cli/src/commands/{path}.ts -> docs/amplify-cli/src/{path}.md
 */
function mapToDocPath(sourceFile) {
  const docPath = sourceFile.replace('packages/amplify-cli/src/commands/', 'docs/amplify-cli/src/').replace('.ts', '.md');

  return docPath;
}

/**
 * Get git diff for a specific file
 */
function getFileDiff(sourceFile) {
  try {
    // Get diff from last commit only (not all changes since main)
    const diff = execSync(`git diff HEAD~1 HEAD -- ${sourceFile}`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    return diff;
  } catch (error) {
    console.error(`Failed to get diff for ${sourceFile}:`, error.message);
    return '';
  }
}

/**
 * Build prompt for Bedrock
 */
function buildPrompt(currentDoc, sourceFile, diff) {
  return `You are updating documentation for AWS Amplify CLI code.

CURRENT DOCUMENTATION:
${currentDoc}

CHANGED FILE: ${sourceFile}

CODE CHANGES (git diff):
${diff}

INSTRUCTIONS:
1. Review the code changes in the diff
2. Determine if the documentation needs to be updated
3. If NO update is needed (e.g., only comments, formatting, or trivial changes), respond with exactly: NO_UPDATE
4. If an update IS needed, provide the COMPLETE UPDATED DOCUMENTATION including:
   - ALL existing content from the current documentation
   - Your updates integrated into the appropriate sections
   - Maintain the same markdown structure and formatting

CRITICAL: You must return the FULL documentation with all existing content preserved. Do not return only the changed sections.

Response (either "NO_UPDATE" or the complete updated documentation):`;
}

/**
 * Call Amazon Bedrock to generate updated documentation
 */
async function callBedrock(currentDoc, sourceFile, diff) {
  const client = new BedrockRuntimeClient({ region: BEDROCK_CONFIG.region });

  const prompt = buildPrompt(currentDoc, sourceFile, diff);

  console.log(`Calling Bedrock (${BEDROCK_CONFIG.modelId})...`);

  try {
    const command = new InvokeModelCommand({
      modelId: BEDROCK_CONFIG.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: BEDROCK_CONFIG.maxTokens,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    const response = await client.send(command);
    const result = JSON.parse(new TextDecoder().decode(response.body));

    // Validate response structure
    if (!result.content?.[0]?.text) {
      throw new Error(`Invalid Bedrock response: ${JSON.stringify(result)}`);
    }

    const text = result.content[0].text.trim();

    // Check for NO_UPDATE
    if (text === 'NO_UPDATE') {
      console.log('✓ LLM determined no update needed');
      return null;
    }

    console.log('✓ LLM generated documentation update');
    return text;
  } catch (error) {
    console.error('Bedrock API call failed:', error.message);
    process.exit(1);
  }
}

/**
 * Write updated documentation to file
 */
function writeDocFile(docPath, content) {
  try {
    const fullPath = path.join(REPO_ROOT, docPath);
    const dir = path.dirname(fullPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, 'utf-8');
    console.log(`✓ Updated ${docPath}`);
  } catch (error) {
    console.error(`Failed to write ${docPath}:`, error.message);
    process.exit(1);
  }
}

/**
 * Commit and push changes
 */
function commitAndPush() {
  try {
    // Configure git
    execSync('git config user.name "GitHub Actions Bot"', { cwd: REPO_ROOT });
    execSync('git config user.email "actions@github.com"', { cwd: REPO_ROOT });

    // Add changes
    execSync('git add docs/', { cwd: REPO_ROOT });

    // Check if there are changes to commit
    try {
      execSync('git diff --cached --exit-code', { cwd: REPO_ROOT });
      console.log('No changes to commit');
      return false;
    } catch {
      // Changes exist, continue with commit
    }

    // Commit
    execSync('git commit -m "docs: auto-update documentation"', { cwd: REPO_ROOT });
    console.log('✓ Created commit');

    // Push (set upstream if needed)
    try {
      execSync('git push', { cwd: REPO_ROOT });
    } catch (error) {
      // Try setting upstream if push failed
      const branch = execSync('git branch --show-current', { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
      execSync(`git push --set-upstream origin ${branch}`, { cwd: REPO_ROOT });
    }
    console.log('✓ Pushed changes');

    return true;
  } catch (error) {
    console.error('Git operation failed:', error.message);
    process.exit(1);
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('=== LLM Documentation Updater ===\n');

  // Step 1: Get changed files
  const changedFiles = getChangedFiles();

  if (changedFiles.length === 0) {
    console.log('No relevant files changed. Exiting.');
    process.exit(0);
  }

  // Step 2: Process first file only (MVP)
  const sourceFile = changedFiles[0];
  console.log(`\nProcessing: ${sourceFile}`);

  // Step 3: Map to documentation file
  const docPath = mapToDocPath(sourceFile);
  console.log(`Documentation file: ${docPath}`);

  // Step 4: Check if doc file exists
  const fullDocPath = path.join(REPO_ROOT, docPath);
  if (!fs.existsSync(fullDocPath)) {
    console.log(`⚠ Documentation file does not exist: ${docPath}`);
    console.log('Skipping. Exiting.');
    process.exit(0);
  }

  // Step 5: Get diff and current doc
  const diff = getFileDiff(sourceFile);
  if (!diff) {
    console.log('No diff found. Exiting.');
    process.exit(0);
  }

  const currentDoc = fs.readFileSync(fullDocPath, 'utf-8');
  console.log(`Current doc size: ${currentDoc.length} characters`);
  console.log(`Diff size: ${diff.length} characters`);

  // Step 6: Call Bedrock
  const updatedDoc = await callBedrock(currentDoc, sourceFile, diff);

  if (updatedDoc === null) {
    console.log('\nNo documentation update needed. Exiting.');
    process.exit(0);
  }

  // Step 7: Write updated documentation
  console.log('\nWriting updated documentation...');
  writeDocFile(docPath, updatedDoc);

  // Step 8: Commit and push
  console.log('\nCommitting changes...');
  const committed = commitAndPush();

  if (committed) {
    console.log('\n✅ Documentation updated successfully!');
  } else {
    console.log('\n✅ Completed (no changes to commit)');
  }
}

// Export functions for testing
module.exports = {
  mapToDocPath,
  buildPrompt,
  getChangedFiles,
  getFileDiff,
};

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}
