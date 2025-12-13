/**
 * YouTube Quote Extractor - Main Application
 */

import { parseChannelInput, getChannelDetails, getChannelVideos } from './modules/youtube-api.js';
import { getVideoTranscript } from './modules/transcript.js';
import { extractQuotes } from './modules/openai-quotes.js';
import storage from './modules/quotes-storage.js';
import { generateRssFeed, downloadRssFeed } from './modules/rss-generator.js';

// DOM Elements
const elements = {
    // API Config
    youtubeApiKey: document.getElementById('youtube-api-key'),
    openaiApiKey: document.getElementById('openai-api-key'),
    saveApiKeysBtn: document.getElementById('save-api-keys'),
    apiStatus: document.getElementById('api-status'),

    // Channel Subscription
    channelInput: document.getElementById('channel-input'),
    subscribeBtn: document.getElementById('subscribe-btn'),
    channelsList: document.getElementById('channels-list'),
    refreshAllBtn: document.getElementById('refresh-all-btn'),

    // View Controls
    viewToggle: document.getElementById('view-toggle'),
    channelFilter: document.getElementById('channel-filter'),
    searchQuotes: document.getElementById('search-quotes'),

    // Content Views
    videosView: document.getElementById('videos-view'),
    quotesView: document.getElementById('quotes-view'),
    videosList: document.getElementById('videos-list'),
    quotesList: document.getElementById('quotes-list'),

    // Modal
    videoModal: document.getElementById('video-modal'),
    modalVideoTitle: document.getElementById('modal-video-title'),
    modalVideoChannel: document.getElementById('modal-video-channel'),
    modalVideoDate: document.getElementById('modal-video-date'),
    modalVideoLink: document.getElementById('modal-video-link'),
    extractQuotesBtn: document.getElementById('extract-quotes-btn'),
    extractionStatus: document.getElementById('extraction-status'),
    videoQuotesList: document.getElementById('video-quotes-list'),

    // Processing
    processingStatus: document.getElementById('processing-status'),
    processingMessage: document.getElementById('processing-message'),

    // Status
    statusBar: document.getElementById('status-bar'),
    error: document.getElementById('error')
};

// State
let currentView = 'videos';
let currentVideoId = null;
let apiKeys = { youtube: '', openai: '' };

/**
 * Initialize the application
 */
async function init() {
    try {
        // Initialize storage
        await storage.init();

        // Load API keys
        apiKeys = storage.getApiKeys();
        if (apiKeys.youtube) elements.youtubeApiKey.value = apiKeys.youtube;
        if (apiKeys.openai) elements.openaiApiKey.value = apiKeys.openai;

        // Set up event listeners
        setupEventListeners();

        // Render initial data
        renderChannels();
        renderVideos();
        renderQuotes();
        updateChannelFilter();

        updateStatus('Ready');
    } catch (error) {
        showError('Failed to initialize: ' + error.message);
    }
}

/**
 * Set up event listeners
 */
function setupEventListeners() {
    // API Keys
    elements.saveApiKeysBtn.addEventListener('click', saveApiKeys);

    // Channel Subscription
    elements.subscribeBtn.addEventListener('click', subscribeToChannel);
    elements.channelInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') subscribeToChannel();
    });

    // Refresh All
    elements.refreshAllBtn.addEventListener('click', refreshAllChannels);

    // View Toggle
    elements.viewToggle.addEventListener('click', (e) => {
        if (e.target.classList.contains('toggle-option')) {
            switchView(e.target.dataset.view);
        }
    });

    // Channel Filter
    elements.channelFilter.addEventListener('change', () => {
        renderVideos();
        renderQuotes();
    });

    // Search
    elements.searchQuotes.addEventListener('input', debounce(() => {
        if (currentView === 'quotes') {
            renderQuotes();
        }
    }, 300));

    // Modal
    elements.videoModal.querySelector('.close-btn').addEventListener('click', closeModal);
    elements.videoModal.addEventListener('click', (e) => {
        if (e.target === elements.videoModal) closeModal();
    });
    elements.extractQuotesBtn.addEventListener('click', extractQuotesForCurrentVideo);
}

/**
 * Save API keys
 */
function saveApiKeys() {
    apiKeys.youtube = elements.youtubeApiKey.value.trim();
    apiKeys.openai = elements.openaiApiKey.value.trim();

    if (!apiKeys.youtube || !apiKeys.openai) {
        showApiStatus('Please enter both API keys', 'error');
        return;
    }

    storage.saveApiKeys(apiKeys.youtube, apiKeys.openai);
    showApiStatus('API keys saved', 'success');
}

