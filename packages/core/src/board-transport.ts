/**
 * The HTTP seam every network-backed board adapter uses.
 *
 * Adapters stay testable without a token or a network because they never call
 * `fetch`/`curl` themselves: they receive a {@link BoardRequestFn} and the
 * default implementation ({@link createCurlRequestFn}) shells out to `curl`.
 * Tests inject a recorded fake, so the shared contract suite runs offline.
 *
 * Errors are classified once, here, so every adapter reports the same
 * vocabulary: a `transport` failure may be retried on the next tick, an `auth`
 * or `precondition` failure must not be.
 */

import { spawn } from 'node:child_process';
import { BoardError, type BoardErrorKind } from './task-board.js';

export interface BoardHttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** JSON-serializable body; omitted for GET/DELETE. */
  body?: unknown;
  timeoutSeconds?: number;
}

export interface BoardHttpResponse {
  status: number;
  /** Raw response body as text. */
  body: string;
}

export type BoardRequestFn = (req: BoardHttpRequest) => Promise<BoardHttpResponse>;

/** Map one HTTP status onto the board error taxonomy. */
export function classifyBoardHttpStatus(status: number): BoardErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 405) return 'unsupported';
  if (status === 400 || status === 409 || status === 412 || status === 422) return 'precondition';
  if (status === 429 || status >= 500) return 'transport';
  // Any other 4xx is a request-shape problem: retrying it changes nothing.
  return status >= 400 ? 'precondition' : 'transport';
}

/** Build the classified error for a non-2xx response. */
export function boardErrorFromResponse(res: BoardHttpResponse, what: string, item?: string): BoardError {
  const kind = classifyBoardHttpStatus(res.status);
  const detail = res.body.trim().replace(/\s+/g, ' ').slice(0, 300);
  return new BoardError(kind, `${what} failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`, {
    ...(item === undefined ? {} : { item }),
  });
}

/** Throw unless the response is 2xx. */
export function assertBoardHttpOk(res: BoardHttpResponse, what: string, item?: string): void {
  if (res.status < 200 || res.status >= 300) throw boardErrorFromResponse(res, what, item);
}

/** Parse a JSON response body, failing as a transport error when it is not JSON. */
export function parseBoardJson<T>(res: BoardHttpResponse, what: string): T {
  try {
    return JSON.parse(res.body) as T;
  } catch (e) {
    throw new BoardError('transport', `${what} returned a non-JSON body (HTTP ${res.status}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Send a request and require 2xx, returning the parsed JSON body. */
export async function requestBoardJson<T>(request: BoardRequestFn, req: BoardHttpRequest, what: string): Promise<T> {
  const res = await request(req);
  assertBoardHttpOk(res, what);
  return parseBoardJson<T>(res, what);
}

/**
 * Quote a value for curl's config-file grammar (used with `-K -`).
 *
 * The escapes curl itself understands are reproduced explicitly, so a header
 * value or a JSON body can never break out of the quoted string and inject
 * another option.
 */
function curlConfigValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

export interface CurlRequestFnOptions {
  /** Resolve the headers per request (tokens are read here, never stored). */
  headers?: () => Record<string, string>;
  /** Per-request timeout, default 30s. `curl -m` is always set: a board call must never hang a tick. */
  timeoutSeconds?: number;
  /** Override the curl binary (tests may point at a stub). */
  curlBinary?: string;
  /** Refuse a response larger than this (default 32 MiB) instead of buffering it. */
  maxOutputBytes?: number;
}

/**
 * The default transport: `curl`, configured with an explicit method, headers,
 * a JSON body and a hard timeout.
 *
 * Why curl and not a client library: it keeps every adapter dependency-free
 * (this repository ships zero HTTP clients), and it is the same transport the
 * operator can reproduce by hand when a tick fails.
 *
 * The child is spawned ASYNCHRONOUSLY on purpose: board calls happen inside an
 * event loop that also drives the rest of the tick, and a blocking call would
 * freeze everything else (it also deadlocks any in-process test server).
 */
export function createCurlRequestFn(opts: CurlRequestFnOptions = {}): BoardRequestFn {
  const curlBinary = opts.curlBinary ?? 'curl';
  const maxOutputBytes = opts.maxOutputBytes ?? 32 * 1024 * 1024;
  return (req) => {
    const timeoutSeconds = req.timeoutSeconds ?? opts.timeoutSeconds ?? 30;
    const headers = { ...(opts.headers?.() ?? {}), ...(req.headers ?? {}) };
    // EVERYTHING, including headers and the body, travels on STDIN via `-K -`.
    // Passing them as argv would put an API token in the process list, where any
    // local user can read it with `ps`. Only non-secret flags stay in argv.
    // The status code is appended to stdout so one call yields both parts; the
    // body itself may contain newlines, so the LAST line is the status.
    const configLines: string[] = [
      `request = ${curlConfigValue(req.method)}`,
      `max-time = ${curlConfigValue(String(timeoutSeconds))}`,
    ];
    for (const [name, value] of Object.entries(headers)) {
      configLines.push(`header = ${curlConfigValue(`${name}: ${value}`)}`);
    }
    if (req.body !== undefined) {
      configLines.push(`header = ${curlConfigValue('Content-Type: application/json')}`);
      configLines.push(`data-binary = ${curlConfigValue(JSON.stringify(req.body))}`);
    }
    configLines.push(`url = ${curlConfigValue(req.url)}`);
    const args: string[] = ['-sS', '-K', '-', '-w', '\n%{http_code}'];

    return new Promise<BoardHttpResponse>((resolve, reject) => {
      const child = spawn(curlBinary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin?.end(`${configLines.join('\n')}\n`);
      let stdout = '';
      let stderr = '';
      let settled = false;
      const what = `${req.method} ${req.url}`;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        fn();
      };
      const fail = (err: BoardError): void => finish(() => reject(err));

      // Belt and braces: curl's own `-m` handles the normal case; this guard
      // covers a curl that is wedged before it can apply it.
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new BoardError('transport', `${what} exceeded ${timeoutSeconds + 5}s and was killed`));
      }, (timeoutSeconds + 5) * 1000);
      killTimer.unref();

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > maxOutputBytes) {
          child.kill('SIGKILL');
          fail(new BoardError('transport', `${what} returned more than ${maxOutputBytes} bytes`));
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (e: Error) => {
        fail(new BoardError('transport', `${what} failed: ${e.message}`, { cause: e }));
      });
      child.on('close', (code: number | null) => {
        if (settled) return;
        if (code !== 0) {
          fail(new BoardError('transport', `${what} exited ${code}: ${stderr.trim().slice(0, 300)}`));
          return;
        }
        const lastNewline = stdout.lastIndexOf('\n');
        if (lastNewline === -1) {
          fail(new BoardError('transport', `${what} returned no status line`));
          return;
        }
        const status = Number.parseInt(stdout.slice(lastNewline + 1).trim(), 10);
        if (!Number.isInteger(status)) {
          fail(new BoardError('transport', `${what} returned an unparseable status`));
          return;
        }
        const body = stdout.slice(0, lastNewline);
        finish(() => resolve({ status, body }));
      });
    });
  };
}

/**
 * A request function that always fails: the safe default when no transport is
 * injected, so an accidental network call is an explicit `auth` error instead
 * of a silent hang or an unauthenticated request.
 */
export function unconfiguredRequestFn(providerId: string): BoardRequestFn {
  return async (req) => {
    throw new BoardError(
      'auth',
      `${providerId}: no request transport configured for ${req.method} ${req.url} — inject one (tests) or provide credentials`,
    );
  };
}
