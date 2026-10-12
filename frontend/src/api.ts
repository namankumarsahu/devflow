export type User = { id: string; email: string; role: 'USER' | 'ADMIN'; createdAt: string };
export type Project = {
  id: string; name: string; repoUrl: string; branch: string; environment: string;
  containerPort: number; hostPort: number; webhookSecret: string; currentDeploymentId: string | null;
};
export type Deployment = {
  id: string; status: 'QUEUED' | 'BUILDING' | 'DEPLOYING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  commitHash: string | null; url: string | null; durationMs: number | null; createdAt: string;
  rollbackOfId: string | null; error: string | null;
};

export const auth = {
  get: () => localStorage.getItem('token'),
  set: (t: string) => localStorage.setItem('token', t),
  clear: () => localStorage.removeItem('token'),
};

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(auth.get() ? { Authorization: `Bearer ${auth.get()}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    auth.clear();
    window.location.href = '/login';
  }
  if (!res.ok) {
    const details = data?.details ? ' — ' + Object.values(data.details).flat().join(', ') : '';
    throw new Error((data?.error ?? `HTTP ${res.status}`) + details);
  }
  return data as T;
}

export const fmtDuration = (ms: number | null) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
