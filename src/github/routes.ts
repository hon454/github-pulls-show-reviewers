export type PullListRoute = {
  owner: string;
  repo: string;
};

const PULL_LIST_ROUTE = /^\/([^/]+)\/([^/]+)\/pulls(?:\/|$)/;

export function parsePullListRoute(pathname: string): PullListRoute | null {
  const match = pathname.match(PULL_LIST_ROUTE);
  if (match == null) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
  };
}
