import crypto from 'crypto';
import { Request, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { encrypt } from '../lib/crypto';
import { HttpError } from '../lib/errors';
import { authenticate } from '../middleware/auth';
import { enqueueDeployment, enqueueTeardown } from '../services/deployments';

export const projectsRouter = Router();
projectsRouter.use(authenticate);

export async function getAccessibleProject(req: Request, id: string) {
  const p = await prisma.project.findUnique({ where: { id } });
  if (!p || (p.ownerId !== req.user!.id && req.user!.role !== 'ADMIN')) throw new HttpError(404, 'Project not found');
  return p;
}

// Strict allow-lists: values end up in `git clone`, so no flags / local paths / other hosts.
const projectSchema = z.object({
  name: z.string().min(1).max(60),
  repoUrl: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/, 'Must be https://github.com/<owner>/<repo>'),
  branch: z.string().regex(/^[\w][\w./-]*$/).max(100).default('main'),
  environment: z.enum(['DEVELOPMENT', 'STAGING', 'PRODUCTION']).default('PRODUCTION'),
  containerPort: z.number().int().min(1).max(65535).default(3000),
});

projectsRouter.post('/', async (req, res) => {
  const data = projectSchema.parse(req.body);
  const agg = await prisma.project.aggregate({ _max: { hostPort: true } });
  const project = await prisma.project.create({
    data: {
      ...data,
      ownerId: req.user!.id,
      hostPort: (agg._max.hostPort ?? 19999) + 1,
      webhookSecret: crypto.randomBytes(24).toString('hex'),
    },
  });
  res.status(201).json(project);
});

projectsRouter.get('/', async (req, res) => {
  const where = req.user!.role === 'ADMIN' ? {} : { ownerId: req.user!.id };
  res.json(await prisma.project.findMany({ where, orderBy: { createdAt: 'desc' } }));
});

projectsRouter.get('/:id', async (req, res) => {
  res.json(await getAccessibleProject(req, req.params.id));
});

projectsRouter.patch('/:id', async (req, res) => {
  await getAccessibleProject(req, req.params.id);
  const data = projectSchema.partial().omit({ repoUrl: true }).parse(req.body);
  res.json(await prisma.project.update({ where: { id: req.params.id }, data }));
});

projectsRouter.delete('/:id', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  await prisma.project.delete({ where: { id: p.id } });
  await enqueueTeardown(p.id); // worker removes the running container
  res.status(204).end();
});

projectsRouter.post('/:id/deploy', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  res.status(202).json(await enqueueDeployment(p.id, req.user!.id));
});

projectsRouter.get('/:id/deployments', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(await prisma.deployment.findMany({ where: { projectId: p.id }, orderBy: { createdAt: 'desc' }, take: limit }));
});

// ---- Environment variables (encrypted at rest, values never returned) ----
const envSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100),
  value: z.string().max(4096).refine((v) => !/[\r\n]/.test(v), 'Newlines are not allowed'),
});

projectsRouter.get('/:id/env', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const vars = await prisma.envVar.findMany({ where: { projectId: p.id }, orderBy: { key: 'asc' } });
  res.json(vars.map((v) => ({ key: v.key, updatedAt: v.updatedAt })));
});

projectsRouter.put('/:id/env', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  const { key, value } = envSchema.parse(req.body);
  const valueEnc = encrypt(value);
  await prisma.envVar.upsert({
    where: { projectId_key: { projectId: p.id, key } },
    create: { projectId: p.id, key, valueEnc },
    update: { valueEnc },
  });
  res.json({ key });
});

projectsRouter.delete('/:id/env/:key', async (req, res) => {
  const p = await getAccessibleProject(req, req.params.id);
  await prisma.envVar.deleteMany({ where: { projectId: p.id, key: req.params.key } });
  res.status(204).end();
});
