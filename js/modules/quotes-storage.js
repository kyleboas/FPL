/**
 * Quotes Storage Module
 * Handles persistence of channels, videos, and quotes
 * Uses localStorage for browser storage and JSON files for static data
 */

const STORAGE_KEYS = {
    API_KEYS: 'yt_quotes_api_keys',
    CHANNELS: 'yt_quotes_channels',
    VIDEOS: 'yt_quotes_videos',
    QUOTES: 'yt_quotes_quotes'
};

// Data file paths (for static JSON storage)
const DATA_PATHS = {
    CHANNELS: './data/quotes/channels.json',
    VIDEOS: './data/quotes/videos.json',
    QUOTES: './data/quotes/quotes.json',
    RSS: './data/quotes/rss.xml'
};

/**
 * Storage class for managing quote data
 */
class QuotesStorage {
    constructor() {
        this.channels = new Map();
        this.videos = new Map();
        this.quotes = [];
        this.initialized = false;
    }

    /**
     * Initialize storage, loading from localStorage and/or JSON files
     */
    async init() {
        if (this.initialized) return;

        // Load from localStorage first
        this.loadFromLocalStorage();

        // Try to load from JSON files (for pre-populated data)
        await this.loadFromJsonFiles();

        this.initialized = true;
    }

    /**
     * Load data from localStorage
     */
    loadFromLocalStorage() {
        try {
            const channelsData = localStorage.getItem(STORAGE_KEYS.CHANNELS);
            if (channelsData) {
                const channels = JSON.parse(channelsData);
                channels.forEach(ch => this.channels.set(ch.id, ch));
            }

            const videosData = localStorage.getItem(STORAGE_KEYS.VIDEOS);
            if (videosData) {
                const videos = JSON.parse(videosData);
                videos.forEach(v => this.videos.set(v.id, v));
            }

            const quotesData = localStorage.getItem(STORAGE_KEYS.QUOTES);
            if (quotesData) {
                this.quotes = JSON.parse(quotesData);
            }
        } catch (error) {
            console.error('Error loading from localStorage:', error);
        }
    }

    /**
     * Load data from JSON files
     */
    async loadFromJsonFiles() {
        try {
            // Try to fetch channels
            const channelsResponse = await fetch(DATA_PATHS.CHANNELS);
            if (channelsResponse.ok) {
                const channels = await channelsResponse.json();
                channels.forEach(ch => {
                    if (!this.channels.has(ch.id)) {
                        this.channels.set(ch.id, ch);
                    }
                });
            }
        } catch {
            // Files may not exist yet, that's OK
        }

        try {
            // Try to fetch videos
            const videosResponse = await fetch(DATA_PATHS.VIDEOS);
            if (videosResponse.ok) {
                const videos = await videosResponse.json();
                videos.forEach(v => {
                    if (!this.videos.has(v.id)) {
                        this.videos.set(v.id, v);
                    }
                });
            }
        } catch {
            // Files may not exist yet
        }

        try {
            // Try to fetch quotes
            const quotesResponse = await fetch(DATA_PATHS.QUOTES);
            if (quotesResponse.ok) {
                const quotes = await quotesResponse.json();
                // Merge quotes, avoiding duplicates by ID
                const existingIds = new Set(this.quotes.map(q => q.id));
                quotes.forEach(q => {
                    if (!existingIds.has(q.id)) {
                        this.quotes.push(q);
                    }
                });
            }
        } catch {
            // Files may not exist yet
        }
    }

    /**
     * Save all data to localStorage
     */
    saveToLocalStorage() {
        try {
            localStorage.setItem(
                STORAGE_KEYS.CHANNELS,
                JSON.stringify(Array.from(this.channels.values()))
            );
            localStorage.setItem(
                STORAGE_KEYS.VIDEOS,
                JSON.stringify(Array.from(this.videos.values()))
            );
            localStorage.setItem(
                STORAGE_KEYS.QUOTES,
                JSON.stringify(this.quotes)
            );
        } catch (error) {
            console.error('Error saving to localStorage:', error);
        }
    }

    // ==================== API Keys ====================

    /**
     * Save API keys (stored in localStorage only for security)
     */
    saveApiKeys(youtubeKey, openaiKey) {
        const keys = { youtube: youtubeKey, openai: openaiKey };
        localStorage.setItem(STORAGE_KEYS.API_KEYS, JSON.stringify(keys));
    }

    /**
     * Get saved API keys
     */
    getApiKeys() {
        try {
            const data = localStorage.getItem(STORAGE_KEYS.API_KEYS);
            return data ? JSON.parse(data) : { youtube: '', openai: '' };
        } catch {
            return { youtube: '', openai: '' };
        }
    }

    // ==================== Channels ====================

    /**
     * Add or update a channel
     */
    addChannel(channel) {
        this.channels.set(channel.id, {
            ...channel,
            subscribedAt: channel.subscribedAt || new Date().toISOString(),
            lastFetchedAt: null,
            videoCount: 0
        });
        this.saveToLocalStorage();
    }