/**
 * Show API status message
 */
function showApiStatus(message, type) {
    elements.apiStatus.textContent = message;
    elements.apiStatus.className = `api-status ${type}`;
    setTimeout(() => {
        elements.apiStatus.textContent = '';
        elements.apiStatus.className = 'api-status';
    }, 3000);
}

/**
 * Subscribe to a YouTube channel
 */
async function subscribeToChannel() {
    const input = elements.channelInput.value.trim();
    if (!input) {
        showError('Please enter a channel URL or ID');
        return;
    }

    if (!apiKeys.youtube) {
        showError('Please save your YouTube API key first');
        return;
    }

    showProcessing('Fetching channel info...');

    try {
        // Parse the channel input to get ID
        const channelId = await parseChannelInput(input, apiKeys.youtube);

        // Check if already subscribed
        if (storage.getChannel(channelId)) {
            hideProcessing();
            showError('Already subscribed to this channel');
            return;
        }

        // Get channel details
        const channelDetails = await getChannelDetails(channelId, apiKeys.youtube);

        // Add to storage
        storage.addChannel(channelDetails);

        // Clear input
        elements.channelInput.value = '';

        // Re-render
        renderChannels();
        updateChannelFilter();
        updateStatus(`Subscribed to ${channelDetails.title}`);

        hideProcessing();
    } catch (error) {
        hideProcessing();
        showError('Failed to subscribe: ' + error.message);
    }
}

/**
 * Unsubscribe from a channel
 */
function unsubscribeFromChannel(channelId) {
    if (confirm('Are you sure you want to unsubscribe? This will remove all videos and quotes from this channel.')) {
        const channel = storage.getChannel(channelId);
        storage.removeChannel(channelId);
        renderChannels();
        renderVideos();
        renderQuotes();
        updateChannelFilter();
        updateStatus(`Unsubscribed from ${channel?.title || 'channel'}`);
    }
}

/**
 * Fetch videos for a channel
 */
async function fetchChannelVideos(channelId) {
    if (!apiKeys.youtube) {
        showError('Please save your YouTube API key first');
        return;
    }

    const channel = storage.getChannel(channelId);
    if (!channel) return;

    showProcessing(`Fetching videos from ${channel.title}...`);

    try {
        const videos = await getChannelVideos(channel.uploadsPlaylistId, apiKeys.youtube, 20);

        // Add videos to storage
        videos.forEach(video => {
            const existing = storage.getVideo(video.id);
            storage.addVideo({
                ...video,
                status: existing?.status || 'pending',
                quoteCount: existing?.quoteCount || 0
            });
        });

        // Update channel fetch time
        storage.updateChannelFetchTime(channelId);

        // Re-render
        renderChannels();
        renderVideos();
        updateStatus(`Fetched ${videos.length} videos from ${channel.title}`);

        hideProcessing();
    } catch (error) {
        hideProcessing();
        showError('Failed to fetch videos: ' + error.message);
    }
}

/**
 * Refresh all channels
 */
async function refreshAllChannels() {
    const channels = storage.getChannels();
    if (channels.length === 0) {
        showError('No channels to refresh');
        return;
    }

    showProcessing('Refreshing all channels...');

    let totalVideos = 0;
    for (const channel of channels) {
        try {
            elements.processingMessage.textContent = `Fetching videos from ${channel.title}...`;
            const videos = await getChannelVideos(channel.uploadsPlaylistId, apiKeys.youtube, 20);

            videos.forEach(video => {
                const existing = storage.getVideo(video.id);
                storage.addVideo({
                    ...video,
                    status: existing?.status || 'pending',
                    quoteCount: existing?.quoteCount || 0
                });
            });

            storage.updateChannelFetchTime(channel.id);
            totalVideos += videos.length;
        } catch (error) {
            console.error(`Failed to fetch from ${channel.title}:`, error);
        }
    }

    renderChannels();
    renderVideos();
    updateStatus(`Refreshed ${channels.length} channels, found ${totalVideos} videos`);
    hideProcessing();
}

/**
 * Render channels list
 */
