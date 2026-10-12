import crypto from 'crypto';
import { Request, Router } from 'express';
import { prisma } from '../db';
import { HttpError } from '../lib/errors';
import { enqueueDeployment } from '../services/deployments';

export const webhooksRouter = Router();

// GitHub push webhook -> automatic deployment. Authenticated by HMAC (X-Hub-Signature-256).
webhooksRouter.post('/github/:projectId', async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  if (!project) throw new HttpError(404, 'Project not found');

  const raw: Buffer | undefined = (req as any).rawBody;
  const sig = String(req.headers['x-hub-signature-256'] ?? '');
  const expected = 'sha256=' + crypto.createHmac('sha256', project.webhookSecret).update(raw ?? '').digest('hex');
  const valid = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!valid) throw new HttpError(401, 'Invalid signature');

  const event = req.headers['x-github-event'];
  if (event === 'ping') return res.json({ ok: true });
  if (event !== 'push') return res.status(202).json({ ignored: `event ${String(event)}` });
  if (req.body?.ref !== `refs/heads/${project.branch}`) return res.status(202).json({ ignored: 'other branch' });

  const d = await enqueueDeployment(project.id, project.ownerId);
  res.status(202).json({ deploymentId: d.id });
});
