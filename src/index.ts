import { Shop, JsonObject } from '@shoprag/core';
import { TwitterApi, TweetV2, UserV2 } from 'twitter-api-v2';

/**
 * Configuration interface for the XShop.
 */
interface Config {
    users?: string[];           // List of user handles to fetch posts from
    hashtags?: string[];        // List of hashtags to fetch posts for
    startDate?: string;         // ISO date string for earliest posts
    dropAfter?: string;         // Duration to drop old posts (e.g., "1y")
    dirtyWords?: string[];      // Words to exclude posts containing
    includeHeader?: boolean;    // Include header in content, default true
    noDelete?: boolean;         // Prevent deletions, default false
}

/**
 * Interface for filter settings.
 */
interface Filters {
    startDate?: Date;
    dropAfter?: number; // Duration in milliseconds
    dirtyWords?: string[];
}

/**
 * Interface for a tweet with its author and optional reply-to user.
 */
interface TweetWithAuthor {
    tweet: TweetV2;
    author: UserV2;
    replyToUser?: UserV2;
}

/**
 * X Shop plugin for ShopRAG.
 * Fetches posts from X (Twitter) for specified users and/or hashtags, applying filters.
 *
 * **Config options:**
 * - `users`: Array of user handles to fetch posts from.
 * - `hashtags`: Array of hashtags (without #) to fetch posts for.
 * - `startDate`: Only include posts after this date (ISO format).
 * - `dropAfter`: Drop posts older than this duration (e.g., "1y" for one year).
 * - `dirtyWords`: Exclude posts containing these words (case-insensitive).
 * - `includeHeader`: If true, includes a header with metadata. Default: true.
 * - `noDelete`: If true, prevents deletion of posts. Default: false.
 */
export default class XShop implements Shop {
    private twitter: TwitterApi;
    private userIds: string[] = [];
    private hashtags: string[] = [];
    private filters: Filters = {};
    private includeHeader: boolean = true;
    private noDelete: boolean = false;

    /**
     * Defines the credentials required by this Shop.
     * @returns Object specifying the Twitter bearer token and instructions.
     */
    requiredCredentials(): { [credentialName: string]: string } {
        return {
            twitter_bearer_token: `To obtain a Twitter bearer token:
1. Go to https://developer.twitter.com/
2. Sign in with your Twitter account.
3. Create a new app or select an existing one in the Developer Portal.
4. Ensure your app has 'Read' access permissions.
5. Generate a bearer token from the 'Keys and Tokens' section.
6. Copy the bearer token and paste it here.`
        };
    }

    /**
     * Initializes the Shop with credentials and configuration.
     * Resolves user handles to IDs and sets up filters.
     * @param credentials User-provided Twitter bearer token.
     * @param config Configuration object from shoprag.json.
     */
    async init(credentials: { [key: string]: string }, config: JsonObject): Promise<void> {
        const bearerToken = credentials['twitter_bearer_token'];
        if (!bearerToken) {
            throw new Error('Twitter bearer token is required.');
        }
        this.twitter = new TwitterApi(bearerToken);

        const cfg = config as unknown as Config;
        this.hashtags = cfg.hashtags || [];
        this.filters = {
            startDate: cfg.startDate ? new Date(cfg.startDate) : undefined,
            dropAfter: cfg.dropAfter ? this.parseDropAfter(cfg.dropAfter) : undefined,
            dirtyWords: cfg.dirtyWords
        };
        this.includeHeader = cfg.includeHeader !== false; // Default true
        this.noDelete = cfg.noDelete === true;

        // Resolve user handles to IDs
        if (cfg.users) {
            const userPromises = cfg.users.map(async (handle) => {
                try {
                    const user = await this.twitter.v2.userByUsername(handle, { 'user.fields': ['id'] });
                    if (user.data?.id) {
                        return user.data.id;
                    } else {
                        console.warn(`User ${handle} not found.`);
                        return null;
                    }
                } catch (error) {
                    console.error(`Error resolving user ${handle}:`, error);
                    return null;
                }
            });
            const resolvedIds = await Promise.all(userPromises);
            this.userIds = resolvedIds.filter((id): id is string => id !== null);
        }
    }

    /**
     * Parses dropAfter duration into milliseconds.
     * @param dropAfter Duration string (e.g., "1d", "2w", "3m", "1y").
     * @returns Duration in milliseconds.
     */
    private parseDropAfter(dropAfter: string): number {
        const unit = dropAfter.slice(-1);
        const value = parseInt(dropAfter.slice(0, -1), 10);
        switch (unit) {
            case 'd': return value * 24 * 60 * 60 * 1000; // days
            case 'w': return value * 7 * 24 * 60 * 60 * 1000; // weeks
            case 'm': return value * 30 * 24 * 60 * 60 * 1000; // months (approx)
            case 'y': return value * 365 * 24 * 60 * 60 * 1000; // years (approx)
            default: throw new Error(`Invalid dropAfter unit: ${unit}`);
        }
    }

    /**
     * Fetches tweets for a user since the specified start time.
     * @param userId User ID.
     * @param startTime ISO date string or undefined for first run.
     * @returns Array of tweets with author and reply-to user info.
     */
    private async fetchUserTweets(userId: string, startTime?: string): Promise<TweetWithAuthor[]> {
        console.log(`Fetching tweets for user ID ${userId} since ${startTime || 'beginning'}`);
        const tweetsWithAuthors: TweetWithAuthor[] = [];
        const timeline = await this.twitter.v2.userTimeline(userId, {
            start_time: startTime,
            max_results: 100,
            expansions: ['author_id', 'in_reply_to_user_id'],
            'tweet.fields': ['created_at', 'text', 'in_reply_to_user_id'],
            'user.fields': ['username']
        });
        const timelineIterator = timeline.fetchAndIterate()

        for await (const [tweet, iter] of timelineIterator) {
            const users = iter.includes?.users || [];
            const author = users.find(u => u.id === tweet.author_id);
            const replyToUser = tweet.in_reply_to_user_id
                ? users.find(u => u.id === tweet.in_reply_to_user_id)
                : undefined;
            if (author) {
                tweetsWithAuthors.push({ tweet, author, replyToUser });
            }
        }
        return tweetsWithAuthors;
    }