function renderChannels() {
    const channels = storage.getChannels();

    if (channels.length === 0) {
        elements.channelsList.innerHTML = '<p class="empty-state">No channels subscribed yet. Add a channel above to get started.</p>';
        return;
    }

    elements.channelsList.innerHTML = channels.map(channel => `
        <div class="channel-item" data-channel-id="${channel.id}">
            <div class="channel-info">
                <img src="${channel.thumbnail}" alt="${channel.title}" class="channel-thumbnail">
                <div class="channel-details">
                    <span class="channel-name">${escapeHtml(channel.title)}</span>
                    <span class="channel-stats">
                        ${storage.getVideosByChannel(channel.id).length} videos tracked
                        ${channel.lastFetchedAt ? `· Last fetched: ${formatDate(channel.lastFetchedAt)}` : ''}
                    </span>
                </div>
            </div>
            <div class="channel-actions">
                <button onclick="window.fetchChannelVideos('${channel.id}')">Fetch Videos</button>
                <button class="remove" onclick="window.unsubscribeFromChannel('${channel.id}')">Remove</button>
            </div>
        </div>
    `).join('');
}

/**
 * Render videos list
 */
function renderVideos() {
    const channelFilter = elements.channelFilter.value;
    let videos = storage.getVideos();

    if (channelFilter !== 'all') {
        videos = videos.filter(v => v.channelId === channelFilter);
    }

    // Sort by publish date (newest first)
    videos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    if (videos.length === 0) {
        elements.videosList.innerHTML = '<p class="empty-state">No videos processed yet. Subscribe to a channel and click "Fetch Videos" to get started.</p>';
        return;
    }

    elements.videosList.innerHTML = videos.map(video => `
        <div class="video-card" onclick="window.openVideoModal('${video.id}')">
            <img src="${video.thumbnail}" alt="${escapeHtml(video.title)}" class="video-thumbnail">
            <div class="video-content">
                <h3 class="video-title">${escapeHtml(video.title)}</h3>
                <div class="video-meta">
                    <span class="video-channel-name">${escapeHtml(video.channelTitle)}</span>
                    <span class="video-date">${formatDate(video.publishedAt)}</span>
                </div>
                <div class="video-status">
                    <span class="status-badge status-${video.status}">${video.status}</span>
                    ${video.quoteCount ? `<span class="quote-count">${video.quoteCount} quotes</span>` : ''}
                </div>
            </div>
        </div>
    `).join('');
}

/**
 * Render quotes list
 */
function renderQuotes() {
    const channelFilter = elements.channelFilter.value;
    const searchQuery = elements.searchQuotes.value.trim().toLowerCase();

    let quotes = storage.getQuotes();

    if (channelFilter !== 'all') {
        quotes = quotes.filter(q => q.channelId === channelFilter);
    }

    if (searchQuery) {
        quotes = quotes.filter(q =>
            q.text.toLowerCase().includes(searchQuery) ||
            q.videoTitle?.toLowerCase().includes(searchQuery) ||
            q.channelTitle?.toLowerCase().includes(searchQuery)
        );
    }

    if (quotes.length === 0) {
        elements.quotesList.innerHTML = '<p class="empty-state">No quotes extracted yet.</p>';
        return;
    }

    elements.quotesList.innerHTML = quotes.map(quote => `
        <div class="quote-item">
            <p class="quote-text">${escapeHtml(quote.text)}</p>
            <div class="quote-source">
                <span class="quote-video-title">${escapeHtml(quote.videoTitle)}</span>
                <span class="quote-channel">${escapeHtml(quote.channelTitle)}</span>
                <span class="quote-timestamp">${formatDate(quote.extractedAt)}</span>
                <a href="https://www.youtube.com/watch?v=${quote.videoId}" target="_blank" class="video-link" style="margin-left: auto; padding: 3px 8px; font-size: 0.75rem;">Watch</a>
            </div>
        </div>
    `).join('');
}

/**
 * Update channel filter dropdown
 */
function updateChannelFilter() {
    const channels = storage.getChannels();
    const currentValue = elements.channelFilter.value;

    elements.channelFilter.innerHTML = '<option value="all">All Channels</option>' +
        channels.map(ch => `<option value="${ch.id}">${escapeHtml(ch.title)}</option>`).join('');

    // Restore selection if still valid
    if (channels.find(ch => ch.id === currentValue)) {
        elements.channelFilter.value = currentValue;
    }
}

/**
 * Switch between views
 */
function switchView(view) {
    currentView = view;

    // Update toggle buttons
    elements.viewToggle.querySelectorAll('.toggle-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.view === view);
    });

    // Show/hide views
    elements.videosView.style.display = view === 'videos' ? 'block' : 'none';
    elements.quotesView.style.display = view === 'quotes' ? 'block' : 'none';
}

/**
 * Open video modal
 */
