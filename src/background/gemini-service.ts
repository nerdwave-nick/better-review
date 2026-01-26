/**
 * Gemini Service - Direct API Key Authentication
 *
 * Handles AI code review requests using Google's Gemini model.
 */

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import type { PRDiff, ReviewResponse, ExtensionSettings, ReviewSuggestion } from '../shared/types';
import { GEMINI_CONFIG, LOG_TAGS } from '../shared/constants';
import { logger, getErrorMessage } from '../shared/logger';

const TAG = LOG_TAGS.GEMINI;

/**
 * Response schema for structured output
 */
const REVIEW_RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    suggestions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          filePath: { type: SchemaType.STRING },
          lineNumber: { type: SchemaType.INTEGER },
          priority: {
            type: SchemaType.STRING,
            enum: ['high', 'medium', 'low'],
          },
          type: {
            type: SchemaType.STRING,
            enum: ['comment', 'code_change'],
          },
          description: { type: SchemaType.STRING },
          suggestedCode: { type: SchemaType.STRING },
          category: {
            type: SchemaType.STRING,
            enum: ['security', 'performance', 'style', 'logic', 'best_practice', 'documentation'],
          },
        },
        required: ['filePath', 'lineNumber', 'priority', 'type', 'description', 'category'],
      },
    },
    summary: { type: SchemaType.STRING },
    overallAssessment: {
      type: SchemaType.STRING,
      enum: ['approve', 'request_changes', 'comment'],
    },
  },
  required: ['suggestions', 'summary', 'overallAssessment'],
};

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
            text: 'You are a senior developer doing a code review. Write descriptions in a natural, conversational tone. No greetings, no "Hey", no "Hi" - just get straight to the point. Avoid formal headers or bullet points. Be helpful and specific. Output valid JSON only.',
          },
        ],
      },
      generationConfig: {
        temperature: GEMINI_CONFIG.TEMPERATURE,
        maxOutputTokens: GEMINI_CONFIG.MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
        responseSchema: REVIEW_RESPONSE_SCHEMA,
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
    handleGeminiError(error);
    throw error; // handleGeminiError throws, but typescript needs this
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
  onError: (error: string) => void
): Promise<void> {
  const apiKey = settings.geminiApiKey;

  if (!apiKey) {
    onError('Gemini API key is required. Please set it in the extension settings.');
    return;
  }

  const client = getClient(apiKey);
  const model = client.getGenerativeModel({ model: GEMINI_CONFIG.MODEL });

  const prompt = buildReviewPrompt(diff, settings);
  let hallucinationError: string | null = null;
  const parser = new StreamingSuggestionParser(
    onSuggestion,
    (error) => {
      hallucinationError = error;
    }
  );

  try {
    logger.debug(TAG, 'Starting streaming API request');

    const result = await model.generateContentStream({
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
            text: 'You are a senior developer doing a code review. Write descriptions in a natural, conversational tone. No greetings, no "Hey", no "Hi" - just get straight to the point. Avoid formal headers or bullet points. Be helpful and specific. Output valid JSON only. Start outputting suggestions immediately.',
          },
        ],
      },
      generationConfig: {
        temperature: GEMINI_CONFIG.TEMPERATURE,
        maxOutputTokens: GEMINI_CONFIG.MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
        responseSchema: REVIEW_RESPONSE_SCHEMA,
      },
    });

    let fullText = '';

    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      fullText += chunkText;
      const shouldContinue = parser.process(chunkText);

      // Stop streaming if hallucination detected
      if (!shouldContinue || hallucinationError) {
        logger.warn(TAG, 'Stopping stream due to hallucination detection');
        onError(hallucinationError || 'Model hallucination detected. Review stopped.');
        return;
      }
    }

    // Final attempt to parse any remaining data or extract summary
    try {
      // We parse the full text at the end to get the summary and assessment
      // which usually come after suggestions or are part of the full object
      const parsed = parseReviewResponse(fullText);
      onComplete(parsed.summary, parsed.overallAssessment);
    } catch (e) {
      // Fallback if JSON is incomplete
      onComplete('Review completed (summary unavailable)', 'comment');
    }

  } catch (error) {
    onError(error instanceof Error ? error.message : 'Unknown error');
  }
}

