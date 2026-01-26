/**
 * Gemini Service - Direct API Key Authentication
 *
 * Handles AI code review requests using Google's Gemini model.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { PRDiff, ReviewResponse, ExtensionSettings } from '../shared/types';

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
  const model = client.getGenerativeModel({ model: 'gemini-3-flash-preview' });

  const prompt = buildReviewPrompt(diff, settings);

  try {
    console.log('[Gemini] Starting API request...');
    console.log('[Gemini] Model:', 'gemini-3-flash-preview');
    console.log('[Gemini] Prompt length:', prompt.length, 'characters');
    console.log('[Gemini] Diff preview (first 2000 chars):', prompt.substring(prompt.indexOf('Code Changes:'), prompt.indexOf('Code Changes:') + 2000));

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
        maxOutputTokens: 65000,
        temperature: 0.3,
      },
    });

    console.log('[Gemini] API request completed');

    const response = result.response;

    // Debug: Log response metadata
    console.log('[Gemini] Response object keys:', Object.keys(response));

    // Debug: Log usage metadata if available
    if (response.usageMetadata) {
      console.log('[Gemini] Usage metadata:', JSON.stringify(response.usageMetadata, null, 2));
    }

    // Debug: Log candidates info
    if (response.candidates) {
      console.log('[Gemini] Number of candidates:', response.candidates.length);
      response.candidates.forEach((candidate, index) => {
        console.log(`[Gemini] Candidate ${index}:`, {
          finishReason: candidate.finishReason,
          safetyRatings: candidate.safetyRatings,
          index: candidate.index,
        });
        if (candidate.content) {
          console.log(`[Gemini] Candidate ${index} content parts:`, candidate.content.parts?.length || 0);
        }
      });
    }

    // Debug: Log prompt feedback if available
    if (response.promptFeedback) {
      console.log('[Gemini] Prompt feedback:', JSON.stringify(response.promptFeedback, null, 2));
    }

    const text = response.text();

    console.log('[Gemini] Response text length:', text?.length || 0, 'characters');
    console.log('[Gemini] Response text preview:', text?.substring(0, 500) || 'empty');

    if (!text) {
      console.error('[Gemini] Empty response received');
      throw new Error('Empty response from Gemini');
    }

    const parsedResponse = parseReviewResponse(text);
    console.log('[Gemini] Parsed response:', {
      suggestionsCount: parsedResponse.suggestions.length,
      overallAssessment: parsedResponse.overallAssessment,
      summaryLength: parsedResponse.summary?.length || 0,
    });

    return parsedResponse;
  } catch (error: unknown) {
    console.error('[Gemini] API error occurred:', error);

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;

    console.error('[Gemini] Error message:', errorMessage);
    if (errorStack) {
      console.error('[Gemini] Error stack:', errorStack);
    }

    // Log the full error object for debugging
    if (error && typeof error === 'object') {
      try {
        console.error('[Gemini] Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      } catch {
        console.error('[Gemini] Error object (non-serializable):', error);
      }
    }

    if (errorMessage.includes('API_KEY_INVALID') || errorMessage.includes('API key')) {
      console.error('[Gemini] API key validation failed');
      throw new Error('Invalid Gemini API key. Please check your API key in settings.');
    }

    if (errorMessage.includes('quota') || errorMessage.includes('429')) {
      console.error('[Gemini] Rate limit or quota exceeded');
      throw new Error('API quota exceeded. Please try again later.');
    }

    if (errorMessage.includes('SAFETY')) {
      console.error('[Gemini] Content blocked by safety filters');
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
  console.log('[Gemini] Parsing response...');
  console.log('[Gemini] Raw response length:', response.length);
  console.log('[Gemini] Raw response (full):', response);

  try {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[Gemini] No JSON found in response');
      console.error('[Gemini] Response content:', response);
      throw new Error('No JSON found in response');
    }

    console.log('[Gemini] JSON match found, length:', jsonMatch[0].length);
    console.log('[Gemini] Extracted JSON:', jsonMatch[0]);

    const parsed = JSON.parse(jsonMatch[0]);
    console.log('[Gemini] JSON parsed successfully');
    console.log('[Gemini] Parsed object keys:', Object.keys(parsed));
    console.log('[Gemini] Raw suggestions count:', parsed.suggestions?.length || 0);
    console.log('[Gemini] Raw summary:', parsed.summary);
    console.log('[Gemini] Raw overallAssessment:', parsed.overallAssessment);

    // Validate and add IDs to suggestions
    const suggestions = (parsed.suggestions || []).map((suggestion: Record<string, unknown>, index: number) => {
      console.log(`[Gemini] Processing suggestion ${index}:`, suggestion);
      return {
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
      };
    });

    console.log('[Gemini] Processed suggestions count:', suggestions.length);

    return {
      suggestions,
      summary: parsed.summary || 'Review complete.',
      overallAssessment: parsed.overallAssessment || 'comment',
      reviewedAt: new Date().toISOString(),
    };
  } catch (parseError) {
    // If JSON parsing fails, create a generic response
    console.error('[Gemini] JSON parsing failed:', parseError);
    console.error('[Gemini] Failed response content:', response.substring(0, 1000));
    return {
      suggestions: [],
      summary: response.substring(0, 500),
      overallAssessment: 'comment',
      reviewedAt: new Date().toISOString(),
    };
  }
}