    /**
     * Remove a channel and its associated videos/quotes
     */
    removeChannel(channelId) {
        this.channels.delete(channelId);

        // Remove associated videos
        for (const [videoId, video] of this.videos) {
            if (video.channelId === channelId) {
                this.videos.delete(videoId);
            }
        }

        // Remove associated quotes
        this.quotes = this.quotes.filter(q => q.channelId !== channelId);

        this.saveToLocalStorage();
    }

    /**
     * Get all channels
     */
    getChannels() {
        return Array.from(this.channels.values());
    }

    /**
     * Get a channel by ID
     */
    getChannel(channelId) {
        return this.channels.get(channelId);
    }

    /**
     * Update channel's last fetched timestamp
     */
    updateChannelFetchTime(channelId) {
        const channel = this.channels.get(channelId);
        if (channel) {
            channel.lastFetchedAt = new Date().toISOString();
            this.channels.set(channelId, channel);
            this.saveToLocalStorage();
        }
    }

    // ==================== Videos ====================

    /**
     * Add or update a video
     */
    addVideo(video) {
        const existing = this.videos.get(video.id);
        this.videos.set(video.id, {
            ...existing,
            ...video,
            addedAt: existing?.addedAt || new Date().toISOString(),
            status: video.status || existing?.status || 'pending',
            quoteCount: video.quoteCount || existing?.quoteCount || 0
        });
        this.saveToLocalStorage();
    }

    /**
     * Get all videos
     */
    getVideos() {
        return Array.from(this.videos.values());
    }

    /**
     * Get videos by channel
     */
    getVideosByChannel(channelId) {
        return Array.from(this.videos.values())
            .filter(v => v.channelId === channelId);
    }

    /**
     * Get a video by ID
     */
    getVideo(videoId) {
        return this.videos.get(videoId);
    }

    /**
     * Update video status
     */
    updateVideoStatus(videoId, status, error = null) {
        const video = this.videos.get(videoId);
        if (video) {
            video.status = status;
            video.error = error;
            video.processedAt = status === 'processed' ? new Date().toISOString() : video.processedAt;
            this.videos.set(videoId, video);
            this.saveToLocalStorage();
        }
    }

    /**
     * Get pending videos (not yet processed)
     */
    getPendingVideos() {
        return Array.from(this.videos.values())
            .filter(v => v.status === 'pending');
    }

    // ==================== Quotes ====================

    /**
     * Add quotes for a video
     */
    addQuotes(videoId, quotes) {
        // Remove existing quotes for this video first
        this.quotes = this.quotes.filter(q => q.videoId !== videoId);

        // Add new quotes
        this.quotes.push(...quotes);

        // Update video quote count
        const video = this.videos.get(videoId);
        if (video) {
            video.quoteCount = quotes.length;
            video.status = 'processed';
            video.processedAt = new Date().toISOString();
            this.videos.set(videoId, video);
        }

        this.saveToLocalStorage();
    }

    /**
     * Get all quotes
     */
    getQuotes() {
        return [...this.quotes].sort((a, b) =>
            new Date(b.extractedAt) - new Date(a.extractedAt)
        );
    }

    /**
     * Get quotes by video
     */
    getQuotesByVideo(videoId) {
        return this.quotes.filter(q => q.videoId === videoId);
    }

    /**
     * Get quotes by channel
     */
    getQuotesByChannel(channelId) {
        return this.quotes.filter(q => q.channelId === channelId);
    }

    /**
     * Search quotes
     */
    searchQuotes(query) {
        const lowerQuery = query.toLowerCase();
        return this.quotes.filter(q =>
            q.text.toLowerCase().includes(lowerQuery) ||
            q.videoTitle?.toLowerCase().includes(lowerQuery) ||
            q.channelTitle?.toLowerCase().includes(lowerQuery)
        );
    }

    // ==================== Export ====================

    /**
     * Export all data as JSON
     */
    exportData() {
        return {
            channels: Array.from(this.channels.values()),
            videos: Array.from(this.videos.values()),
            quotes: this.quotes,
            exportedAt: new Date().toISOString()
        };
    }

    /**
     * Import data from JSON
     */
    importData(data) {
        if (data.channels) {
            data.channels.forEach(ch => this.channels.set(ch.id, ch));
        }
        if (data.videos) {
            data.videos.forEach(v => this.videos.set(v.id, v));
        }
        if (data.quotes) {
            const existingIds = new Set(this.quotes.map(q => q.id));
            data.quotes.forEach(q => {
                if (!existingIds.has(q.id)) {
                    this.quotes.push(q);
                }
            });
        }
        this.saveToLocalStorage();
    }

    /**
     * Clear all data
     */
    clearAll() {
        this.channels.clear();
        this.videos.clear();
        this.quotes = [];
        localStorage.removeItem(STORAGE_KEYS.CHANNELS);
        localStorage.removeItem(STORAGE_KEYS.VIDEOS);
        localStorage.removeItem(STORAGE_KEYS.QUOTES);
    }
}

// Singleton instance
const storage = new QuotesStorage();

export { storage, DATA_PATHS };
export default storage;
