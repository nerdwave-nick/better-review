/**
 * Gemini Service - Direct API Key Authentication
 *
 * Handles AI code review requests using Google's Gemini model.
 * Migrated to use Vercel AI SDK (@ai-sdk/google).
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText, streamText } from 'ai';
import type { PRDiff, ReviewResponse, ExtensionSettings, ReviewSuggestion, FileDiff } from '../shared/types';
import { GEMINI_CONFIG, LOG_TAGS, IGNORE_PATTERNS } from '../shared/constants';
import { logger, getErrorMessage } from '../shared/logger';

const TAG = LOG_TAGS.GEMINI;

// Schema descriptions for prompt instructions
const REVIEW_RESPONSE_SCHEMA_DESC = `{
  "suggestions": [
    {
      "filePath": "string",
      "lineNumber": "integer",
      "priority": "high | medium | low",
      "type": "comment | code_change",
      "description": "string",
      "suggestedCode": "string",
      "category": "security | performance | style | logic | best_practice | documentation"
    }
  ],
  "summary": "string",
  "overallAssessment": "approve | request_changes | comment"
}`;

const CHANGES_SUMMARY_SCHEMA_DESC = `{
  "summary": "string (concise summary)",
  "keyChanges": ["string (list of key changes)"],
  "potentialConcerns": ["string (areas to watch)"]
}`;

interface ReviewContext {
  title: string;
  description: string;
  allFilePaths: string[];
  /** AI-generated summary of all changes (from phase 1) */
  changesSummary?: string;
}

export interface ChangesSummaryResponse {
  summary: string;
  keyChanges: string[];
  potentialConcerns?: string[];
}

/**
 * Check if a file should be ignored
 */
function isIgnored(filename: string): boolean {
  return IGNORE_PATTERNS.some(pattern => {
    if (pattern.startsWith('**')) return filename.includes(pattern.slice(2));
    if (pattern.endsWith('**')) return filename.startsWith(pattern.slice(0, -2));
    if (pattern.startsWith('*')) return filename.endsWith(pattern.slice(1));
    if (pattern.endsWith('*')) return filename.startsWith(pattern.slice(0, -1));
    return filename === pattern;
  });
}

/**
 * Filter out ignored and binary files
 */
function filterFiles(diff: PRDiff): FileDiff[] {
  return (diff.files || []).filter(f => !isIgnored(f.path) && !f.isBinary);
}

/**
 * Phase 1: Generate a high-level summary of all changes
 * This is used as context for the detailed review requests
 */
