/**
 * OpenAI Quotes Module
 * Uses OpenAI API to extract notable quotes from transcripts
 */

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Extract quotes from transcript using OpenAI
 * @param {string} transcript - Full transcript text
 * @param {Object} videoInfo - Video metadata
 * @param {string} apiKey - OpenAI API key
 * @param {Object} options - Extraction options
 * @returns {Promise<Array>} - List of extracted quotes
 */
export async function extractQuotes(transcript, videoInfo, apiKey, options = {}) {
    const {
        maxQuotes = 10,
        model = 'gpt-4o-mini',
        minQuoteLength = 20,
        maxQuoteLength = 500
    } = options;

    // Truncate transcript if too long (to fit within token limits)
    const maxTranscriptLength = 15000;
    const truncatedTranscript = transcript.length > maxTranscriptLength
        ? transcript.substring(0, maxTranscriptLength) + '...[truncated]'
        : transcript;

    const systemPrompt = `You are an expert at identifying notable, insightful, and memorable quotes from video transcripts. Your task is to extract the most quotable moments that:

1. Express unique insights, opinions, or perspectives
2. Are self-contained and make sense out of context
3. Are memorable, thought-provoking, or impactful
4. Represent key ideas or takeaways from the content

Guidelines:
- Extract between 3-${maxQuotes} quotes based on content quality
- Each quote should be ${minQuoteLength}-${maxQuoteLength} characters
- Clean up filler words (um, uh, like, you know) while preserving meaning
- Maintain the speaker's voice and intent
- Include context if needed for clarity (add brief context in [brackets])
- Prefer quotes that would stand alone well in a quote collection

Output format: Return a JSON array of quote objects with "text" and "context" fields.
Example: [{"text": "The quote text here", "context": "Brief context about when/why this was said"}]`;

    const userPrompt = `Extract notable quotes from this video transcript.

Video Title: ${videoInfo.title}
Channel: ${videoInfo.channelTitle}
Description: ${videoInfo.description?.substring(0, 500) || 'N/A'}

Transcript:
${truncatedTranscript}

Return only the JSON array, no additional text.`;

    const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.7,
            max_tokens: 2000
        })
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`OpenAI API error: ${response.status} - ${error.error?.message || 'Unknown error'}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error('No response from OpenAI');
    }

    // Parse the JSON response
    try {
        // Clean up the response (remove markdown code blocks if present)
        const cleanContent = content
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/gi, '')
            .trim();

        const quotes = JSON.parse(cleanContent);

        if (!Array.isArray(quotes)) {
            throw new Error('Response is not an array');
        }

        // Validate and enhance quotes
        return quotes
            .filter(q => q.text && typeof q.text === 'string' && q.text.length >= minQuoteLength)
            .map((quote, index) => ({
                id: `${videoInfo.id}-${index}`,
                text: quote.text.trim(),
                context: quote.context?.trim() || null,
                videoId: videoInfo.id,
                videoTitle: videoInfo.title,
                channelId: videoInfo.channelId,
                channelTitle: videoInfo.channelTitle,
                extractedAt: new Date().toISOString()
            }));

    } catch (parseError) {
        console.error('Failed to parse OpenAI response:', content);
        throw new Error('Failed to parse quotes from OpenAI response');
    }
}

/**
 * Test OpenAI API key validity
 * @param {string} apiKey - OpenAI API key to test
 * @returns {Promise<boolean>} - True if valid
 */
export async function testApiKey(apiKey) {
    try {
        const response = await fetch('https://api.openai.com/v1/models', {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        });
        return response.ok;
    } catch {
        return false;
    }
}

export default {
    extractQuotes,
    testApiKey
};
