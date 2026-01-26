/**
 * Gemini Service - Direct API Key Authentication
 *
 * Handles AI code review requests using Google's Gemini model.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { PRDiff, ReviewResponse, ExtensionSettings } from '../shared/types';
import { GEMINI_CONFIG, LOG_TAGS } from '../shared/constants';
import { logger, getErrorMessage } from '../shared/logger';

const TAG = LOG_TAGS.GEMINI;

let genAI: GoogleGenerativeAI | null = null;
let currentApiKey: string | null = null;

/**
 * Initialize or get the Gemini client
 */
function getClient(apiKey: string): GoogleGenerativeAI {
  if (!genAI || currentApiKey !== apiKey) {
    genAI = new GoogleGenerativeAI(apiKey);
    currentApiKey = apiKey;
  }
  return genAI;
}

/**
 * Request a code review from Gemini
 */
export async function requestReview(
  diff: PRDiff,
  settings: ExtensionSettings
): Promise<ReviewResponse> {
  const apiKey = settings.geminiApiKey;

  if (!apiKey) {
    throw new Error('Gemini API key is required. Please set it in the extension settings.');
  }

  const client = getClient(apiKey);
  const model = client.getGenerativeModel({ model: GEMINI_CONFIG.MODEL });

  const prompt = buildReviewPrompt(diff, settings);

  try {
    logger.debug(TAG, 'Starting API request, prompt length:', prompt.length);

    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      systemInstruction: {
        role: 'model',
        parts: [
          {
            text: 'You are an expert code reviewer. Analyze code changes and provide constructive, actionable feedback in the requested JSON format. Always respond with valid JSON.',
          },
        ],
      },
      generationConfig: {
        maxOutputTokens: GEMINI_CONFIG.MAX_OUTPUT_TOKENS,
        temperature: GEMINI_CONFIG.TEMPERATURE,
      },
    });

    logger.debug(TAG, 'API request completed');

    const response = result.response;
    const text = response.text();

    if (!text) {
      logger.error(TAG, 'Empty response received');
      throw new Error('Empty response from Gemini');
    }

    const parsedResponse = parseReviewResponse(text);
    logger.debug(TAG, 'Parsed response:', {
      suggestionsCount: parsedResponse.suggestions.length,
      overallAssessment: parsedResponse.overallAssessment,
    });

    return parsedResponse;
  } catch (error: unknown) {
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
}

/**
 * Builds the review prompt from diff and settings
 */
function buildReviewPrompt(diff: PRDiff, settings: ExtensionSettings): string {
  const { strictnessLevel, focusAreas } = settings || {};

  let focusInstructions = '';
  if (focusAreas && !focusAreas.includes('all')) {
    const areas = focusAreas.map(area => {
      switch (area) {
        case 'security': return 'security vulnerabilities and input validation';
        case 'performance': return 'performance issues and optimization opportunities';
        case 'style': return 'code style, naming conventions, and readability';
        default: return area;
      }
    });
    focusInstructions = `Focus primarily on: ${areas.join(', ')}.`;
  }

  let strictnessInstructions = '';
  switch (strictnessLevel) {
    case 'quick':
      strictnessInstructions = 'Only report critical issues that could cause bugs or security vulnerabilities. Be concise.';
      break;
    case 'thorough':
      strictnessInstructions = 'Provide a comprehensive review covering all aspects of code quality, including minor improvements and best practices.';
      break;
    case 'balanced':
    default:
      strictnessInstructions = 'Provide a balanced review focusing on important issues while noting significant improvements.';
  }

  const diffString = formatDiffForPrompt(diff);

  return `You are reviewing a GitHub Pull Request. Analyze the following code changes and provide actionable review suggestions.

${strictnessInstructions}
${focusInstructions}

PR Title: ${diff.title || 'Untitled'}
PR Description: ${diff.description || 'No description provided'}
Base Branch: ${diff.baseBranch || 'main'}
Head Branch: ${diff.headBranch || 'feature'}

Code Changes:
${diffString}

Provide your review in the following JSON format:
{
  "suggestions": [
    {
      "filePath": "path/to/file.ts",
      "lineNumber": 42,
      "priority": "high|medium|low",
      "type": "comment|code_change|question",
      "title": "Brief title",
      "description": "Detailed explanation",
      "suggestedCode": "optional code suggestion",
      "category": "security|performance|style|logic|best_practice|documentation"
    }
  ],
  "summary": "Overall assessment of the PR",
  "overallAssessment": "approve|request_changes|comment"
}

Important:
- Each line in the diff is prefixed with its line number (e.g., "L42" means line 42)
- Use the EXACT line number shown (L42 means lineNumber: 42)
- Only suggest changes for lines marked with "+" (added) or " " (context) that have line numbers
- Lines marked with "-" (removed) don't have new line numbers and cannot be commented on
- Be specific about what to change and why
- For code suggestions, provide the exact replacement code`;
}

/**
 * Formats diff data for the prompt with explicit line numbers
 */
function formatDiffForPrompt(diff: PRDiff): string {
  if (!diff || !diff.files) {
    return 'No diff data available';
  }

  const lines: string[] = [];

  for (const file of diff.files) {
    lines.push(`\n=== File: ${file.path} (${file.status}) ===`);

    if (file.isBinary) {
      lines.push('Binary file - skipped');
      continue;
    }

    for (const hunk of (file.hunks || [])) {
      lines.push(`\n--- Hunk: lines ${hunk.newStart}-${hunk.newStart + hunk.newLines - 1} ---`);

      for (const line of (hunk.lines || [])) {
        const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
        // Include the new line number for added and context lines
        const lineNum = line.newLineNumber !== null ? `L${line.newLineNumber}` : '   ';
        lines.push(`${lineNum} ${prefix} ${line.content}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Parses the response from Gemini into a structured review
 */
function parseReviewResponse(response: string): ReviewResponse {
  try {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.error(TAG, 'No JSON found in response');
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate and add IDs to suggestions
    const suggestions = (parsed.suggestions || []).map((suggestion: Record<string, unknown>, index: number) => ({
      id: `suggestion_${Date.now()}_${index}`,
      filePath: suggestion.filePath || '',
      lineNumber: suggestion.lineNumber || 1,
      lineRange: suggestion.lineRange,
      priority: suggestion.priority || 'medium',
      type: suggestion.type || 'comment',
      title: suggestion.title || 'Review suggestion',
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
    // If JSON parsing fails, create a generic response
    logger.error(TAG, 'JSON parsing failed:', getErrorMessage(parseError));
    return {
      suggestions: [],
      summary: response.substring(0, 500),
      overallAssessment: 'comment',
      reviewedAt: new Date().toISOString(),
    };
  }
}
