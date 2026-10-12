import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, Deployment, fmtDuration, Project } from '../api';
import LogViewer from '../components/LogViewer';
import StatusBadge from '../components/StatusBadge';

const ACTIVE = ['QUEUED', 'BUILDING', 'DEPLOYING'];

export default function ProjectDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [project, setProject] = useState<Project>();
  const [deps, setDeps] = useState<Deployment[]>([]);
  const [envKeys, setEnvKeys] = useState<{ key: string }[]>([]);
  const [selected, setSelected] = useState<string>();
  const [envForm, setEnvForm] = useState({ key: '', value: '' });
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setDeps(await api<Deployment[]>(`/projects/${id}/deployments`));
    setProject(await api<Project>(`/projects/${id}`));
  }, [id]);

  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    api<{ key: string }[]>(`/projects/${id}/env`).then(setEnvKeys);
    const t = setInterval(() => refresh().catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, [id, refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await refresh(); } catch (e) { setError((e as Error).message); }
  };

  const deploy = () => act(async () => setSelected((await api<Deployment>(`/projects/${id}/deploy`, { method: 'POST' })).id));
  const rollback = (d: Deployment) => act(async () => setSelected((await api<Deployment>(`/deployments/${d.id}/rollback`, { method: 'POST' })).id));
  const cancel = (d: Deployment) => act(() => api(`/deployments/${d.id}/cancel`, { method: 'POST' }));

  async function saveEnv(e: FormEvent) {
    e.preventDefault();
    await act(() => api(`/projects/${id}/env`, { method: 'PUT', body: envForm }));
    setEnvForm({ key: '', value: '' });
    setEnvKeys(await api(`/projects/${id}/env`));
  }
  async function delEnv(key: string) {
    await api(`/projects/${id}/env/${key}`, { method: 'DELETE' });
    setEnvKeys(await api(`/projects/${id}/env`));
  }
  async function remove() {
    if (!confirm('Delete project and stop its container?')) return;
    await api(`/projects/${id}`, { method: 'DELETE' });
    nav('/');
  }

  if (!project) return <p className="text-slate-500">{error || 'Loading…'}</p>;
  const btn = 'rounded px-2 py-1 text-xs';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">{project.name}</h2>
          <p className="text-sm text-slate-400">{project.repoUrl} · {project.branch} · {project.environment}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={deploy} className="rounded bg-indigo-600 px-4 py-2 font-medium hover:bg-indigo-500">Deploy</button>
          <button onClick={remove} className="rounded border border-rose-800 px-4 py-2 text-rose-300 hover:bg-rose-950">Delete</button>
        </div>
      </div>
      {error && <p className="text-sm text-rose-400">{error}</p>}

      <section className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900 text-xs uppercase text-slate-400">
            <tr><th className="p-3">Status</th><th>Commit</th><th>Duration</th><th>URL</th><th>Started</th><th></th></tr>
          </thead>
          <tbody>
            {deps.map((d) => (
              <tr key={d.id} className={`border-t border-slate-800 ${selected === d.id ? 'bg-slate-900' : ''}`}>
                <td className="p-3">
                  <StatusBadge status={d.status} />
                  {d.rollbackOfId && <span className="ml-2 text-xs text-slate-500">rollback</span>}
                  {project.currentDeploymentId === d.id && <span className="ml-2 text-xs text-emerald-400">● current</span>}
                </td>
                <td className="font-mono text-xs">{d.commitHash?.slice(0, 7) ?? '—'}</td>
                <td>{fmtDuration(d.durationMs)}</td>
                <td>{d.url ? <a className="text-indigo-400 hover:underline" href={d.url} target="_blank" rel="noreferrer">{d.url}</a> : '—'}</td>
                <td className="text-xs text-slate-400">{new Date(d.createdAt).toLocaleString()}</td>
                <td className="space-x-1 pr-3 text-right">
                  <button className={`${btn} bg-slate-800`} onClick={() => setSelected(d.id)}>Logs</button>
                  {d.status === 'SUCCESS' && project.currentDeploymentId !== d.id && (
                    <button className={`${btn} bg-amber-600/30 text-amber-200`} onClick={() => rollback(d)}>Rollback</button>
                  )}
                  {ACTIVE.includes(d.status) && <button className={`${btn} bg-rose-600/30 text-rose-200`} onClick={() => cancel(d)}>Cancel</button>}
                </td>
              </tr>
            ))}
            {deps.length === 0 && <tr><td className="p-4 text-slate-500" colSpan={6}>No deployments yet.</td></tr>}
          </tbody>
        </table>
      </section>

      {selected && <LogViewer deploymentId={selected} />}

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-slate-800 p-4">
          <h3 className="mb-3 font-semibold">Environment variables</h3>
          <p className="mb-3 text-xs text-slate-500">Encrypted at rest (AES-256-GCM). Values are write-only. Applied on next deploy.</p>
          <form onSubmit={saveEnv} className="mb-3 flex gap-2">
            <input className="w-1/3 rounded bg-slate-900 px-2 py-1 text-sm" placeholder="KEY" value={envForm.key} onChange={(e) => setEnvForm({ ...envForm, key: e.target.value })} required />
            <input className="flex-1 rounded bg-slate-900 px-2 py-1 text-sm" type="password" placeholder="value" value={envForm.value} onChange={(e) => setEnvForm({ ...envForm, value: e.target.value })} required />
            <button className="rounded bg-slate-700 px-3 text-sm">Save</button>
          </form>
          <ul className="space-y-1 text-sm">
            {envKeys.map((v) => (
              <li key={v.key} className="flex justify-between rounded bg-slate-900 px-2 py-1">
                <span className="font-mono">{v.key}</span>
                <button className="text-rose-400" onClick={() => delEnv(v.key)}>remove</button>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-slate-800 p-4 text-sm">
          <h3 className="mb-3 font-semibold">Auto-deploy (GitHub webhook)</h3>
          <p className="mb-2 text-slate-400">In your repo: Settings → Webhooks → Add webhook</p>
          <dl className="space-y-2">
            <div><dt className="text-xs text-slate-500">Payload URL</dt><dd className="break-all font-mono text-xs">{location.origin}/api/webhooks/github/{project.id}</dd></div>
            <div><dt className="text-xs text-slate-500">Content type / Events</dt><dd>application/json · push</dd></div>
            <div><dt className="text-xs text-slate-500">Secret</dt><dd className="break-all font-mono text-xs">{project.webhookSecret}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  );
}
