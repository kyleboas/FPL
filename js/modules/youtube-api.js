/**
 * YouTube API Module
 * Handles channel subscriptions and video fetching
 */

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * Extract channel ID from various URL formats
 * @param {string} input - Channel URL or ID
 * @returns {Promise<string>} - Channel ID
 */
export async function parseChannelInput(input, apiKey) {
    input = input.trim();

    // Already a channel ID (starts with UC and is 24 chars)
    if (/^UC[\w-]{22}$/.test(input)) {
        return input;
    }

    // Handle URL (format handle)
    const handleMatch = input.match(/youtube\.com\/@([\w-]+)/);
    if (handleMatch) {
        return await getChannelIdByHandle(handleMatch[1], apiKey);
    }

    // Handle URL (channel ID format)
    const channelMatch = input.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
    if (channelMatch) {
        return channelMatch[1];
    }

    // Handle URL (user format - legacy)
    const userMatch = input.match(/youtube\.com\/user\/([\w-]+)/);
    if (userMatch) {
        return await getChannelIdByUsername(userMatch[1], apiKey);
    }

    // Handle URL (c/ format)
    const customMatch = input.match(/youtube\.com\/c\/([\w-]+)/);
    if (customMatch) {
        return await searchChannelByName(customMatch[1], apiKey);
    }

    // Assume it's a handle without @
    if (/^[\w-]+$/.test(input)) {
        return await getChannelIdByHandle(input, apiKey);
    }

    throw new Error('Invalid channel URL or ID format');
}

/**
 * Get channel ID by handle (@username)
 */
async function getChannelIdByHandle(handle, apiKey) {
    const response = await fetch(
        `${YOUTUBE_API_BASE}/channels?part=id&forHandle=${handle}&key=${apiKey}`
    );

    if (!response.ok) {
        throw new Error(`YouTube API error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.items || data.items.length === 0) {
        throw new Error(`Channel not found for handle: @${handle}`);
    }

    return data.items[0].id;
}

/**
 * Get channel ID by username (legacy)
 */
async function getChannelIdByUsername(username, apiKey) {
    const response = await fetch(
        `${YOUTUBE_API_BASE}/channels?part=id&forUsername=${username}&key=${apiKey}`
    );

    if (!response.ok) {
        throw new Error(`YouTube API error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.items || data.items.length === 0) {
        throw new Error(`Channel not found for username: ${username}`);
    }

    return data.items[0].id;
}

/**
 * Search for a channel by name
 */
async function searchChannelByName(name, apiKey) {
    const response = await fetch(
        `${YOUTUBE_API_BASE}/search?part=snippet&type=channel&q=${encodeURIComponent(name)}&maxResults=1&key=${apiKey}`
    );

    if (!response.ok) {
        throw new Error(`YouTube API error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.items || data.items.length === 0) {
        throw new Error(`Channel not found: ${name}`);
    }

    return data.items[0].id.channelId;
}

/**
 * Get channel details
 * @param {string} channelId - YouTube channel ID
 * @param {string} apiKey - YouTube API key
 * @returns {Promise<Object>} - Channel details
 */
export async function getChannelDetails(channelId, apiKey) {
    const response = await fetch(
        `${YOUTUBE_API_BASE}/channels?part=snippet,statistics,contentDetails&id=${channelId}&key=${apiKey}`
    );

    if (!response.ok) {
        throw new Error(`YouTube API error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.items || data.items.length === 0) {
        throw new Error(`Channel not found: ${channelId}`);
    }

    const channel = data.items[0];
    return {
        id: channel.id,
        title: channel.snippet.title,
        description: channel.snippet.description,
        thumbnail: channel.snippet.thumbnails.default.url,
        subscriberCount: channel.statistics.subscriberCount,
        videoCount: channel.statistics.videoCount,
        uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads
    };
}

/**
 * Get recent videos from a channel's uploads playlist
 * @param {string} playlistId - Uploads playlist ID
 * @param {string} apiKey - YouTube API key
 * @param {number} maxResults - Maximum number of videos to fetch
 * @returns {Promise<Array>} - List of videos
 */
export async function getChannelVideos(playlistId, apiKey, maxResults = 10) {
    const response = await fetch(
        `${YOUTUBE_API_BASE}/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=${maxResults}&key=${apiKey}`
    );

    if (!response.ok) {
        throw new Error(`YouTube API error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.items) {
        return [];
    }

    return data.items.map(item => ({
        id: item.contentDetails.videoId,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
        channelId: item.snippet.channelId,
        channelTitle: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt
    }));
}

/**
 * Get video details
 * @param {string} videoId - YouTube video ID
 * @param {string} apiKey - YouTube API key
 * @returns {Promise<Object>} - Video details
 */
export async function getVideoDetails(videoId, apiKey) {
    const response = await fetch(
        `${YOUTUBE_API_BASE}/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${apiKey}`
    );

    if (!response.ok) {
        throw new Error(`YouTube API error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.items || data.items.length === 0) {
        throw new Error(`Video not found: ${videoId}`);
    }

    const video = data.items[0];
    return {
        id: video.id,
        title: video.snippet.title,
        description: video.snippet.description,
        thumbnail: video.snippet.thumbnails.medium?.url || video.snippet.thumbnails.default?.url,
        channelId: video.snippet.channelId,
        channelTitle: video.snippet.channelTitle,
        publishedAt: video.snippet.publishedAt,
        duration: video.contentDetails.duration,
        viewCount: video.statistics.viewCount
    };
}

export default {
    parseChannelInput,
    getChannelDetails,
    getChannelVideos,
    getVideoDetails
};
