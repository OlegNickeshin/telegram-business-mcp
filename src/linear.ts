/**
 * Minimal Linear GraphQL client.
 *
 * Personal API keys go in the Authorization header WITHOUT a "Bearer" prefix —
 * sending "Bearer lin_api_…" fails authentication. Only OAuth tokens use Bearer.
 * https://linear.app/developers/graphql
 */
const ENDPOINT = "https://api.linear.app/graphql";

export class LinearError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearIssueRef {
  id: string;
  identifier: string;
  title: string;
}

export interface LinearComment {
  id: string;
  createdAt: string;
  body: string;
  issue: { id: string; identifier: string } | null;
}

export class LinearClient {
  constructor(private readonly apiKey: string) {
    if (!apiKey.trim()) throw new Error("LINEAR_API_KEY is empty");
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.apiKey, // no "Bearer"
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new LinearError(`network error: ${(err as Error).message}`, undefined, true);
    }

    if (res.status === 429 || res.status >= 500) {
      throw new LinearError(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status, true);
    }
    if (!res.ok) {
      throw new LinearError(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`, res.status);
    }

    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) {
      const msg = body.errors.map((e) => e.message).join("; ");
      // Hitting the Free plan's 250-issue cap surfaces here, not as an HTTP error.
      throw new LinearError(`GraphQL error: ${msg}`);
    }
    if (!body.data) throw new LinearError("GraphQL response had no data");
    return body.data;
  }

  async viewer(): Promise<{ id: string; name: string; email: string }> {
    const d = await this.gql<{ viewer: { id: string; name: string; email: string } }>(
      `query { viewer { id name email } }`
    );
    return d.viewer;
  }

  async teams(): Promise<LinearTeam[]> {
    const d = await this.gql<{ teams: { nodes: LinearTeam[] } }>(
      `query { teams(first: 50) { nodes { id key name } } }`
    );
    return d.teams.nodes;
  }

  /** Finds an existing issue by exact title within a team, so a wiped local DB does not duplicate. */
  async findIssueByTitle(teamId: string, title: string): Promise<LinearIssueRef | null> {
    const d = await this.gql<{ issues: { nodes: LinearIssueRef[] } }>(
      `query ($teamId: ID!, $title: String!) {
         issues(first: 10, filter: { team: { id: { eq: $teamId } }, title: { eq: $title } }) {
           nodes { id identifier title }
         }
       }`,
      { teamId, title }
    );
    return d.issues.nodes[0] ?? null;
  }

  /**
   * Uploads bytes to Linear's asset storage and returns the URL to reference
   * from markdown. Two steps: ask for a pre-signed slot, then PUT the file with
   * exactly the headers Linear hands back.
   */
  async uploadAsset(
    filename: string,
    contentType: string,
    bytes: Buffer,
    makePublic = false
  ): Promise<string> {
    const d = await this.gql<{
      fileUpload: {
        success: boolean;
        uploadFile: {
          uploadUrl: string;
          assetUrl: string;
          headers: { key: string; value: string }[];
        };
      };
    }>(
      `mutation ($filename: String!, $contentType: String!, $size: Int!, $makePublic: Boolean) {
         fileUpload(filename: $filename, contentType: $contentType, size: $size, makePublic: $makePublic) {
           success
           uploadFile { uploadUrl assetUrl headers { key value } }
         }
       }`,
      { filename, contentType, size: bytes.length, makePublic }
    );
    if (!d.fileUpload?.success) throw new LinearError(`fileUpload failed for ${filename}`);

    const { uploadUrl, assetUrl, headers } = d.fileUpload.uploadFile;
    const h: Record<string, string> = { "content-type": contentType };
    for (const { key, value } of headers ?? []) h[key] = value;

    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: h,
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(120_000),
    });
    if (!put.ok) {
      throw new LinearError(
        `asset PUT returned HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`,
        put.status,
        put.status >= 500
      );
    }
    return assetUrl;
  }

  /**
   * Comments created after `sinceIso`, oldest first. One request per poll for
   * the whole workspace, rather than one per issue.
   */
  async commentsSince(sinceIso: string, limit = 50): Promise<LinearComment[]> {
    const d = await this.gql<{ comments: { nodes: LinearComment[] } }>(
      `query ($since: DateTimeOrDuration!, $limit: Int!) {
         comments(
           filter: { createdAt: { gt: $since } }
           orderBy: createdAt
           first: $limit
         ) {
           nodes { id createdAt body issue { id identifier } }
         }
       }`,
      { since: sinceIso, limit }
    );
    return d.comments.nodes;
  }

  async createIssue(teamId: string, title: string, description: string): Promise<LinearIssueRef> {
    const d = await this.gql<{ issueCreate: { success: boolean; issue: LinearIssueRef } }>(
      `mutation ($input: IssueCreateInput!) {
         issueCreate(input: $input) { success issue { id identifier title } }
       }`,
      { input: { teamId, title, description } }
    );
    if (!d.issueCreate.success) throw new LinearError(`issueCreate returned success=false for "${title}"`);
    return d.issueCreate.issue;
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    const d = await this.gql<{ commentUpdate: { success: boolean } }>(
      `mutation ($id: String!, $input: CommentUpdateInput!) {
         commentUpdate(id: $id, input: $input) { success }
       }`,
      { id: commentId, input: { body } }
    );
    if (!d.commentUpdate.success) throw new LinearError("commentUpdate returned success=false");
  }

  async createComment(issueId: string, body: string): Promise<string> {
    const d = await this.gql<{ commentCreate: { success: boolean; comment: { id: string } } }>(
      `mutation ($input: CommentCreateInput!) {
         commentCreate(input: $input) { success comment { id } }
       }`,
      { input: { issueId, body } }
    );
    if (!d.commentCreate.success) throw new LinearError("commentCreate returned success=false");
    return d.commentCreate.comment.id;
  }
}