function openVideoModal(videoId) {
    const video = storage.getVideo(videoId);
    if (!video) return;

    currentVideoId = videoId;

    elements.modalVideoTitle.textContent = video.title;
    elements.modalVideoChannel.textContent = video.channelTitle;
    elements.modalVideoDate.textContent = formatDate(video.publishedAt);
    elements.modalVideoLink.href = `https://www.youtube.com/watch?v=${videoId}`;

    // Render existing quotes for this video
    const quotes = storage.getQuotesByVideo(videoId);
    if (quotes.length > 0) {
        elements.videoQuotesList.innerHTML = quotes.map(quote => `
            <div class="quote-item">
                <p class="quote-text">${escapeHtml(quote.text)}</p>
                ${quote.context ? `<p style="color: #666; font-size: 0.85rem;"><em>Context: ${escapeHtml(quote.context)}</em></p>` : ''}
            </div>
        `).join('');
        elements.extractionStatus.textContent = `${quotes.length} quotes extracted`;
    } else {
        elements.videoQuotesList.innerHTML = '<p class="empty-state">No quotes extracted yet. Click "Extract Quotes" to analyze this video.</p>';
        elements.extractionStatus.textContent = '';
    }

    elements.videoModal.style.display = 'block';
}

/**
 * Close video modal
 */
function closeModal() {
    elements.videoModal.style.display = 'none';
    currentVideoId = null;
}

/**
 * Extract quotes for current video
 */
async function extractQuotesForCurrentVideo() {
    if (!currentVideoId) return;

    if (!apiKeys.openai) {
        showError('Please save your OpenAI API key first');
        return;
    }

    const video = storage.getVideo(currentVideoId);
    if (!video) return;

    elements.extractQuotesBtn.disabled = true;
    elements.extractionStatus.textContent = 'Fetching transcript...';

    try {
        // Fetch transcript
        const transcript = await getVideoTranscript(currentVideoId);

        elements.extractionStatus.textContent = 'Extracting quotes with AI...';

        // Extract quotes using OpenAI
        const quotes = await extractQuotes(transcript.fullText, video, apiKeys.openai);

        // Save quotes
        storage.addQuotes(currentVideoId, quotes);

        // Update UI
        elements.videoQuotesList.innerHTML = quotes.map(quote => `
            <div class="quote-item">
                <p class="quote-text">${escapeHtml(quote.text)}</p>
                ${quote.context ? `<p style="color: #666; font-size: 0.85rem;"><em>Context: ${escapeHtml(quote.context)}</em></p>` : ''}
            </div>
        `).join('');

        elements.extractionStatus.textContent = `${quotes.length} quotes extracted`;

        // Regenerate RSS feed
        regenerateRssFeed();

        // Re-render videos list to update status
        renderVideos();
        renderQuotes();

    } catch (error) {
        elements.extractionStatus.textContent = 'Error: ' + error.message;
        storage.updateVideoStatus(currentVideoId, 'error', error.message);
    } finally {
        elements.extractQuotesBtn.disabled = false;
    }
}

/**
 * Regenerate RSS feed
 */
function regenerateRssFeed() {
    const quotes = storage.getQuotes();
    const rssContent = generateRssFeed(quotes, {
        title: 'YouTube Quote Extractor',
        description: 'Notable quotes extracted from YouTube videos',
        link: window.location.origin + window.location.pathname.replace('quotes.html', '')
    });

    // Store in localStorage for reference
    localStorage.setItem('yt_quotes_rss', rssContent);

    updateStatus('RSS feed updated');
}

/**
 * Download RSS feed
 */
function downloadRss() {
    const quotes = storage.getQuotes();
    const rssContent = generateRssFeed(quotes, {
        title: 'YouTube Quote Extractor',
        description: 'Notable quotes extracted from YouTube videos',
        link: window.location.origin + window.location.pathname.replace('quotes.html', '')
    });
    downloadRssFeed(rssContent);
}

// ==================== Utility Functions ====================

function showProcessing(message) {
    elements.processingMessage.textContent = message;
    elements.processingStatus.style.display = 'flex';
}

function hideProcessing() {
    elements.processingStatus.style.display = 'none';
}

function showError(message) {
    elements.error.textContent = message;
    elements.error.style.display = 'block';
    setTimeout(() => {
        elements.error.style.display = 'none';
    }, 5000);
}

function updateStatus(message) {
    elements.statusBar.textContent = message;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ==================== Global Exports ====================

// Expose functions to global scope for inline event handlers
window.fetchChannelVideos = fetchChannelVideos;
window.unsubscribeFromChannel = unsubscribeFromChannel;
window.openVideoModal = openVideoModal;
window.downloadRss = downloadRss;

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
