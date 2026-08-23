import { env } from '../../config/env.js';
import type {
  Json,
  ZernioAccount,
  ZernioConnectUrlResponse,
  ZernioCreatePostRequest,
  ZernioCreatePostResponse,
  ZernioPostAnalytics,
  ZernioProfile,
} from './types.js';

/**
 * Thin, typed wrapper over the Zernio REST API — the publishing-and-analytics
 * subset, borrowed from populr's integration.
 *
 * Error handling rule inherited with the code: a ZernioApiError carries the
 * raw upstream body for the CALLER to inspect statuses on, but that body may
 * contain tokens or billing identifiers — it must never be logged wholesale
 * or forwarded to a browser.
 */
export class ZernioApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ZernioApiError';
  }
}

type QueryParams = Record<string, string | number | boolean | undefined>;

export function zernioConfigured(): boolean {
  return Boolean(env.ZERNIO_BASE_URL && env.ZERNIO_API_KEY);
}

export class ZernioClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts?: { baseUrl?: string; apiKey?: string }) {
    this.baseUrl = (opts?.baseUrl ?? env.ZERNIO_BASE_URL ?? '').replace(/\/+$/, '');
    this.apiKey = opts?.apiKey ?? env.ZERNIO_API_KEY ?? '';
  }

  private buildUrl(path: string, params?: QueryParams): string {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts?: { params?: QueryParams; body?: Json },
  ): Promise<T> {
    if (!this.baseUrl || !this.apiKey) {
      throw new ZernioApiError('Zernio is not configured on this deployment', 503, null);
    }
    const res = await fetch(this.buildUrl(path, opts?.params), {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(opts?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      throw new ZernioApiError(`Zernio ${method} ${path} failed with ${res.status}`, res.status, parsed);
    }
    return parsed as T;
  }

  /**
   * Zernio wraps some lists as `{ data: [...] }` or `{ accounts: [...] }`
   * and returns others bare. This unwraps both shapes.
   */
  private unwrapList<T>(payload: unknown, keys: string[]): T[] {
    if (Array.isArray(payload)) return payload as T[];
    if (payload && typeof payload === 'object') {
      const obj = payload as Json;
      for (const key of keys) {
        if (Array.isArray(obj[key])) return obj[key] as T[];
      }
    }
    return [];
  }

  private unwrapObject<T>(payload: unknown, keys: string[]): T {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const obj = payload as Json;
      for (const key of keys) {
        if (obj[key] && typeof obj[key] === 'object') return obj[key] as T;
      }
    }
    return payload as T;
  }

  // --- Profiles (one Zernio workspace per CLIPIT user) ---------------------

  async createProfile(body: { name: string }): Promise<ZernioProfile> {
    const res = await this.request<unknown>('POST', '/profiles', { body });
    return this.unwrapObject<ZernioProfile>(res, ['profile', 'data']);
  }

  // --- Connect (hosted OAuth) ----------------------------------------------

  /**
   * GET /connect/{platform} → hosted-OAuth URL to send the user to. Zernio's
   * query param for the OAuth return target is `redirect_url` (snake_case) —
   * the wrong key is silently ignored, which strands the state token.
   */
  async getConnectUrl(platform: string, params: { profileId?: string; redirectUrl?: string } = {}): Promise<string> {
    const res = await this.request<ZernioConnectUrlResponse>('GET', `/connect/${platform}`, {
      params: { profileId: params.profileId, redirect_url: params.redirectUrl },
    });
    const url = res.url ?? res.connectUrl ?? res.authUrl;
    if (!url) {
      throw new ZernioApiError(`Zernio did not return a connect URL for ${platform}`, 502, res);
    }
    return url;
  }

  // --- Accounts -------------------------------------------------------------

  async listAccounts(params: { profileId?: string } = {}): Promise<ZernioAccount[]> {
    const res = await this.request<unknown>('GET', '/accounts', { params: { profileId: params.profileId } });
    return this.unwrapList<ZernioAccount>(res, ['accounts', 'data', 'items']);
  }

  async disconnectAccount(accountId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/accounts/${accountId}`);
  }

  // --- Posting --------------------------------------------------------------

  async createPost(body: ZernioCreatePostRequest): Promise<ZernioCreatePostResponse> {
    const res = await this.request<unknown>('POST', '/posts', { body });
    return this.unwrapObject<ZernioCreatePostResponse>(res, ['post', 'data']);
  }

  async getPost(postId: string): Promise<ZernioCreatePostResponse> {
    const res = await this.request<unknown>('GET', `/posts/${postId}`);
    return this.unwrapObject<ZernioCreatePostResponse>(res, ['post', 'data']);
  }

  // --- Analytics ------------------------------------------------------------

  /**
   * GET /analytics → post-level analytics. This is what turns the home
   * screen's honest dashes into measured numbers — and only this: a post we
   * never published has no row here, and that absence stays visible.
   */
  async getPostAnalytics(
    params: { accountId?: string; platform?: string; fromDate?: string; toDate?: string; limit?: number } = {},
  ): Promise<ZernioPostAnalytics[]> {
    const res = await this.request<unknown>('GET', '/analytics', { params });
    return this.unwrapList<ZernioPostAnalytics>(res, ['posts', 'data', 'analytics', 'items']);
  }
}

export const zernio = new ZernioClient();
