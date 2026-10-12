import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { Job, Worker } from 'bullmq';
import { config } from './config';
import { prisma } from './db';
import { decrypt } from './lib/crypto';
import { publishLog, publishStatus } from './lib/events';
import { QUEUE_NAME } from './queue';
import { createRedis, getRedis } from './redis';

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class CancelledError extends Error {}

type Logger = { log: (line: string) => Promise<void> };

// Persist + publish lines strictly in order (chained promises) so history == live stream.
function makeLogger(deploymentId: string): Logger {
  let chain: Promise<void> = Promise.resolve();
  return {
    log: (text) => {
      const lines = text.split('\n').map((l) => l.trimEnd()).filter(Boolean);
      chain = chain.then(async () => {
        for (const line of lines) {
          await prisma.deploymentLog.create({ data: { deploymentId, line } });
          await publishLog(deploymentId, line);
        }
      });
      return chain;
    },
  };
}

async function setStatus(id: string, status: 'BUILDING' | 'DEPLOYING', extra: object = {}) {
  await prisma.deployment.update({ where: { id }, data: { status, ...extra } });
  await publishStatus(id, status);
}

async function capture(cmd: string, args: string[], cwd?: string) {
  const { stdout } = await execFileP(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

// Run a command, streaming stdout/stderr to the deployment log. Supports cancellation + timeout.
function run(logger: Logger, id: string, cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let cancelled = false;
    let timedOut = false;
    const poll = setInterval(async () => {
      if (await getRedis().get(`cancel:${id}`)) {
        cancelled = true;
        child.kill('SIGKILL');
      }
    }, 1000);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, config.buildTimeoutMs);
    const done = () => {
      clearInterval(poll);
      clearTimeout(timeout);
    };
    const onData = (d: Buffer) => void logger.log(d.toString());
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      done();
      reject(e);
    });
    child.on('close', (code) => {
      done();
      if (cancelled) reject(new CancelledError('Cancelled'));
      else if (timedOut) reject(new Error(`${cmd} timed out after ${config.buildTimeoutMs / 1000}s`));
      else if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args[0]} exited with code ${code}`));
    });
  });
}

// One deployment per project at a time (the container name + host port are per project).
async function acquireProjectLock(projectId: string) {
  const key = `lock:project:${projectId}`;
  const token = randomUUID();
  while (!(await getRedis().set(key, token, 'PX', 30 * 60 * 1000, 'NX'))) await sleep(2000);
  return async () => {
    if ((await getRedis().get(key)) === token) await getRedis().del(key);
  };
}

async function processDeployment(deploymentId: string) {
  const dep = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true } });
  if (!dep || dep.status !== 'QUEUED') return;
  const { project } = dep;
  const logger = makeLogger(deploymentId);
  const release = await acquireProjectLock(project.id);
  const workDir = path.join(config.workDir, deploymentId);
  const envFile = path.join(config.workDir, `${deploymentId}.env`);
  const startedAt = Date.now();

  try {
    // Re-check: it may have been cancelled while waiting for the lock.
    const fresh = await prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (fresh?.status !== 'QUEUED') return;
    await mkdir(config.workDir, { recursive: true });
    await setStatus(deploymentId, 'BUILDING', { startedAt: new Date() });

    let imageTag = dep.imageTag;
    if (dep.rollbackOfId && imageTag) {
      await logger.log(`==> Rollback: reusing image ${imageTag}`);
      await capture('docker', ['image', 'inspect', imageTag]).catch(() => {
        throw new Error('Image for the target deployment no longer exists (pruned?)');
      });
    } else {
      await logger.log(`==> Cloning ${project.repoUrl} (${project.branch})`);
      await run(logger, deploymentId, 'git', ['clone', '--depth', '1', '--branch', project.branch, '--', project.repoUrl, workDir]);
      const commit = (await capture('git', ['rev-parse', 'HEAD'], workDir)).trim();
      imageTag = `devflow/${project.id}:${commit.slice(0, 12)}-${deploymentId.slice(0, 8)}`;
      await prisma.deployment.update({ where: { id: deploymentId }, data: { commitHash: commit, imageTag } });
      await logger.log(`==> Building image ${imageTag} @ ${commit.slice(0, 7)}`);
      await run(logger, deploymentId, 'docker', ['build', '-t', imageTag, workDir]);
    }

    await setStatus(deploymentId, 'DEPLOYING');
    const vars = await prisma.envVar.findMany({ where: { projectId: project.id } });
    const lines = [`PORT=${project.containerPort}`, `NODE_ENV=${project.environment.toLowerCase()}`];
    vars.forEach((v) => lines.push(`${v.key}=${decrypt(v.valueEnc)}`));
    // env-file (mode 0600, deleted afterwards) keeps secrets out of `ps` output and logs.
    await writeFile(envFile, lines.join('\n') + '\n', { mode: 0o600 });

    const name = `devflow-${project.id}`;
    await logger.log('==> Starting container');
    await capture('docker', ['rm', '-f', name]).catch(() => undefined);
    await run(logger, deploymentId, 'docker', [
      'run', '-d', '--name', name, '--restart', 'unless-stopped',
      '-p', `${project.hostPort}:${project.containerPort}`,
      '--env-file', envFile,
      '--label', `devflow.project=${project.id}`,
      '--label', `devflow.deployment=${deploymentId}`,
      imageTag!,
    ]);

    await sleep(3000);
    const running = (await capture('docker', ['inspect', '-f', '{{.State.Running}}', name])).trim() === 'true';
    if (!running) {
      const tail = await capture('docker', ['logs', '--tail', '40', name]).catch(() => '');
      await logger.log(tail);
      throw new Error('Container exited right after start');
    }

    const url = `http://${config.publicHost}:${project.hostPort}`;
    await logger.log(`==> Live at ${url}`);
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: 'SUCCESS', url, finishedAt: new Date(), durationMs: Date.now() - startedAt },
    });
    await prisma.project.update({ where: { id: project.id }, data: { currentDeploymentId: deploymentId } });
    await publishStatus(deploymentId, 'SUCCESS');
  } catch (err) {
    const cancelled = err instanceof CancelledError;
    const message = err instanceof Error ? err.message : String(err);
    await logger.log(cancelled ? '==> Deployment cancelled' : `==> FAILED: ${message}`);
    const status = cancelled ? 'CANCELLED' : 'FAILED';
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status, error: cancelled ? null : message, finishedAt: new Date(), durationMs: Date.now() - startedAt },
    });
    await publishStatus(deploymentId, status);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(envFile, { force: true }).catch(() => undefined);
    await getRedis().del(`cancel:${deploymentId}`);
    await release();
  }
}

const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    if (job.name === 'teardown') {
      await capture('docker', ['rm', '-f', `devflow-${job.data.projectId}`]).catch(() => undefined);
      return;
    }
    await processDeployment(job.data.deploymentId);
  },
  { connection: createRedis(), concurrency: 2 },
);

worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed:`, err));
console.log('DevFlow worker started');

const shutdown = async () => {
  await worker.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
