#!/usr/bin/env node

/**
 * YouTube Quote Processor Script
 *
 * This script runs as a GitHub Action to:
 * 1. Fetch new videos from subscribed channels
 * 2. Extract transcripts from unprocessed videos
 * 3. Use OpenAI to extract quotes
 * 4. Update JSON data files and RSS feed
 *
 * Environment Variables Required:
 * - YOUTUBE_API_KEY: YouTube Data API key
 * - OPENAI_API_KEY: OpenAI API key
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data', 'quotes');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const VIDEOS_FILE = path.join(DATA_DIR, 'videos.json');
const QUOTES_FILE = path.join(DATA_DIR, 'quotes.json');
const RSS_FILE = path.join(DATA_DIR, 'rss.xml');

// API Configuration
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

// Get API keys from environment
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ==================== Data Loading ====================

function loadJson(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        console.warn(`Could not load ${filePath}:`, error.message);
        return [];
    }
}

function saveJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`Saved ${filePath}`);
}

// ==================== YouTube API ====================

async function getChannelVideos(uploadsPlaylistId, maxResults = 10) {
    const url = `${YOUTUBE_API_BASE}/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`YouTube API error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.items) return [];

    return data.items.map(item => ({
        id: item.contentDetails.videoId,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
        channelId: item.snippet.channelId,
        channelTitle: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt
    }));
}

// ==================== Transcript Fetching ====================

async function getVideoTranscript(videoId) {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Try to fetch the video page
    const response = await fetch(videoUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch video page: ${response.status}`);
    }

    const html = await response.text();

    // Extract caption track URL from the page
    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionMatch) {
        throw new Error('No captions available for this video');
    }

    try {
        const captionTracks = JSON.parse(captionMatch[1]);
        if (!captionTracks || captionTracks.length === 0) {
            throw new Error('No caption tracks found');
        }

        // Prefer English
        const englishTrack = captionTracks.find(t =>
            t.languageCode === 'en' || t.languageCode?.startsWith('en')
        );
        const track = englishTrack || captionTracks[0];

        if (!track || !track.baseUrl) {
            throw new Error('No valid caption track URL');
        }

        // Fetch the transcript
        const transcriptResponse = await fetch(track.baseUrl);
        if (!transcriptResponse.ok) {
            throw new Error('Failed to fetch transcript');
        }

        const transcriptXml = await transcriptResponse.text();
        return parseTranscriptXml(transcriptXml);

    } catch (parseError) {
        throw new Error(`Failed to parse captions: ${parseError.message}`);
    }
}

function parseTranscriptXml(xml) {
    // Simple regex-based XML parsing for Node.js
    const textRegex = /<text[^>]*>([^<]*)<\/text>/g;
    const segments = [];
    let match;

    while ((match = textRegex.exec(xml)) !== null) {
        const text = decodeHtmlEntities(match[1]).trim();
        if (text) {
            segments.push(text);
        }
    }

    return {
        fullText: segments.join(' '),
        segmentCount: segments.length
    };
}

function decodeHtmlEntities(text) {
    return text
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#\d+;/g, (match) => {
            const num = parseInt(match.slice(2, -1));
            return String.fromCharCode(num);
        })
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ');
}

// ==================== OpenAI Quote Extraction ====================

async function extractQuotes(transcript, videoInfo) {
    const maxTranscriptLength = 15000;
    const truncatedTranscript = transcript.length > maxTranscriptLength
        ? transcript.substring(0, maxTranscriptLength) + '...[truncated]'
        : transcript;

    const systemPrompt = `You are an expert at identifying notable, insightful, and memorable quotes from video transcripts. Extract 3-10 quotes that:

1. Express unique insights, opinions, or perspectives
2. Are self-contained and make sense out of context
3. Are memorable, thought-provoking, or impactful
4. Represent key ideas or takeaways

Guidelines:
- Each quote should be 20-500 characters
- Clean up filler words while preserving meaning
- Maintain the speaker's voice and intent

Return ONLY a JSON array: [{"text": "quote text", "context": "brief context"}]`;

    const userPrompt = `Video: ${videoInfo.title}
Channel: ${videoInfo.channelTitle}

Transcript:
${truncatedTranscript}`;

    const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
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
        throw new Error(`OpenAI API error: ${response.status} - ${error.error?.message || 'Unknown'}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error('No response from OpenAI');
    }

    // Parse JSON response
    const cleanContent = content
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/gi, '')
        .trim();

    const quotes = JSON.parse(cleanContent);

    if (!Array.isArray(quotes)) {
        throw new Error('Response is not an array');
    }

    return quotes
        .filter(q => q.text && q.text.length >= 20)
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
}

// ==================== RSS Generation ====================

function generateRssFeed(quotes) {
    const sortedQuotes = [...quotes]
        .sort((a, b) => new Date(b.extractedAt) - new Date(a.extractedAt))
        .slice(0, 100);

    const lastBuildDate = sortedQuotes.length > 0
        ? new Date(sortedQuotes[0].extractedAt).toUTCString()
        : new Date().toUTCString();

    const items = sortedQuotes.map(quote => {
        const videoUrl = `https://www.youtube.com/watch?v=${quote.videoId}`;
        const pubDate = new Date(quote.extractedAt).toUTCString();
        const guid = `quote-${quote.id}`;
        const title = escapeXml(truncate(quote.text, 100)) + ' - ' + escapeXml(quote.channelTitle);

        return `    <item>
      <title>${title}</title>
      <link>${videoUrl}</link>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(quote.text)}</description>
      <author>${escapeXml(quote.channelTitle)}</author>
    </item>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>YouTube Quote Extractor</title>
    <description>Notable quotes extracted from YouTube videos</description>
    <link>https://github.com/kyleboas/FPL</link>
    <language>en-us</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <generator>YouTube Quote Extractor</generator>
${items}
  </channel>
</rss>`;
}

function escapeXml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function truncate(text, maxLength) {
    if (!text || text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
}

// ==================== Main Process ====================

async function main() {
    console.log('=== YouTube Quote Processor ===\n');

    // Check API keys
    if (!YOUTUBE_API_KEY) {
        console.error('Error: YOUTUBE_API_KEY environment variable not set');
        process.exit(1);
    }

    if (!OPENAI_API_KEY) {
        console.error('Error: OPENAI_API_KEY environment variable not set');
        process.exit(1);
    }

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Load existing data
    let channels = loadJson(CHANNELS_FILE);
    let videos = loadJson(VIDEOS_FILE);
    let quotes = loadJson(QUOTES_FILE);

    console.log(`Loaded: ${channels.length} channels, ${videos.length} videos, ${quotes.length} quotes\n`);

    if (channels.length === 0) {
        console.log('No channels to process. Add channels via the web interface first.');
        process.exit(0);
    }

    // Create maps for quick lookup
    const videosMap = new Map(videos.map(v => [v.id, v]));
    const quotesMap = new Map();
    quotes.forEach(q => {
        if (!quotesMap.has(q.videoId)) {
            quotesMap.set(q.videoId, []);
        }
        quotesMap.get(q.videoId).push(q);
    });

    // Process each channel
    for (const channel of channels) {
        console.log(`\nProcessing channel: ${channel.title}`);

        try {
            // Fetch recent videos
            const channelVideos = await getChannelVideos(channel.uploadsPlaylistId, 10);
            console.log(`  Found ${channelVideos.length} recent videos`);

            for (const video of channelVideos) {
                const existing = videosMap.get(video.id);

                // Add or update video
                const videoData = {
                    ...existing,
                    ...video,
                    addedAt: existing?.addedAt || new Date().toISOString(),
                    status: existing?.status || 'pending'
                };
                videosMap.set(video.id, videoData);

                // Skip if already processed
                if (existing?.status === 'processed') {
                    console.log(`  - Skipping (already processed): ${video.title.substring(0, 50)}...`);
                    continue;
                }

                console.log(`  - Processing: ${video.title.substring(0, 50)}...`);

                try {
                    // Get transcript
                    const transcript = await getVideoTranscript(video.id);
                    console.log(`    Transcript: ${transcript.segmentCount} segments`);

                    // Extract quotes
                    const videoQuotes = await extractQuotes(transcript.fullText, video);
                    console.log(`    Extracted: ${videoQuotes.length} quotes`);

                    // Update video status
                    videoData.status = 'processed';
                    videoData.processedAt = new Date().toISOString();
                    videoData.quoteCount = videoQuotes.length;
                    videosMap.set(video.id, videoData);

                    // Store quotes (replace existing for this video)
                    quotesMap.set(video.id, videoQuotes);

                    // Small delay to avoid rate limits
                    await new Promise(resolve => setTimeout(resolve, 2000));

                } catch (error) {
                    console.log(`    Error: ${error.message}`);
                    videoData.status = 'error';
                    videoData.error = error.message;
                    videosMap.set(video.id, videoData);
                }
            }

            // Update channel last fetched
            channel.lastFetchedAt = new Date().toISOString();

        } catch (error) {
            console.log(`  Error fetching channel: ${error.message}`);
        }
    }

    // Flatten quotes from map
    const allQuotes = [];
    for (const videoQuotes of quotesMap.values()) {
        allQuotes.push(...videoQuotes);
    }

    // Save updated data
    console.log('\n=== Saving Data ===');
    saveJson(CHANNELS_FILE, channels);
    saveJson(VIDEOS_FILE, Array.from(videosMap.values()));
    saveJson(QUOTES_FILE, allQuotes);

    // Generate RSS feed
    const rssFeed = generateRssFeed(allQuotes);
    fs.writeFileSync(RSS_FILE, rssFeed);
    console.log(`Saved ${RSS_FILE}`);

    console.log(`\nComplete: ${channels.length} channels, ${videosMap.size} videos, ${allQuotes.length} quotes`);
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