class StreamingSuggestionParser {
  private buffer = '';
  private openBraces = 0;
  private inString = false;
  private escaped = false;
  private onSuggestion: (s: ReviewSuggestion) => void;
  private onHallucinationError: (error: string) => void;
  private suggestionCount = 0;
  private lastChunks: string[] = [];
  private hallucinationDetected = false;

  constructor(
    onSuggestion: (s: ReviewSuggestion) => void,
    onHallucinationError: (error: string) => void
  ) {
    this.onSuggestion = onSuggestion;
    this.onHallucinationError = onHallucinationError;
  }

  process(chunk: string): boolean {
    // Detect hallucination before processing
    if (this.detectHallucination(chunk)) {
      this.hallucinationDetected = true;
      return false; // Signal to stop streaming
    }

    this.buffer += chunk;
    this.tryParseSuggestions();
    return true; // Continue streaming
  }

  private detectHallucination(chunk: string): boolean {
    // Detect runaway number generation (very long numbers)
    const longNumberMatch = chunk.match(/\d{15,}/);
    if (longNumberMatch) {
      logger.warn(TAG, 'Hallucination detected: runaway number generation', longNumberMatch[0].substring(0, 50));
      this.onHallucinationError('Model hallucination detected (runaway numbers). Review stopped.');
      return true;
    }

    // Detect repeated chunks (same content repeated many times)
    this.lastChunks.push(chunk);
    if (this.lastChunks.length > GEMINI_CONFIG.MAX_CONSECUTIVE_REPEATS) {
      this.lastChunks.shift();
    }

    // Check if last N chunks are all the same
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
    // This is a heuristic parser for a specific JSON structure: { "suggestions": [ { ... }, { ... } ] }
    // We look for objects inside the "suggestions" array.
    
    // 1. Find the start of the suggestions array if we haven't yet
    const suggestionsStart = this.buffer.indexOf('"suggestions"');
    if (suggestionsStart === -1) return;

    const arrayStart = this.buffer.indexOf('[', suggestionsStart);
    if (arrayStart === -1) return;

    // We only care about parsing content AFTER the array start
    // We'll walk through the buffer to find complete objects
    
    let depth = 0;
    let inStr = false;
    let isEscaped = false;
    let objStart = -1;

    // Start scanning from where we left off or the beginning of the array
    // Optimization: We could keep track of processed index, but for simplicity let's scan from arrayStart
    // To avoid re-emitting, we can't easily modify the buffer without breaking future parses if we are just cutting strings.
    // Instead, we will find *all* complete objects, and keep track of how many we've emitted.
    
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
                    // Found a complete object at root of array
                    foundObjects++;
                    
                    if (foundObjects > this.suggestionCount) {
                        const jsonStr = this.buffer.substring(objStart, i + 1);
                        try {
                            const suggestion = JSON.parse(jsonStr);
                            // Validate it looks like a suggestion
                            if (suggestion.filePath && suggestion.description) {
                                this.emit(suggestion);
                            }
                        } catch (e) {
                            // Invalid JSON, maybe incomplete or malformed, ignore
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
 * Builds the review prompt from diff and settings
 */
function buildReviewPrompt(diff: PRDiff, settings: ExtensionSettings): string {
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

  const diffString = formatDiffForPrompt(diff);

  return `Review this PR diff. ${strictnessInstructions} ${focusInstructions}

Look for security issues, bugs, performance problems, and best practices.

Write each description like you're talking to a teammate - natural and friendly, not formal. Be specific about what you noticed and why it matters.

PR: ${diff.title || 'Untitled'}
${diff.description ? `Description: ${diff.description.substring(0, 200)}` : ''}

${diffString}

Line numbers are prefixed with L (e.g., L42 means lineNumber: 42). Only comment on added (+) or context ( ) lines with line numbers.`;
}

/**
 * Formats diff data for the prompt with explicit line numbers
 * Applies size limits for faster processing
 */
function formatDiffForPrompt(diff: PRDiff): string {
  if (!diff || !diff.files) {
    return 'No diff data available';
  }

  const lines: string[] = [];
  let totalChars = 0;
  const maxChars = GEMINI_CONFIG.MAX_TOTAL_DIFF_CHARS;
  const maxLinesPerFile = GEMINI_CONFIG.MAX_DIFF_LINES_PER_FILE;
  let truncatedFiles = 0;

  for (const file of diff.files) {
    // Check if we've hit the total size limit
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
