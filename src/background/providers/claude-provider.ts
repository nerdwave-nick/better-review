/**
 * Claude Provider - Anthropic Claude AI implementation
 *
 * Implements the AIProvider interface for Anthropic's Claude model.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { PRDiff, ExtensionSettings, FileDiff, ChangesSummaryResponse } from '../../shared/types';
import type { AIProvider, ProviderSuggestion } from './types';
import type { RepoContext } from '../context/types';
import { formatContextForPrompt } from '../context';
import { GEMINI_CONFIG, IGNORE_PATTERNS } from '../../shared/constants';
import { logger, getErrorMessage } from '../../shared/logger';

const TAG = 'Claude';

// Claude model configuration
const CLAUDE_CONFIG = {
  MODEL: 'claude-sonnet-4-5',
  MAX_TOKENS: 8192,
  TEMPERATURE: 0.3,
};

// JSON schema for review response (used in prompt)
const REVIEW_SCHEMA_DESCRIPTION = `{
  "suggestions": [
    {
      "filePath": "string (file path)",
      "lineNumber": "integer (line number in new file)",
      "priority": "high | medium | low",
      "type": "comment | code_change",
      "description": "string (review comment)",
      "suggestedCode": "string (optional, replacement code)",
      "category": "security | performance | style | logic | best_practice | documentation"
    }
  ],
  "summary": "string (brief summary)",
  "overallAssessment": "approve | request_changes | comment"
}`;

interface ReviewContext {
  title: string;
  description: string;
  allFilePaths: string[];
  changesSummary?: string;
}

let anthropic: Anthropic | null = null;
let currentApiKey: string | null = null;

function getClient(apiKey: string): Anthropic {
  if (!anthropic || currentApiKey !== apiKey) {
    anthropic = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    currentApiKey = apiKey;
  }
  return anthropic;
}

function isIgnored(filename: string): boolean {
  return IGNORE_PATTERNS.some(pattern => {
    if (pattern.startsWith('**')) return filename.includes(pattern.slice(2));
    if (pattern.endsWith('**')) return filename.startsWith(pattern.slice(0, -2));
    if (pattern.startsWith('*')) return filename.endsWith(pattern.slice(1));
    if (pattern.endsWith('*')) return filename.startsWith(pattern.slice(0, -1));
    return filename === pattern;
  });
}

function filterFiles(diff: PRDiff): FileDiff[] {
  return (diff.files || []).filter(f => !isIgnored(f.path) && !f.isBinary);
}

async function generateChangesSummary(
  diff: PRDiff,
  filteredFiles: FileDiff[],
  apiKey: string
): Promise<ChangesSummaryResponse> {
  const client = getClient(apiKey);

  const filesOverview = filteredFiles.map(f => {
    const addedLines = f.hunks?.reduce((sum, h) =>
      sum + (h.lines?.filter(l => l.type === 'added').length || 0), 0) || 0;
    const removedLines = f.hunks?.reduce((sum, h) =>
      sum + (h.lines?.filter(l => l.type === 'removed').length || 0), 0) || 0;
    return `- ${f.path} (${f.status}, +${addedLines}/-${removedLines})`;
  }).join('\n');

  const sampleDiff = formatDiffForPrompt(filteredFiles.slice(0, 5));

  const userMessage = `Analyze this PR and provide a concise summary of the changes.

PR Title: ${diff.title || 'Untitled'}
PR Description: ${diff.description || 'No description'}

Files changed (${filteredFiles.length} total):
${filesOverview}

Sample of changes:
${sampleDiff.substring(0, 15000)}

Provide a JSON response with this structure:
{
  "summary": "A brief summary (2-3 sentences) of what this PR accomplishes",
  "keyChanges": ["array of the most important modifications"],
  "potentialConcerns": ["areas that need careful review"]
}

Output valid JSON only, no markdown code blocks.`;

  logger.debug(TAG, 'Generating changes summary (phase 1)');

  const response = await client.messages.create({
    model: CLAUDE_CONFIG.MODEL,
    max_tokens: 2000,
    system: 'You are a senior developer analyzing a PR. Be concise and focus on what matters. Output valid JSON only, no markdown formatting.',
    messages: [{ role: 'user', content: userMessage }],
  });

  const responseText = response.content[0].type === 'text' ? response.content[0].text : '';
  if (!responseText) throw new Error('Empty response from Claude');

  try {
    // Try to extract JSON from response (in case of markdown)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    logger.debug(TAG, 'Changes summary generated', { keyChanges: parsed.keyChanges?.length });
    return parsed;
  } catch {
    return {
      summary: 'PR changes analysis',
      keyChanges: ['Unable to parse detailed changes'],
    };
  }
}

function formatChangesSummaryForContext(summary: ChangesSummaryResponse): string {
  const parts = [
    `Overview: ${summary.summary}`,
    `Key changes: ${summary.keyChanges.join('; ')}`,
  ];
  if (summary.potentialConcerns?.length) {
    parts.push(`Watch for: ${summary.potentialConcerns.join('; ')}`);
  }
  return parts.join('\n');
}

function buildReviewPrompt(
  files: FileDiff[],
  context: ReviewContext,
  settings: ExtensionSettings,
  repoContext?: RepoContext
): string {
  const { strictnessLevel, focusAreas } = settings || {};

  let focusInstructions = '';
  if (focusAreas && !focusAreas.includes('all')) {
    focusInstructions = `Focus on: ${focusAreas.join(', ')}.`;
  }

  let strictnessInstructions = '';
  switch (strictnessLevel) {
    case 'quick':
      strictnessInstructions = 'Only critical bugs/security issues. Max 3 suggestions.';
      break;
    case 'thorough':
      strictnessInstructions = 'Comprehensive review: security, bugs, performance, style, best practices. Provide many suggestions.';
      break;
    default:
      strictnessInstructions = 'Review for bugs, security issues, performance problems, and important best practices.';
  }

  const diffString = formatDiffForPrompt(files);

  let contextSection = `PR Title: ${context.title}
Description: ${context.description.substring(0, 200)}`;

  if (context.changesSummary) {
    contextSection += `

AI Analysis of Full PR:
${context.changesSummary}`;
  } else {
    contextSection += `
All Files in PR: ${context.allFilePaths.join(', ')}`;
  }

  // Add repo context if provided
  let repoContextSection = '';
  if (repoContext) {
    repoContextSection = formatContextForPrompt(repoContext);
    if (repoContextSection) {
      repoContextSection = `\n\nREPOSITORY CONTEXT:\n${repoContextSection}`;
    }
  }

  return `CONTEXT SUMMARY:
${contextSection}${repoContextSection}

INSTRUCTIONS:
Review the following code files which are PART of the PR above.
${strictnessInstructions} ${focusInstructions}

Look for security issues, bugs, performance problems, and best practices.

Write each description like you're talking to a teammate - natural and friendly, not formal. Be specific about what you noticed and why it matters.

${diffString}

Line numbers are prefixed with L (e.g., L42 means lineNumber: 42). Only comment on added (+) or context ( ) lines with line numbers.

Output your response as valid JSON matching this schema:
${REVIEW_SCHEMA_DESCRIPTION}

Output valid JSON only, no markdown code blocks.`;
}

function formatDiffForPrompt(files: FileDiff[]): string {
  if (!files || files.length === 0) {
    return 'No files to review.';
  }

  const lines: string[] = [];
  let totalChars = 0;
  const maxChars = GEMINI_CONFIG.MAX_TOTAL_DIFF_CHARS;
  const maxLinesPerFile = GEMINI_CONFIG.MAX_DIFF_LINES_PER_FILE;
  let truncatedFiles = 0;

  for (const file of files) {
    if (totalChars >= maxChars) {
      truncatedFiles++;
      continue;
    }

    const fileHeader = `\n=== ${file.path} (${file.status}) ===`;
    lines.push(fileHeader);
    totalChars += fileHeader.length;

    if (file.isBinary) {
      lines.push('[binary]');
      continue;
    }

    let fileLinesCount = 0;
    let fileWasTruncated = false;

    for (const hunk of (file.hunks || [])) {
      if (fileLinesCount >= maxLinesPerFile || totalChars >= maxChars) {
        fileWasTruncated = true;
        break;
      }

      for (const line of (hunk.lines || [])) {
        if (fileLinesCount >= maxLinesPerFile || totalChars >= maxChars) {
          fileWasTruncated = true;
          break;
        }

        const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
        const lineNum = line.newLineNumber !== null ? `L${line.newLineNumber}` : '   ';
        const lineStr = `${lineNum} ${prefix} ${line.content}`;
        lines.push(lineStr);
        totalChars += lineStr.length + 1;
        fileLinesCount++;
      }
    }

    if (fileWasTruncated) {
      lines.push('[... truncated for speed ...]');
    }
  }

  if (truncatedFiles > 0) {
    lines.push(`\n[${truncatedFiles} more files omitted for speed]`);
  }

  return lines.join('\n');
}

class StreamingSuggestionParser {
  private buffer = '';
  private onSuggestion: (s: ProviderSuggestion) => void;
  private suggestionCount = 0;
  private emittedSuggestions = new Set<string>();

  constructor(onSuggestion: (s: ProviderSuggestion) => void) {
    this.onSuggestion = onSuggestion;
  }

  process(chunk: string): void {
    this.buffer += chunk;
    this.tryParseSuggestions();
  }

  private tryParseSuggestions() {
    const suggestionsStart = this.buffer.indexOf('"suggestions"');
    if (suggestionsStart === -1) return;

    const arrayStart = this.buffer.indexOf('[', suggestionsStart);
    if (arrayStart === -1) return;

    let depth = 0;
    let inStr = false;
    let isEscaped = false;
    let objStart = -1;

    for (let i = arrayStart + 1; i < this.buffer.length; i++) {
      const char = this.buffer[i];

      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === '\\') {
        isEscaped = true;
        continue;
      }

      if (char === '"') {
        inStr = !inStr;
        continue;
      }

      if (!inStr) {
        if (char === '{') {
          if (depth === 0) objStart = i;
          depth++;
        } else if (char === '}') {
          depth--;
          if (depth === 0 && objStart !== -1) {
            const jsonStr = this.buffer.substring(objStart, i + 1);
            // Create a hash to avoid duplicate emissions
            const hash = this.hashString(jsonStr);
            if (!this.emittedSuggestions.has(hash)) {
              try {
                const suggestion = JSON.parse(jsonStr);
                if (suggestion.filePath && suggestion.description) {
                  this.emittedSuggestions.add(hash);
                  this.emit(suggestion);
                }
              } catch {
                // Invalid JSON, ignore
              }
            }
            objStart = -1;
          }
        }
      }
    }
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString();
  }

  private emit(rawSuggestion: any) {
    this.suggestionCount++;
    const suggestion: ProviderSuggestion = {
      id: `claude_${Date.now()}_${this.suggestionCount}`,
      filePath: rawSuggestion.filePath || '',
      lineNumber: rawSuggestion.lineNumber || 1,
      lineRange: rawSuggestion.lineRange,
      priority: rawSuggestion.priority || 'medium',
      type: rawSuggestion.type || 'comment',
      description: rawSuggestion.description || '',
      suggestedCode: rawSuggestion.suggestedCode,
      category: rawSuggestion.category || 'best_practice',
      providerId: 'claude',
    };
    this.onSuggestion(suggestion);
  }

  getFullResponse(): string {
    return this.buffer;
  }
}

function parseReviewResponse(response: string): { overallAssessment: string } {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { overallAssessment: 'comment' };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return { overallAssessment: parsed.overallAssessment || 'comment' };
  } catch {
    return { overallAssessment: 'comment' };
  }
}

export class ClaudeProvider implements AIProvider {
  name: 'claude' = 'claude';

  isConfigured(settings: ExtensionSettings): boolean {
    return !!settings.claudeApiKey;
  }

  async generateSummary(diff: PRDiff, settings: ExtensionSettings): Promise<ChangesSummaryResponse> {
    const apiKey = settings.claudeApiKey;
    if (!apiKey) throw new Error('Claude API key required');
    const filteredFiles = filterFiles(diff);
    return generateChangesSummary(diff, filteredFiles, apiKey);
  }

  async streamReview(
    diff: PRDiff,
    settings: ExtensionSettings,
    onSuggestion: (suggestion: ProviderSuggestion) => void,
    onSummary: (summary: ChangesSummaryResponse) => void,
    onComplete: (assessment: string) => void,
    onError: (error: string) => void,
    repoContext?: RepoContext,
    existingSummary?: ChangesSummaryResponse
  ): Promise<void> {
    const apiKey = settings.claudeApiKey;

    if (!apiKey) {
      onError('Claude API key is required. Please set it in the extension settings.');
      return;
    }

    const client = getClient(apiKey);
    const filteredFiles = filterFiles(diff);

    if (filteredFiles.length === 0) {
      onComplete('comment');
      return;
    }

    // Phase 1: Generate changes summary (or use existing)
    let changesSummary: ChangesSummaryResponse;
    try {
      if (existingSummary) {
        logger.debug(TAG, 'Using existing summary for review');
        changesSummary = existingSummary;
      } else {
        logger.debug(TAG, `Phase 1: Generating changes summary for ${filteredFiles.length} files`);
        changesSummary = await generateChangesSummary(diff, filteredFiles, apiKey);
        onSummary(changesSummary);
      }
    } catch (error) {
      onError(`Failed to generate changes summary: ${getErrorMessage(error)}`);
      return;
    }

    // Phase 2: Stream the detailed review
    const context: ReviewContext = {
      title: diff.title || 'Untitled',
      description: diff.description || '',
      allFilePaths: diff.files?.map(f => f.path) || [],
      changesSummary: formatChangesSummaryForContext(changesSummary),
    };

    const userMessage = buildReviewPrompt(filteredFiles, context, settings, repoContext);
    const parser = new StreamingSuggestionParser(onSuggestion);

    try {
      logger.debug(TAG, 'Starting streaming API request');

      const stream = client.messages.stream({
        model: CLAUDE_CONFIG.MODEL,
        max_tokens: CLAUDE_CONFIG.MAX_TOKENS,
        system: 'You are a senior developer doing a code review. Write descriptions in a natural, conversational tone. No greetings, no "Hey", no "Hi" - just get straight to the point. Avoid formal headers or bullet points. Be helpful and specific. Output valid JSON only, no markdown code blocks. Start outputting suggestions immediately.',
        messages: [{ role: 'user', content: userMessage }],
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          parser.process(event.delta.text);
        }
      }

      // Parse final assessment from complete response
      try {
        const parsed = parseReviewResponse(parser.getFullResponse());
        onComplete(parsed.overallAssessment);
      } catch {
        onComplete('comment');
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logger.error(TAG, 'API error:', errorMessage);

      if (errorMessage.includes('invalid_api_key') || errorMessage.includes('authentication')) {
        onError('Invalid Claude API key. Please check your API key in settings.');
      } else if (errorMessage.includes('rate_limit') || errorMessage.includes('429')) {
        onError('API rate limit exceeded. Please try again later.');
      } else {
        onError(`Review failed: ${errorMessage}`);
      }
    }
  }

  async generatePRDescription(
    diffText: string,
    template: string,
    apiKey: string
  ): Promise<string> {
    const client = getClient(apiKey);

    const systemPrompt = `You are a senior developer writing a brief PR description. Fill in the template based on the code changes.

Guidelines:
- Be very concise - use short bullet points (5-10 words each)
- Maximum 2-3 bullets per section
- Skip sections that don't apply
- No verbose explanations, just the essentials`;

    const userPrompt = `Here is the PR template to fill in:

${template || `## Summary
<!-- Briefly describe what this PR does -->

## Changes
<!-- List the main changes -->

## Testing
<!-- How was this tested? -->
`}

Here is the diff of the changes:

\`\`\`diff
${diffText.substring(0, 50000)}
\`\`\`

Please fill in the template based on the code changes. Output ONLY the filled template, no additional commentary.`;

    logger.debug(TAG, 'Generating PR description');

    const response = await client.messages.create({
      model: CLAUDE_CONFIG.MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const responseText = response.content[0].type === 'text' ? response.content[0].text : '';
    if (!responseText) throw new Error('Empty response from Claude');

    return responseText.trim();
  }
}

// Export singleton instance
export const claudeProvider = new ClaudeProvider();

// Standalone function for generating PR descriptions
export async function generatePRDescription(
  diffText: string,
  template: string,
  apiKey: string
): Promise<string> {
  return claudeProvider.generatePRDescription(diffText, template, apiKey);
}