async function generateChangesSummary(
  diff: PRDiff,
  filteredFiles: FileDiff[],
  apiKey: string
): Promise<ChangesSummaryResponse> {
  const google = createGoogleGenerativeAI({ apiKey });
  const model = google(GEMINI_CONFIG.MODEL);

  // Build a condensed view of all files for the summary
  const filesOverview = filteredFiles.map(f => {
    const addedLines = f.hunks?.reduce((sum, h) =>
      sum + (h.lines?.filter(l => l.type === 'added').length || 0), 0) || 0;
    const removedLines = f.hunks?.reduce((sum, h) =>
      sum + (h.lines?.filter(l => l.type === 'removed').length || 0), 0) || 0;
    return `- ${f.path} (${f.status}, +${addedLines}/-${removedLines})`;
  }).join('\n');

  // Include a sample of the actual changes (first few files, truncated)
  const sampleDiff = formatDiffForPrompt(filteredFiles.slice(0, 5));

  const prompt = `Analyze this PR and provide a concise summary of the changes.

PR Title: ${diff.title || 'Untitled'}
PR Description: ${diff.description || 'No description'}

Files changed (${filteredFiles.length} total):
${filesOverview}

Sample of changes:
${sampleDiff.substring(0, 15000)}

Provide a JSON response with this structure:
${CHANGES_SUMMARY_SCHEMA_DESC}

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

/**
 * Request a code review from Gemini (non-streaming)
 */
export async function requestReview(
  diff: PRDiff,
  settings: ExtensionSettings
): Promise<ReviewResponse> {
  const apiKey = settings.geminiApiKey;

  if (!apiKey) {
    throw new Error('Gemini API key is required. Please set it in the extension settings.');
  }

  const google = createGoogleGenerativeAI({ apiKey });
  const model = google(GEMINI_CONFIG.MODEL);

  const filteredFiles = filterFiles(diff);

  if (filteredFiles.length === 0) {
    return {
      suggestions: [],
      summary: "No files to review (all files were ignored or binary).",
      overallAssessment: 'comment',
      reviewedAt: new Date().toISOString(),
    };
  }

  try {
    // === PHASE 1: Generate changes summary (direct call) ===
    logger.debug(TAG, `Phase 1: Generating changes summary for ${filteredFiles.length} files`);
    const changesSummary = await generateChangesSummary(diff, filteredFiles, apiKey);

    // Build context with the AI-generated summary
    const context: ReviewContext = {
      title: diff.title || 'Untitled',
      description: diff.description || '',
      allFilePaths: diff.files?.map(f => f.path) || [],
      changesSummary: formatChangesSummaryForContext(changesSummary),
    };

    // === PHASE 2: Single review request with enriched context ===
    logger.debug(TAG, `Phase 2: Starting review for ${filteredFiles.length} files`);
    const prompt = buildReviewPrompt(filteredFiles, context, settings);

    const { text } = await generateText({
      model,
      system: 'You are a senior developer doing a code review. Write descriptions in a natural, conversational tone. Output valid JSON only.',
      prompt,
      temperature: GEMINI_CONFIG.TEMPERATURE,
      maxOutputTokens: GEMINI_CONFIG.MAX_OUTPUT_TOKENS,
    });

    const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const review = parseReviewResponse(cleanText);

    // Use the AI-generated summary from phase 1
    review.summary = changesSummary.summary;

    logger.debug(TAG, 'Two-phase review completed', {
      totalSuggestions: review.suggestions.length,
      assessment: review.overallAssessment,
    });

    return review;

  } catch (error: unknown) {
    handleGeminiError(error);
    throw error;
  }
}

/**
 * Request a code review from Gemini with streaming suggestions
 */
export async function requestReviewStream(
  diff: PRDiff,
  settings: ExtensionSettings,
  onSuggestion: (suggestion: ReviewSuggestion) => void,
  onComplete: (summary: string, assessment: string) => void,
  onError: (error: string) => void,
  onSummary?: (summary: ChangesSummaryResponse) => void
): Promise<void> {
  const apiKey = settings.geminiApiKey;

  if (!apiKey) {
    onError('Gemini API key is required. Please set it in the extension settings.');
    return;
  }

  const google = createGoogleGenerativeAI({ apiKey });
  const model = google(GEMINI_CONFIG.MODEL);

  const filteredFiles = (diff.files || []).filter(f => !isIgnored(f.path) && !f.isBinary);

  if (filteredFiles.length === 0) {
    onComplete('No files to review.', 'comment');
    return;
  }

  // === Phase 1: Always generate changes summary first ===
  let changesSummary: ChangesSummaryResponse;
  try {
    logger.debug(TAG, `Phase 1: Generating changes summary for ${filteredFiles.length} files`);
    changesSummary = await generateChangesSummary(diff, filteredFiles, apiKey);

    // Send summary immediately so UI can show it while Phase 2 streams
    if (onSummary) {
      onSummary(changesSummary);
    }
  } catch (error) {
    onError(`Failed to generate changes summary: ${getErrorMessage(error)}`);
    return;
  }

  // === Phase 2: Stream the detailed review ===
  const context: ReviewContext = {
    title: diff.title || 'Untitled',
    description: diff.description || '',
    allFilePaths: diff.files?.map(f => f.path) || [],
    changesSummary: formatChangesSummaryForContext(changesSummary),
  };

  const prompt = buildReviewPrompt(filteredFiles, context, settings);
  let hallucinationError: string | null = null;
  const parser = new StreamingSuggestionParser(
    onSuggestion,
    (error) => {
      hallucinationError = error;
    }
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
      onComplete(changesSummary.summary, parsed.overallAssessment);
    } catch (e) {
      onComplete(changesSummary.summary, 'comment');
    }

  } catch (error) {
    onError(error instanceof Error ? error.message : 'Unknown error');
  }
}

class StreamingSuggestionParser {
  private buffer = '';
  private onSuggestion: (s: ReviewSuggestion) => void;
  private onHallucinationError: (error: string) => void;
  private suggestionCount = 0;
  private lastChunks: string[] = [];
  // private hallucinationDetected = false;

  constructor(
    onSuggestion: (s: ReviewSuggestion) => void,
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
                // Invalid JSON
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
    const suggestion: ReviewSuggestion = {
      id: `suggestion_${Date.now()}_${this.suggestionCount}`,
      filePath: rawSuggestion.filePath || '',
      lineNumber: rawSuggestion.lineNumber || 1,
      lineRange: rawSuggestion.lineRange,
      priority: rawSuggestion.priority || 'medium',
      type: rawSuggestion.type || 'comment',
      description: rawSuggestion.description || '',
      suggestedCode: rawSuggestion.suggestedCode,
      category: rawSuggestion.category || 'best_practice',
    };
    this.onSuggestion(suggestion);
  }
}

function handleGeminiError(error: unknown) {
  const errorMessage = getErrorMessage(error);
  logger.error(TAG, 'API error:', errorMessage);

  if (errorMessage.includes('API_KEY_INVALID') || errorMessage.includes('API key')) {
    throw new Error('Invalid Gemini API key. Please check your API key in settings.');
  }

  if (errorMessage.includes('quota') || errorMessage.includes('429')) {
    throw new Error('API quota exceeded. Please try again later.');
  }

  if (errorMessage.includes('SAFETY')) {
    throw new Error('Content was blocked by safety filters.');
  }

  throw new Error(`Review failed: ${errorMessage}`);
}

/**
 * Format the changes summary for inclusion in batch request context
 */
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

/**
 * Builds the review prompt from diff and settings
 */
function buildReviewPrompt(
  files: FileDiff[],
  context: ReviewContext,
  settings: ExtensionSettings
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

  // Build context section
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

  return `CONTEXT SUMMARY:
${contextSection}

INSTRUCTIONS:
Review the following code files which are PART of the PR above.
${strictnessInstructions} ${focusInstructions}

Look for security issues, bugs, performance problems, and best practices.

Write each description like you're talking to a teammate - natural and friendly, not formal. Be specific about what you noticed and why it matters.

${diffString}

Line numbers are prefixed with L (e.g., L42 means lineNumber: 42). Only comment on added (+) or context ( ) lines with line numbers.

Output your response as valid JSON matching this schema:
${REVIEW_RESPONSE_SCHEMA_DESC}

Output valid JSON only. Start outputting suggestions immediately.`;
}

/**
 * Formats diff data for the prompt with explicit line numbers
 */
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

/**
 * Parses the response from Gemini into a structured review
 */
function parseReviewResponse(response: string): ReviewResponse {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    const suggestions = (parsed.suggestions || []).map((suggestion: Record<string, unknown>, index: number) => ({
      id: `suggestion_${Date.now()}_${index}_${Math.random().toString(36).substr(2, 5)}`,
      filePath: suggestion.filePath || '',
      lineNumber: suggestion.lineNumber || 1,
      lineRange: suggestion.lineRange,
      priority: suggestion.priority || 'medium',
      type: suggestion.type || 'comment',
      description: suggestion.description || '',
      suggestedCode: suggestion.suggestedCode,
      category: suggestion.category || 'best_practice',
    }));

    return {
      suggestions,
      summary: parsed.summary || 'Review complete.',
      overallAssessment: parsed.overallAssessment || 'comment',
      reviewedAt: new Date().toISOString(),
    };
  } catch (parseError) {
    logger.error(TAG, 'JSON parsing failed:', getErrorMessage(parseError));
    return {
      suggestions: [],
      summary: 'Failed to parse review response.',
      overallAssessment: 'comment',
      reviewedAt: new Date().toISOString(),
    };
  }
}

/**
 * Generate PR description based on a template and diff
 */
export async function generatePRDescription(
  diffText: string,
  template: string,
  apiKey: string
): Promise<string> {
  if (!apiKey) {
    throw new Error('Gemini API key is required. Please set it in the extension settings.');
  }

  const google = createGoogleGenerativeAI({ apiKey });
  const model = google(GEMINI_CONFIG.MODEL);

  const maxDiffChars = GEMINI_CONFIG.MAX_TOTAL_DIFF_CHARS;
  const truncatedDiff = diffText.length > maxDiffChars
    ? diffText.substring(0, maxDiffChars) + '\n\n[... diff truncated for processing ...]'
    : diffText;

  const prompt = `Fill in this PR template based on the diff. Be EXTREMELY brief.

Template:
${template || '## Summary\n\n## Changes'}

Diff:
${truncatedDiff}

Rules:
- Max 2 short sentences per section
- Bullet points: max 5-7 words each
- Ultra short explanations, ideally just facts
- Leave checkboxes unchecked [ ]
- Output ONLY the filled template`;

  logger.debug(TAG, 'Generating PR description');

  try {
    const { text } = await generateText({
      model,
      system: 'Ultra-concise PR descriptions. Minimum words. No fluff.',
      prompt,
      temperature: 0.1,
      maxOutputTokens: 5000,
    });

    if (!text) {
      throw new Error('Empty response from Gemini');
    }

    logger.debug(TAG, 'PR description generated successfully');
    return text.trim();
  } catch (error: unknown) {
    handleGeminiError(error);
    throw error;
  }
}
