import { lookup } from 'node:dns/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { DevBrainError } from '@devbrain/contracts';

export const isPublicAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    const n = address.split('.').map(Number);
    const a = n[0] ?? 0,
      b = n[1] ?? 0;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 192 && b === 88) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && n[2] === 100) return false;
    if (a === 203 && b === 0 && n[2] === 113) return false;
    return true;
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    // Global unicast only. 6to4 (2002::/16) and Teredo (2001:0::/32) embed IPv4 addresses
    // (possibly private ones) and are tunnelled, so they are rejected like private ranges.
    return (
      /^[23]/.test(normalized) &&
      !normalized.startsWith('2001:db8') &&
      !normalized.startsWith('2002:') &&
      !/^2001:0{0,4}:/.test(normalized)
    );
  }
  return false;
};

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: IncomingMessage;
}

/** HTTPS-only remote transport; local HTTP requires an explicit loopback flag. */
export class SafeHttpTransport {
  async open(input: {
    url: string;
    method?: 'GET' | 'POST' | 'DELETE';
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    allowLoopback?: boolean;
    timeoutMs?: number;
  }): Promise<HttpResponse> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new DevBrainError('VALIDATION_FAILED', 'Invalid endpoint URL');
    }
    if (url.username || url.password || url.hash)
      throw new DevBrainError('PERMISSION_DENIED', 'Endpoint URL contains credentials or fragment');
    const loopbackHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    if (
      url.protocol !== 'https:' &&
      !(input.allowLoopback && loopbackHost && url.protocol === 'http:')
    )
      throw new DevBrainError('PERMISSION_DENIED', 'Remote endpoint must use HTTPS');
    if (loopbackHost && !input.allowLoopback)
      throw new DevBrainError('PERMISSION_DENIED', 'Local endpoint requires authorization');
    if (input.signal?.aborted) throw new DevBrainError('CANCELLED', 'Request cancelled');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let resolved: { address: string; family: number }[];
    try {
      resolved = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Provider DNS lookup failed');
    }
    if (input.signal?.aborted) throw new DevBrainError('CANCELLED', 'Request cancelled');
    if (
      resolved.length === 0 ||
      resolved.some((r) =>
        loopbackHost ? !['127.0.0.1', '::1'].includes(r.address) : !isPublicAddress(r.address),
      )
    )
      throw new DevBrainError('PERMISSION_DENIED', 'Endpoint resolves to a restricted address');
    const pin = loopbackHost
      ? (resolved.find((r) => r.address === '127.0.0.1') ?? resolved[0]!)
      : resolved[0]!;
    const client = url.protocol === 'https:' ? https : http;
    return new Promise<HttpResponse>((resolve, reject) => {
      let responseBody: IncomingMessage | null = null;
      const req = client.request(
        url,
        {
          method: input.method ?? 'POST',
          headers: input.headers,
          timeout: input.timeoutMs ?? 60_000,
          lookup: (_hostname, _options, callback) => callback(null, pin.address, pin.family),
        },
        (body) => {
          responseBody = body;
          body.once('close', () => input.signal?.removeEventListener('abort', onAbort));
          const status = body.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            body.destroy();
            reject(new DevBrainError('PERMISSION_DENIED', 'Endpoint redirect rejected'));
            return;
          }
          resolve({ status, headers: body.headers, body });
        },
      );
      req.on('error', (error) =>
        reject(
          input.signal?.aborted
            ? new DevBrainError('CANCELLED', 'Request cancelled')
            : new DevBrainError('PROVIDER_UNAVAILABLE', 'Network request failed', { cause: error }),
        ),
      );
      req.on('timeout', () =>
        req.destroy(new DevBrainError('TIMEOUT', 'Provider request timed out')),
      );
      const onAbort = () => {
        const error = new DevBrainError('CANCELLED', 'Request cancelled');
        responseBody?.destroy(error);
        req.destroy(error);
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      req.on('close', () => {
        if (!responseBody) input.signal?.removeEventListener('abort', onAbort);
      });
      req.end(input.body);
    });
  }

  async json(
    input: Parameters<SafeHttpTransport['open']>[0],
    maxBytes = 8_000_000,
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: unknown }> {
    const response = await this.open(input);
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > maxBytes) {
        response.body.destroy();
        throw new DevBrainError('VALIDATION_FAILED', 'Provider response is too large');
      }
      chunks.push(bytes);
    }
    try {
      return {
        status: response.status,
        headers: response.headers,
        data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      };
    } catch {
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Invalid provider JSON response');
    }
  }
}
