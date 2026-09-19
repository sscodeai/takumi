/**
 * FakeGitLab — an in-process stand-in for the slice of the GitLab REST API v4
 * that `GitLabBoardProvider` uses.
 *
 * WHY a hand-written double instead of a mocking library: this repository ships
 * ZERO test dependencies, and the adapter must be provable with zero network and
 * zero credentials. The double therefore records every request it receives and
 * answers exactly like GitLab would — including the awkward parts (401 without
 * the token header, 404 for an unknown iid, 201 for a created note, label
 * add/remove semantics, project labels paged/created/409-on-duplicate, notes
 * attributed to the token's user).
 *
 * It is a test double, NOT a GitLab emulator: only the endpoints, fields and
 * statuses the adapter touches are modelled, and each one is documented with the
 * API fact it stands for.
 */

import type { BoardHttpRequest, BoardHttpResponse, BoardRequestFn } from '@takumi/core';

/** A note the board starts with (a stranger's or takumi's, decided by `author`). */
export interface FakeGitLabNoteSeed {
  body: string;
  /** Username GitLab would report as the note author. */
  author: string;
  createdAt?: string;
}

export interface FakeGitLabIssueSeed {
  iid: number;
  title?: string;
  description?: string;
  webUrl?: string;
  /** Default `opened`. */
  state?: string;
  labels?: string[];
  assignees?: string[];
  updatedAt?: string;
  notes?: FakeGitLabNoteSeed[];
}

export interface FakeGitLabOptions {
  /** Project path every URL must address (`group/project`). */
  project: string;
  /** Username GitLab attributes a written note to — i.e. the token's user. */
  username: string;
  /** When set, a request without `PRIVATE-TOKEN: <token>` gets 401. */
  token?: string;
  /** API path prefix to strip from the URL, default `/api/v4`. */
  apiPath?: string;
}

interface FakeNote {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

interface FakeIssue {
  iid: number;
  title: string;
  description: string;
  webUrl: string;
  state: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
  notes: FakeNote[];
}

/** A project-level label — the vocabulary state bootstrapping manages. */
interface FakeLabel {
  name: string;
  color: string;
}

/** A canned answer, optionally aimed at one kind of request. */
interface FakeFault {
  matches: (req: BoardHttpRequest) => boolean;
  once: boolean;
  response: BoardHttpResponse;
}

/** Deterministic clock: every mutation moves time forward by one second. */
const CLOCK_ORIGIN = Date.parse('2026-01-01T00:00:00.000Z');

export class FakeGitLab {
  private readonly issues = new Map<number, FakeIssue>();
  private readonly labels = new Map<string, FakeLabel>();
  private readonly recorded: BoardHttpRequest[] = [];
  private readonly faults: FakeFault[] = [];
  private readonly project: string;
  private readonly username: string;
  private readonly token: string | undefined;
  private readonly apiPath: string;
  private hook: ((req: BoardHttpRequest) => void) | null = null;
  private noteSeq = 0;
  private tick = 0;

  constructor(options: FakeGitLabOptions) {
    this.project = options.project;
    this.username = options.username;
    this.token = options.token;
    this.apiPath = options.apiPath ?? '/api/v4';
  }

  /** The request function to inject into a provider. */
  get request(): BoardRequestFn {
    return (req) => this.handle(req);
  }

  /** Every request seen so far, in order, as deep copies. */
  requests(): readonly BoardHttpRequest[] {
    return this.recorded;
  }

  /** `METHOD url` per request, in order — the shape assertion for the adapter. */
  calls(): string[] {
    return this.recorded.map((req) => `${req.method} ${req.url}`);
  }

  /** The JSON body of each request in order (`undefined` when the request had none). */
  bodies(): unknown[] {
    return this.recorded.map((req) => req.body);
  }

  /** Forget the recorded requests (seeding never records anything). */
  clear(): void {
    this.recorded.length = 0;
  }

