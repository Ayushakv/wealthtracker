// An in-memory stand-in for the bits of GitHub's gist API that sync uses.

export function fakeGitHub({ token = 'ghp_test', login = 'example-user' } = {}) {
  const gists = new Map();
  let next = 1;
  const calls = [];

  /** @returns {{ status: number, body: any }} */
  function handle({ method, url, headers = {}, body }) {
    const u = new URL(url);
    calls.push(`${method} ${u.pathname}`);
    const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
    if (auth !== `Bearer ${token}`) return { status: 401, body: { message: 'Bad credentials' } };
    const data = body ? JSON.parse(body) : null;
    const view = (g) => ({ id: g.id, description: g.description, public: false, files: Object.fromEntries(Object.entries(g.files).map(([name, f]) => [name, { filename: name, content: f.content, truncated: false }])) });
    if (method === 'GET' && u.pathname === '/user') return { status: 200, body: { login } };
    if (method === 'GET' && u.pathname === '/gists') {
      const page = Number(u.searchParams.get('page') ?? 1);
      return { status: 200, body: page === 1 ? [...gists.values()].map(view) : [] };
    }
    if (method === 'POST' && u.pathname === '/gists') {
      const id = `gist${next++}`;
      gists.set(id, { id, description: data.description, files: data.files });
      return { status: 201, body: view(gists.get(id)) };
    }
    const m = /^\/gists\/([^/]+)$/.exec(u.pathname);
    const g = m && gists.get(m[1]);
    if (!g) return { status: 404, body: { message: 'Not Found' } };
    if (method === 'GET') return { status: 200, body: view(g) };
    if (method === 'PATCH') {
      Object.assign(g.files, data.files);
      return { status: 200, body: view(g) };
    }
    return { status: 405, body: {} };
  }

  const fetch = async (url, init = {}) => {
    const { status, body } = handle({ method: init.method ?? 'GET', url, headers: init.headers, body: init.body });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };

  return { gists, calls, handle, fetch };
}
