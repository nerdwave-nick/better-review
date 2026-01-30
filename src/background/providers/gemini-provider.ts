/**
 * Gemini Provider - Google Gemini AI implementation
 *
 * Implements the AIProvider interface for Google's Gemini model.
 * Migrated to use Vercel AI SDK (@ai-sdk/google).
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, generateText } from 'ai';
import type { PRDiff, ExtensionSettings, FileDiff, ChangesSummaryResponse } from '../../shared/types';
import type { AIProvider, ProviderSuggestion } from './types';
import type { RepoContext } from '../context/types';
import { formatContextForPrompt } from '../context';
import { GEMINI_CONFIG, LOG_TAGS, IGNORE_PATTERNS } from '../../shared/constants';
import { logger, getErrorMessage } from '../../shared/logger';

const TAG = LOG_TAGS.GEMINI;

// Schema description for prompt (since we are using text generation with JSON instruction)
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

const CHANGES_SUMMARY_SCHEMA_DESCRIPTION = `{
  "summary": "string (concise summary of PR)",
  "keyChanges": ["string (list of key changes)"],
  "potentialConcerns": ["string (areas to watch)"]
}`;

interface ReviewContext {
  title: string;
  description: string;
  allFilePaths: string[];
  changesSummary?: string;
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
  const google = createGoogleGenerativeAI({ apiKey });
  const model = google(GEMINI_CONFIG.MODEL);

  const filesOverview = filteredFiles.map(f => {
    const addedLines = f.hunks?.reduce((sum, h) =>
      sum + (h.lines?.filter(l => l.type === 'added').length || 0), 0) || 0;
    const removedLines = f.hunks?.reduce((sum, h) =>
      sum + (h.lines?.filter(l => l.type === 'removed').length || 0), 0) || 0;
    return `- ${f.path} (${f.status}, +${addedLines}/-${removedLines})`;
  }).join('\n');

  const sampleDiff = formatDiffForPrompt(filteredFiles.slice(0, 5));

  const prompt = `Analyze this PR and provide a concise summary of the changes.

PR Title: ${diff.title || 'Untitled'}
PR Description: ${diff.description || 'No description'}

Files changed (${filteredFiles.length} total):
${filesOverview}

Sample of changes:
${sampleDiff.substring(0, 15000)}

Provide a JSON response with this structure:
${CHANGES_SUMMARY_SCHEMA_DESCRIPTION}

Output valid JSON only.`;

  logger.debug(TAG, 'Generating changes summary (phase 1)');

  try {
    const { text } = await generateText({
      model,
      system: 'You are a senior developer analyzing a PR. Be concise and focus on what matters. Output valid JSON only.',
      prompt,
      temperature: 0.2,
      maxOutputTokens: 2000,
    });

    const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanText);
    logger.debug(TAG, 'Changes summary generated', { keyChanges: parsed.keyChanges?.length });
    return parsed;
  } catch (error) {
    logger.warn(TAG, 'Failed to parse summary JSON', error);
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

Output valid JSON only. Start outputting suggestions immediately.`;
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
  private onHallucinationError: (error: string) => void;
  private suggestionCount = 0;
  private lastChunks: string[] = [];
  // private hallucinationDetected = false;

  constructor(
    onSuggestion: (s: ProviderSuggestion) => void,
    onHallucinationError: (error: string) => void
  ) {
    this.onSuggestion = onSuggestion;
    this.onHallucinationError = onHallucinationError;
  }

  process(chunk: string): boolean {
    if (this.detectHallucination(chunk)) {
      // this.hallucinationDetected = true;
      return false;
    }

    this.buffer += chunk;
    this.tryParseSuggestions();
    return true;
  }

  private detectHallucination(chunk: string): boolean {
    const longNumberMatch = chunk.match(/\d{15,}/);
    if (longNumberMatch) {
      logger.warn(TAG, 'Hallucination detected: runaway number generation', longNumberMatch[0].substring(0, 50));
      this.onHallucinationError('Model hallucination detected (runaway numbers). Review stopped.');
      return true;
    }

    this.lastChunks.push(chunk);
    if (this.lastChunks.length > GEMINI_CONFIG.MAX_CONSECUTIVE_REPEATS) {
      this.lastChunks.shift();
    }

    if (this.lastChunks.length >= 20) {
      const recentChunks = this.lastChunks.slice(-20);
      const uniqueChunks = new Set(recentChunks);
      if (uniqueChunks.size === 1 && recentChunks[0].length > 0) {
        logger.warn(TAG, 'Hallucination detected: repeated chunks', recentChunks[0]);
        this.onHallucinationError('Model hallucination detected (repeated output). Review stopped.');
        return true;
      }
    }

    return false;
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
    let foundObjects = 0;

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
            foundObjects++;

            if (foundObjects > this.suggestionCount) {
              const jsonStr = this.buffer.substring(objStart, i + 1);
              try {
                const suggestion = JSON.parse(jsonStr);
                if (suggestion.filePath && suggestion.description) {
                  this.emit(suggestion);
                }
              } catch (e) {
                // Invalid JSON, ignore
              }
            }
            objStart = -1;
          }
        }
      }
    }
  }

  private emit(rawSuggestion: any) {
    this.suggestionCount++;
    const suggestion: ProviderSuggestion = {
      id: `gemini_${Date.now()}_${this.suggestionCount}`,
      filePath: rawSuggestion.filePath || '',
      lineNumber: rawSuggestion.lineNumber || 1,
      lineRange: rawSuggestion.lineRange,
      priority: rawSuggestion.priority || 'medium',
      type: rawSuggestion.type || 'comment',
      description: rawSuggestion.description || '',
      suggestedCode: rawSuggestion.suggestedCode,
      category: rawSuggestion.category || 'best_practice',
      providerId: 'gemini',
    };
    this.onSuggestion(suggestion);
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

export class GeminiProvider implements AIProvider {
  name: 'gemini' = 'gemini';

  isConfigured(settings: ExtensionSettings): boolean {
    return !!settings.geminiApiKey;
  }

  async generateSummary(diff: PRDiff, settings: ExtensionSettings): Promise<ChangesSummaryResponse> {
    const apiKey = settings.geminiApiKey;
    if (!apiKey) throw new Error('Gemini API key required');
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
    const apiKey = settings.geminiApiKey;

    if (!apiKey) {
      onError('Gemini API key is required. Please set it in the extension settings.');
      return;
    }

    const google = createGoogleGenerativeAI({ apiKey });
    const model = google(GEMINI_CONFIG.MODEL);

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

    const prompt = buildReviewPrompt(filteredFiles, context, settings, repoContext);
    let hallucinationError: string | null = null;
    const parser = new StreamingSuggestionParser(
      onSuggestion,
      (error) => { hallucinationError = error; }
    );

    try {
      logger.debug(TAG, 'Starting streaming API request');

      const result = streamText({
        model,
        system: 'You are a senior developer doing a code review. Write descriptions in a natural, conversational tone. No greetings, no "Hey", no "Hi" - just get straight to the point. Avoid formal headers or bullet points. Be helpful and specific. Output valid JSON only. Start outputting suggestions immediately.',
        prompt,
        temperature: GEMINI_CONFIG.TEMPERATURE,
        maxOutputTokens: GEMINI_CONFIG.MAX_OUTPUT_TOKENS,
      });

      let fullText = '';

      for await (const chunk of result.textStream) {
        fullText += chunk;
        const shouldContinue = parser.process(chunk);

        if (!shouldContinue || hallucinationError) {
          logger.warn(TAG, 'Stopping stream due to hallucination detection');
          onError(hallucinationError || 'Model hallucination detected. Review stopped.');
          return;
        }
      }

      try {
        const parsed = parseReviewResponse(fullText);
        onComplete(parsed.overallAssessment);
      } catch {
        onComplete('comment');
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Unknown error');
    }
  }
}

// Export singleton instance
export const geminiProvider = new GeminiProvider();
