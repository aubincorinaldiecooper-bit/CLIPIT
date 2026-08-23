/**
 * Zernio API shapes — the publishing-and-analytics subset.
 *
 * Borrowed from populr's integration and trimmed to what CLIPIT uses:
 * profiles, hosted-OAuth connect, connected accounts, posting, and
 * analytics. CLIPIT does not do comments, DMs, or inboxes — its journey is
 * clip-first: cut a clip, publish it, then watch how it performed.
 *
 * Zernio responses vary in wrapping and casing across endpoints, so these
 * types are deliberately permissive; the client unwraps, and callers treat
 * everything as untrusted input.
 */

export type Json = Record<string, unknown>;

export interface ZernioProfile extends Json {
  id: string;
  name?: string;
}

export interface ZernioConnectUrlResponse extends Json {
  url?: string;
  connectUrl?: string;
  authUrl?: string;
}

export interface ZernioAccount extends Json {
  id?: string;
  accountId?: string;
  platform?: string;
  name?: string;
  username?: string;
  displayName?: string;
  status?: string;
}

/** A publish target: which connected account (on which platform) to post to. */
export interface ZernioPostTarget {
  platform: string;
  accountId: string;
}

/** Body for POST /posts. */
export interface ZernioCreatePostRequest extends Json {
  content: string;
  platforms: ZernioPostTarget[];
  mediaUrls?: string[];
  publishNow?: boolean;
}

/** Response from POST /posts (shape varies; typed permissively). */
export interface ZernioCreatePostResponse extends Json {
  id?: string;
  postId?: string;
  status?: string;
  publishedAt?: string;
  results?: Json[];
  platforms?: Json[];
}

/** A single post-analytics record from GET /analytics. */
export interface ZernioPostAnalytics extends Json {
  postId?: string;
  id?: string;
  platform?: string;
  accountId?: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  impressions?: number;
  engagement?: number;
}