    /**
     * Fetches tweets for a hashtag since the specified start time (last 7 days max for recent search).
     * @param hashtag Hashtag without #.
     * @param startTime ISO date string or undefined for first run.
     * @returns Array of tweets with author and reply-to user info.
     */
    private async fetchHashtagTweets(hashtag: string, startTime?: string): Promise<TweetWithAuthor[]> {
        console.log(`Fetching tweets for hashtag #${hashtag} since ${startTime || 'beginning'}`);
        const query = `#${hashtag}`;
        const search = this.twitter.v2.search(query, {
            start_time: startTime,
            max_results: 100,
            expansions: ['author_id', 'in_reply_to_user_id'],
            'tweet.fields': ['created_at', 'text', 'in_reply_to_user_id'],
            'user.fields': ['username']
        });
        const searchIterator = (await search).fetchAndIterate()

        const tweetsWithAuthors: TweetWithAuthor[] = [];
        for await (const [tweet, iter] of searchIterator) {
            const users = iter.includes?.users || [];
            const author = users.find(u => u.id === tweet.author_id);
            const replyToUser = tweet.in_reply_to_user_id
                ? users.find(u => u.id === tweet.in_reply_to_user_id)
                : undefined;
            if (author) {
                tweetsWithAuthors.push({ tweet, author, replyToUser });
            }
        }
        return tweetsWithAuthors;
    }

    /**
     * Applies configured filters to a tweet.
     * @param tweet Tweet object.
     * @returns True if the tweet passes all filters.
     */
    private applyFilters(tweet: TweetV2): boolean {
        const createdAt = new Date(tweet.created_at);
        if (this.filters.startDate && createdAt < this.filters.startDate) return false;
        if (this.filters.dropAfter) {
            const age = Date.now() - createdAt.getTime();
            if (age > this.filters.dropAfter) return false;
        }
        if (this.filters.dirtyWords) {
            const text = tweet.text.toLowerCase();
            if (this.filters.dirtyWords.some(word => text.includes(word.toLowerCase()))) return false;
        }
        return true;
    }

    /**
     * Generates formatted content for a tweet, optionally with a header.
     * @param twa Tweet with author and reply-to user info.
     * @returns Formatted content string.
     */
    private generateContent(twa: TweetWithAuthor): string {
        const tweet = twa.tweet;
        const author = twa.author;
        const replyToHandle = twa.replyToUser ? `@${twa.replyToUser.username}` : '';
        const content = tweet.text;

        if (!this.includeHeader) return content;

        const handle = author.username;
        const date = tweet.created_at;
        const replyTo = replyToHandle ? `made in reply to ${replyToHandle}` : '';
        return `X Post by @${handle}:\n${replyTo ? replyTo + '\n' : ''}Date: ${date}\n${content}\n[end of post]`;
    }

    /**
     * Generates updates by fetching new posts and comparing with existing files.
     * @param lastUsed Timestamp of the last run.
     * @param existingFiles Dictionary of existing file IDs and their timestamps.
     * @returns Dictionary of updates with actions ('add' or 'delete') and content.
     */
    async update(
        lastUsed: number,
        existingFiles: { [fileId: string]: number }
    ): Promise<{ [fileId: string]: { action: 'add' | 'update' | 'delete'; content?: string } }> {
        try {
            const startTime = lastUsed > 0 ? new Date(lastUsed).toISOString() : undefined;

            // Fetch tweets for all users and hashtags in parallel
            const userPromises = this.userIds.map(userId => this.fetchUserTweets(userId, startTime));
            const hashtagPromises = this.hashtags.map(hashtag => this.fetchHashtagTweets(hashtag, startTime));
            const allPromises = [...userPromises, ...hashtagPromises];
            const allResults = await Promise.all(allPromises);
            const allTweetsWithAuthors = allResults.flat();

            // Deduplicate tweets by ID
            const uniqueTweetsMap = new Map<string, TweetWithAuthor>();
            for (const twa of allTweetsWithAuthors) {
                if (!uniqueTweetsMap.has(twa.tweet.id)) {
                    uniqueTweetsMap.set(twa.tweet.id, twa);
                }
            }
            const uniqueTweetsWithAuthors = Array.from(uniqueTweetsMap.values());

            // Apply filters
            const filteredTweetsWithAuthors = uniqueTweetsWithAuthors.filter(twa => this.applyFilters(twa.tweet));

            // Generate updates
            const updates: { [fileId: string]: { action: 'add' | 'update' | 'delete'; content?: string } } = {};
            const currentFileIds = new Set<string>();

            for (const twa of filteredTweetsWithAuthors) {
                const fileId = `x-post-${twa.tweet.id}`;
                currentFileIds.add(fileId);
                if (!(fileId in existingFiles)) {
                    const content = this.generateContent(twa);
                    updates[fileId] = { action: 'add', content };
                }
            }

            // Handle deletions if noDelete is false
            if (!this.noDelete) {
                for (const fileId in existingFiles) {
                    if (!currentFileIds.has(fileId) && existingFiles[fileId] > lastUsed) {
                        updates[fileId] = { action: 'delete' };
                    }
                }
            }

            console.log(`Generated ${Object.keys(updates).length} updates.`);
            return updates;
        } catch (error) {
            console.error('Error in update:', error);
            return {};
        }
    }
}