/**
 * Transcript Extraction Module
 * Fetches video transcripts/captions from YouTube
 */

// We'll use a third-party service or YouTube's timedtext API
// Note: Direct transcript access requires either:
// 1. YouTube Data API with OAuth (for captions.download)
// 2. Third-party transcript services
// 3. Web scraping (unreliable)

// For this implementation, we'll use a CORS proxy with YouTube's timedtext API
// or fall back to a transcript extraction service

const CORS_PROXIES = [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url='
];

/**
 * Extract transcript from a YouTube video
 * @param {string} videoId - YouTube video ID
 * @returns {Promise<Object>} - Transcript data with text segments
 */
export async function getVideoTranscript(videoId) {
    // Try to get transcript using various methods
    const methods = [
        () => fetchTranscriptFromYouTube(videoId),
        () => fetchTranscriptFromAlternative(videoId)
    ];

    for (const method of methods) {
        try {
            const transcript = await method();
            if (transcript && transcript.segments && transcript.segments.length > 0) {
                return transcript;
            }
        } catch (error) {
            console.warn('Transcript method failed:', error.message);
        }
    }

    throw new Error('Could not fetch transcript. Video may not have captions available.');
}

/**
 * Fetch transcript directly from YouTube
 * This uses YouTube's internal timedtext API
 */
async function fetchTranscriptFromYouTube(videoId) {
    // First, get the video page to extract caption tracks
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    for (const proxy of CORS_PROXIES) {
        try {
            const response = await fetch(proxy + encodeURIComponent(videoUrl));
            if (!response.ok) continue;

            const html = await response.text();

            // Extract caption track URL from the page
            const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
            if (!captionMatch) continue;

            try {
                const captionTracks = JSON.parse(captionMatch[1]);
                if (!captionTracks || captionTracks.length === 0) continue;

                // Prefer English, but take any available
                const englishTrack = captionTracks.find(t =>
                    t.languageCode === 'en' || t.languageCode?.startsWith('en')
                );
                const track = englishTrack || captionTracks[0];

                if (!track || !track.baseUrl) continue;

                // Fetch the actual transcript
                const transcriptResponse = await fetch(proxy + encodeURIComponent(track.baseUrl));
                if (!transcriptResponse.ok) continue;

                const transcriptXml = await transcriptResponse.text();
                return parseTranscriptXml(transcriptXml);

            } catch (parseError) {
                console.warn('Failed to parse caption tracks:', parseError);
            }
        } catch (error) {
            console.warn('Proxy failed:', proxy, error.message);
        }
    }

    throw new Error('Failed to fetch transcript from YouTube');
}

/**
 * Alternative transcript fetch using a transcript service
 */
async function fetchTranscriptFromAlternative(videoId) {
    // This could be replaced with a dedicated transcript API service
    // For now, we'll throw to indicate no alternative is available
    throw new Error('No alternative transcript service configured');
}

/**
 * Parse YouTube's XML transcript format
 * @param {string} xml - XML transcript data
 * @returns {Object} - Parsed transcript with segments
 */
function parseTranscriptXml(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const textElements = doc.querySelectorAll('text');

    const segments = Array.from(textElements).map(el => {
        const start = parseFloat(el.getAttribute('start') || '0');
        const duration = parseFloat(el.getAttribute('dur') || '0');
        const text = decodeHTMLEntities(el.textContent || '');

        return {
            start,
            duration,
            end: start + duration,
            text: text.trim()
        };
    });

    // Combine segments into full text
    const fullText = segments.map(s => s.text).join(' ');

    return {
        segments,
        fullText,
        language: 'en', // Assumed
        duration: segments.length > 0 ? segments[segments.length - 1].end : 0
    };
}

/**
 * Decode HTML entities in transcript text
 */
function decodeHTMLEntities(text) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ');
}

/**
 * Format timestamp in HH:MM:SS or MM:SS format
 * @param {number} seconds - Time in seconds
 * @returns {string} - Formatted timestamp
 */
export function formatTimestamp(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get YouTube video URL with timestamp
 * @param {string} videoId - Video ID
 * @param {number} seconds - Timestamp in seconds
 * @returns {string} - YouTube URL with timestamp
 */
export function getTimestampUrl(videoId, seconds) {
    return `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(seconds)}s`;
}

export default {
    getVideoTranscript,
    formatTimestamp,
    getTimestampUrl
};