  /** Add (or replace) an issue. Seeding is not a request, so it is not recorded. */
  seedIssue(seed: FakeGitLabIssueSeed): FakeGitLab {
    const issue: FakeIssue = {
      iid: seed.iid,
      title: seed.title ?? `Issue ${seed.iid}`,
      description: seed.description ?? '',
      webUrl: seed.webUrl ?? `https://gitlab.test/${this.project}/-/issues/${seed.iid}`,
      state: seed.state ?? 'opened',
      labels: [...(seed.labels ?? [])],
      assignees: [...(seed.assignees ?? [])],
      updatedAt: seed.updatedAt ?? this.now(),
      notes: (seed.notes ?? []).map((note) => ({
        id: ++this.noteSeq,
        body: note.body,
        author: note.author,
        createdAt: note.createdAt ?? this.now(),
      })),
    };
    this.issues.set(seed.iid, issue);
    return this;
  }

  /**
   * Append a note as if some OTHER user wrote it on the board. This is how a
   * test injects a drive-by comment: the adapter cannot author as a stranger
   * (GitLab derives the author from the token), so the only faithful way to
   * simulate a foreign write is to put the note straight into the board.
   */
  appendNote(iid: number, body: string, author: string, createdAt?: string): number {
    const issue = this.issues.get(iid);
    if (issue === undefined) throw new Error(`FakeGitLab: no seeded issue ${iid}`);
    const id = ++this.noteSeq;
    issue.notes.push({ id, body, author, createdAt: createdAt ?? this.now() });
    return id;
  }

  /** The notes physically on an issue, oldest first. */
  notesOf(iid: number): Array<{ id: number; body: string; author: string; createdAt: string }> {
    return (this.issues.get(iid)?.notes ?? []).map((note) => ({ ...note }));
  }

  /** The labels physically on an issue. */
  labelsOf(iid: number): string[] {
    return [...(this.issues.get(iid)?.labels ?? [])];
  }

  /**
   * Put a LABEL on the project (not on an issue) — the thing state bootstrapping
   * reads. Seeding is not a request, so it is not recorded.
   *
   * The colour is arbitrary on purpose: a test needs to seed a label with a
   * DIFFERENT colour to prove the adapter reports it `exists` and leaves it alone.
   */
  seedLabel(name: string, color = '#ededed'): FakeGitLab {
    this.labels.set(name, { name, color });
    return this;
  }

  /** Every label on the project, in creation order. */
  labelsOnBoard(): Array<{ name: string; color: string }> {
    return [...this.labels.values()].map((label) => ({ ...label }));
  }

  /** Answer the NEXT request with this response instead of routing it (status-code tests). */
  failNext(status: number, body = '{"message":"forced"}'): FakeGitLab {
    this.faults.push({ matches: () => true, once: true, response: { status, body } });
    return this;
  }

  /**
   * Answer every request matching `matches` with this response. Used to fail the
   * WRITE of a mutation after its reads succeeded, which is the interesting case
   * for the error taxonomy.
   */
  failWhen(matches: (req: BoardHttpRequest) => boolean, status: number, body = '{"message":"forced"}'): FakeGitLab {
    this.faults.push({ matches, once: false, response: { status, body } });
    return this;
  }

  /** Stop answering matching requests with a failure. */
  clearFaults(): FakeGitLab {
    this.faults.length = 0;
    return this;
  }

  /** Observe every request (read-only) — used to inject a competing write mid-flight. */
  onRequest(hook: (req: BoardHttpRequest) => void): FakeGitLab {
    this.hook = hook;
    return this;
  }

  // --- routing --------------------------------------------------------------

  private async handle(req: BoardHttpRequest): Promise<BoardHttpResponse> {
    const clone = cloneRequest(req);
    this.recorded.push(clone);
    this.hook?.(clone);

    const index = this.faults.findIndex((fault) => fault.matches(clone));
    if (index !== -1) {
      const fault = this.faults[index] as FakeFault;
      if (fault.once) this.faults.splice(index, 1);
      return fault.response;
    }

    // GitLab authenticates with `PRIVATE-TOKEN` and rejects anything else with 401.
    if (this.token !== undefined && clone.headers?.['PRIVATE-TOKEN'] !== this.token) {
      return json(401, { message: '401 Unauthorized' });
    }

    const route = this.route(clone);
    return route ?? json(404, { message: '404 Not Found' });
  }

