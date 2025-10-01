import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import pLimit from 'p-limit';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const KEY_PREFIX = process.env.KEY_PREFIX || 'perf-ui';

// --- Providers
function s3ClientFor(provider) {
  if (provider === 'b2') {
    return new S3Client({
      region: process.env.B2_REGION || 'us-west-004',
      endpoint: process.env.B2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.B2_ACCESS_KEY_ID,
        secretAccessKey: process.env.B2_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
      maxAttempts: 3,
    });
  }
  return new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
        }
      : undefined,
    maxAttempts: 3
  });
}
function bucketFor(provider) { return provider === 'b2' ? process.env.B2_S3_BUCKET : process.env.AWS_S3_BUCKET; }

// --- Utilities
const now = () => Date.now();
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
}
function makeKey(prefix = KEY_PREFIX) {
  const ts = Date.now(); const rand = crypto.randomUUID().split('-')[0];
  return `${prefix}/${ts}_${rand}.bin`;
}
function randomBuffer(size) {
  const buf = Buffer.allocUnsafe(size); let o = 0;
  while (o < size) { const len = Math.min(1<<20, size - o); crypto.randomFillSync(buf, o, len); o += len; }
  return buf;
}

async function putObjectMultiAware(client, params, partSizeMB = null) {
  const size = params.Body?.length || 0;
  const threshold = 5 * 1024 * 1024;
  const partSize = partSizeMB ? partSizeMB * 1024 * 1024 : Math.max(8 * 1024 * 1024, Math.min(64 * 1024 * 1024, Math.floor(size / 10)));
  if (size >= threshold) {
    const uploader = new Upload({ client, params, queueSize: 4, partSize, leavePartsOnError: false });
    return uploader.done();
  } else {
    return client.send(new PutObjectCommand(params));
  }
}

async function runUploadTest({ provider, sizeBytes, count, concurrency, prefix, partMB, onProgress }) {
  const client = s3ClientFor(provider);
  const Bucket = bucketFor(provider);
  const limit = pLimit(concurrency);
  const perObject = []; const keys = []; let bytesTotal = 0;

  const tasks = Array.from({ length: count }, () => limit(async () => {
    const Body = randomBuffer(sizeBytes); const Key = makeKey(prefix); const t0 = now();
    await putObjectMultiAware(client, { Bucket, Key, Body }, partMB);
    const ms = now() - t0; perObject.push(ms); keys.push(Key); bytesTotal += sizeBytes;
    onProgress && onProgress({ provider, op: 'upload', done: perObject.length, total: count, lastMs: ms });
  }));

  const tStart = now(); await Promise.all(tasks); const durationMs = now() - tStart;
  return {
    provider, op: 'upload', count, sizeBytes, partMB: partMB || null, concurrency, keys,
    metrics: {
      totalBytes: bytesTotal, totalMB: bytesTotal / (1024*1024), durationMs,
      throughputMBps: (bytesTotal / (1024*1024)) / (durationMs/1000),
      p50ms: percentile(perObject, 50), p95ms: percentile(perObject, 95), p99ms: percentile(perObject, 99)
    }
  };
}

async function runDownloadTest({ provider, keys, concurrency, onProgress }) {
  const client = s3ClientFor(provider);
  const Bucket = bucketFor(provider);
  const limit = pLimit(concurrency);
  const perObject = []; let bytesTotal = 0;

  const tasks = keys.map(Key => limit(async () => {
    const head = await client.send(new HeadObjectCommand({ Bucket, Key }));
    const size = Number(head.ContentLength || 0);
    const t0 = now();
    const out = await client.send(new GetObjectCommand({ Bucket, Key }));
    await new Promise((res, rej) => { out.Body.on('data', ()=>{}); out.Body.on('end', res); out.Body.on('error', rej); });
    const ms = now() - t0; perObject.push(ms); bytesTotal += size;
    onProgress && onProgress({ provider, op: 'download', done: perObject.length, total: keys.length, lastMs: ms });
  }));

  const tStart = now(); await Promise.all(tasks); const durationMs = now() - tStart;
  return {
    provider, op: 'download', count: keys.length, concurrency,
    metrics: {
      totalBytes: bytesTotal, totalMB: bytesTotal / (1024*1024), durationMs,
      throughputMBps: (bytesTotal / (1024*1024)) / (durationMs/1000),
      p50ms: percentile(perObject, 50), p95ms: percentile(perObject, 95), p99ms: percentile(perObject, 99)
    }
  };
}

// --- Live race using Server-Sent Events (UPLOADS then DOWNLOADS; always both)
app.get('/api/race/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // heartbeat to keep proxies from closing idle SSE
  const heartbeat = setInterval(() => { res.write(`:keepalive ${Date.now()}

`); }, 15000);
  const send = (event, data) => { res.write(`event: ${event}
`); res.write(`data: ${JSON.stringify(data)}

`); };

  const sizeBytes = Number(req.query.sizeBytes || 16*1024*1024);
  const count = Number(req.query.count || 8);
  const concurrency = Number(req.query.concurrency || 8);
  const partMB = req.query.partMB ? Number(req.query.partMB) : null;
  const prefix = req.query.prefix || KEY_PREFIX;

  send('start', { sizeBytes, count, concurrency, partMB, prefix });
  const onProgress = ({ provider, op, done, total }) => send('progress', { provider, op, done, total });

  try {
    // Race uploads in parallel
    const [awsUp, b2Up] = await Promise.all([
      runUploadTest({ provider: 'aws', sizeBytes, count, concurrency, prefix, partMB, onProgress }),
      runUploadTest({ provider: 'b2', sizeBytes, count, concurrency, prefix, partMB, onProgress })
    ]);

    send('phase', { phase: 'downloads-start' });

    // Race downloads in parallel using the just-uploaded keys
    const [awsDown, b2Down] = await Promise.all([
      runDownloadTest({ provider: 'aws', keys: awsUp.keys, concurrency, onProgress }),
      runDownloadTest({ provider: 'b2', keys: b2Up.keys, concurrency, onProgress })
    ]);

    send('done', { results: [awsUp, b2Up, awsDown, b2Down] });
  } catch (e) {
    send('error', { message: e.message || 'race failed' });
  } finally {
    clearInterval(heartbeat);
    setTimeout(() => res.end(), 250);
  }
});

app.listen(PORT, () => console.log(`b2-s3-speed-demo listening on :${PORT}`));