  private route(req: BoardHttpRequest): BoardHttpResponse | null {
    let segments: string[];
    let url: URL;
    try {
      url = new URL(req.url);
      if (!url.pathname.startsWith(this.apiPath)) return null;
      segments = url.pathname
        .slice(this.apiPath.length)
        .split('/')
        .filter((part) => part.length > 0)
        .map((part) => decodeURIComponent(part));
    } catch {
      return json(400, { message: '400 Bad Request' });
    }

    // `/projects/:id/issues/:iid[/notes[/:note_id]]` and `/projects/:id/labels` —
    // the project segment is the URL-encoded full path, so a decoded
    // `group/project` arrives as ONE element.
    if (segments[0] !== 'projects' || segments[1] !== this.project) return null;

    // GET /labels supports `per_page`/`page`; GitLab reports the totals in
    // HEADERS (which the request seam does not expose), so a short page is the
    // only end-of-list signal — the same one the adapter walks on.
    if (segments[2] === 'labels') {
      if (segments.length !== 3) return null;
      if (req.method === 'GET') return json(200, this.listLabels(url));
      if (req.method === 'POST') return this.createLabel(req);
      return json(405, { message: '405 Method Not Allowed' });
    }

    if (segments[2] !== 'issues') return null;

    // GET /issues supports `state`, `labels` (comma-separated = AND) and `per_page`.
    if (segments.length === 3) {
      if (req.method !== 'GET') return json(405, { message: '405 Method Not Allowed' });
      return json(200, this.listIssues(url));
    }

    const iid = Number.parseInt(segments[3] ?? '', 10);
    if (!Number.isInteger(iid)) return null;
    const issue = this.issues.get(iid);
    if (issue === undefined) return null;

    if (segments.length === 4) {
      if (req.method === 'GET') return json(200, this.issueJson(issue));
      if (req.method === 'PUT') return this.updateLabels(issue, req);
      return json(405, { message: '405 Method Not Allowed' });
    }
    if (segments[4] !== 'notes') return null;

    if (segments.length === 5) {
      if (req.method === 'GET') return json(200, issue.notes.map((note) => this.noteJson(note)));
      // GitLab answers note creation with 201.
      if (req.method === 'POST') {
        const created = this.createNote(issue, req);
        return created === null ? json(400, { message: 'body is missing' }) : json(201, created);
      }
      return json(405, { message: '405 Method Not Allowed' });
    }
    if (segments.length === 6) {
      const noteId = Number.parseInt(segments[5] ?? '', 10);
      if (!Number.isInteger(noteId)) return null;
      const note = issue.notes.find((candidate) => candidate.id === noteId);
      if (note === undefined) return null;
      if (req.method === 'PUT') {
        const body = bodyOf(req);
        if (typeof body['body'] !== 'string') return json(400, { message: 'body is missing' });
        note.body = body['body'];
        return json(200, this.noteJson(note));
      }
      return json(405, { message: '405 Method Not Allowed' });
    }
    return null;
  }

  /** List-issue semantics: `state` filter, `labels` filter (all must match), `per_page` slice. */
  private listIssues(url: URL): Record<string, unknown>[] {
    const state = url.searchParams.get('state') ?? 'all';
    const wanted = url.searchParams
      .getAll('labels')
      .flatMap((value) => value.split(','))
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
    const perPage = Number.parseInt(url.searchParams.get('per_page') ?? '20', 10);
    return [...this.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .filter((issue) => wanted.every((label) => issue.labels.includes(label)))
      .slice(0, Number.isInteger(perPage) && perPage > 0 ? perPage : 20)
      .map((issue) => this.issueJson(issue));
  }

  /**
   * Label-list semantics: a plain array (the totals live in response headers
   * this double, like the seam, does not model), sliced by `per_page`/`page`.
   */
  private listLabels(url: URL): Record<string, unknown>[] {
    const perPage = Number.parseInt(url.searchParams.get('per_page') ?? '20', 10);
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const size = Number.isInteger(perPage) && perPage > 0 ? perPage : 20;
    const index = Number.isInteger(page) && page > 0 ? page : 1;
    return [...this.labels.values()].slice((index - 1) * size, index * size).map((label) => labelJson(label));
  }

  /**
   * Label-create semantics: `name` and `color` are both required (GitLab rejects
   * a colourless label with a 400), a duplicate is a 409, and a success is a 201.
   */
  private createLabel(req: BoardHttpRequest): BoardHttpResponse {
    const body = bodyOf(req);
    const name = body['name'];
    const color = body['color'];
    if (typeof name !== 'string' || name.length === 0) return json(400, { message: 'name is missing' });
    if (typeof color !== 'string' || color.length === 0) return json(400, { message: 'color is missing' });
    if (this.labels.has(name)) return json(409, { message: 'Label already exists' });
    const label: FakeLabel = { name, color };
    this.labels.set(name, label);
    return json(201, labelJson(label));
  }

  /**
   * Label update semantics, as GitLab documents them: `add_labels` and
   * `remove_labels` are COMMA-SEPARATED STRINGS (an array is a 400), removal
   * happens first and addition second.
   */
  private updateLabels(issue: FakeIssue, req: BoardHttpRequest): BoardHttpResponse {
    const body = bodyOf(req);
    const add = body['add_labels'];
    const remove = body['remove_labels'];
    if (Array.isArray(add) || Array.isArray(remove)) {
      return json(400, { message: 'add_labels and remove_labels must be comma-separated strings' });
    }
    const labels = new Set(issue.labels);
    for (const label of splitLabels(remove)) labels.delete(label);
    for (const label of splitLabels(add)) labels.add(label);
    issue.labels = [...labels];
    issue.updatedAt = this.now();
    return json(200, this.issueJson(issue));
  }

  private createNote(issue: FakeIssue, req: BoardHttpRequest): Record<string, unknown> | null {
    const body = bodyOf(req);
    if (typeof body['body'] !== 'string') return null;
    const note: FakeNote = { id: ++this.noteSeq, body: body['body'], author: this.username, createdAt: this.now() };
    issue.notes.push(note);
    return this.noteJson(note);
  }

  private issueJson(issue: FakeIssue): Record<string, unknown> {
    return {
      id: issue.iid * 1000,
      iid: issue.iid,
      project_id: 42,
      title: issue.title,
      description: issue.description,
      state: issue.state,
      labels: [...issue.labels],
      web_url: issue.webUrl,
      assignees: issue.assignees.map((username) => ({ username })),
      updated_at: issue.updatedAt,
    };
  }

  private noteJson(note: FakeNote): Record<string, unknown> {
    return {
      id: note.id,
      body: note.body,
      author: { id: 7, username: note.author },
      created_at: note.createdAt,
      system: false,
    };
  }

  private now(): string {
    this.tick += 1;
    return new Date(CLOCK_ORIGIN + this.tick * 1000).toISOString();
  }
}

function json(status: number, payload: unknown): BoardHttpResponse {
  return { status, body: JSON.stringify(payload) };
}

function bodyOf(req: BoardHttpRequest): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {};
}

/**
 * A project label as GitLab returns it. The `id`/`description`/`priority` fields
 * are NOT modelled: `bootstrapStates` asks only whether a NAME exists, and this
 * double only models what the adapter reads.
 */
function labelJson(label: FakeLabel): Record<string, unknown> {
  return { name: label.name, color: label.color, is_project_label: true };
}

function splitLabels(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

function cloneRequest(req: BoardHttpRequest): BoardHttpRequest {
  const clone: BoardHttpRequest = { method: req.method, url: req.url };
  if (req.headers !== undefined) clone.headers = { ...req.headers };
  if (req.body !== undefined) clone.body = JSON.parse(JSON.stringify(req.body)) as unknown;
  return clone;
}
