import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { Readable } from 'stream';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import pLimit from 'p-limit';

const app = express();

/**
 * JSON body parser with a small limit because this service generates data
 * and does not expect large request bodies from clients
 */
app.use(express.json({ limit: '2mb' }));

/**
 * Serve static assets from ./public
 * This is handy for a simple UI that talks to the API endpoints below
 */
app.use(express.static('public'));

/**
 * Tell Express to trust the reverse proxy
 * This makes req.ip correct when behind Nginx or a load balancer
 */
app.set('trust proxy', 1);

/** Basic configuration */
const PORT = process.env.PORT || 3000;
const KEY_PREFIX = process.env.KEY_PREFIX || 'perf-ui';

/**
 * Health endpoint for basic liveness probes
 * Returns 200 when the process is up
 */
app.get('/healthz', (req, res) => res.status(200).send('ok'));

/**
 * Handle SIGTERM so process managers can restart without abrupt drops
 * PM2 or systemd will send SIGTERM on reload or stop
 */
process.on('SIGTERM', () => {
  console.log('SIGTERM received');
  process.exit(0);
});

/**
 * Reuse HTTP agents with keep alive for high throughput and lower CPU
 * maxSockets controls parallel connections per process
 */
const keepAliveAgentHttp = new http.Agent({ keepAlive: true, maxSockets: 1024 });
const keepAliveAgentHttps = new https.Agent({ keepAlive: true, maxSockets: 1024 });

/**
 * Shared Smithy HTTP handler so all S3 clients use the same connection pools
 * requestTimeout handles slow large transfers
 * connectionTimeout handles initial connect time
 */
const httpHandler = new NodeHttpHandler({
  httpAgent: keepAliveAgentHttp,
  httpsAgent: keepAliveAgentHttps,
  requestTimeout: 300_000,
  connectionTimeout: 10_000
});

/** Helper to create an S3 client with shared handler and retries */
function makeS3Client(cfg) {
  return new S3Client({ ...cfg, requestHandler: httpHandler, maxAttempts: 3 });
}

/** Backblaze B2 S3 compatible client */
const b2Client = makeS3Client({
  region: process.env.B2_REGION || 'us-east-005',
  endpoint: process.env.B2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.B2_ACCESS_KEY_ID,
    secretAccessKey: process.env.B2_SECRET_ACCESS_KEY
  },
  forcePathStyle: true
});

/** AWS S3 client for comparison */
const awsClient = makeS3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN || undefined
      }
    : undefined
});

/** Lookup tables for provider to client and bucket */
const s3ByProvider = { b2: b2Client, aws: awsClient };
const bucketByProvider = {
  b2: process.env.B2_S3_BUCKET,
  aws: process.env.AWS_S3_BUCKET
};

/** Small utility helpers */
const now = () => Date.now();

/**
 * Percentile with correct indexing on sorted samples
 * p is a number such as 50 or 95
 */
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1))));
  return s[idx];
}

/** Create a unique object key with a prefix and short random suffix */
function makeKey(prefix = KEY_PREFIX) {
  const ts = Date.now();
  const rand = crypto.randomUUID().split('-')[0];
  return `${prefix}/${ts}_${rand}.bin`;
}

/**
 * Create a readable stream that yields random bytes until totalBytes is sent
 * This avoids allocating large buffers in memory
 */
function randomStream(totalBytes, chunkSize = 1024 * 1024) {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= totalBytes) return this.push(null);
      const size = Math.min(chunkSize, totalBytes - sent);
      const buf = Buffer.allocUnsafe(size);
      crypto.randomFillSync(buf);
      sent += size;
      this.push(buf);
    }
  });
}

/**
 * Upload helper that chooses simple PutObject for small payloads
 * and multipart upload for larger ones
 * Uses the AWS SDK v3 Upload helper to parallelize parts
 */
async function putObjectMultiAware(client, params, partSizeMB = null) {
  const size =
    typeof params.ContentLength === 'number'
      ? params.ContentLength
      : params.Body?.length || 0;

  const threshold = 5 * 1024 * 1024;
  const partSize = partSizeMB
    ? partSizeMB * 1024 * 1024
    : Math.max(8 * 1024 * 1024, Math.min(64 * 1024 * 1024, Math.floor(size / 10)));

  const isStream = typeof params.Body?.pipe === 'function';

  if (size >= threshold || isStream) {
    const uploader = new Upload({
      client,
      params,
      queueSize: 8,              // number of concurrent parts per object
      partSize,
      leavePartsOnError: false
    });
    return uploader.done();
  } else {
    return client.send(new PutObjectCommand(params));
  }
}

/**
 * Run a batch of uploads in parallel with a concurrency limit
 * Generates random data per object and records per object latency
 * Returns throughput and latency percentiles
 */
async function runUploadTest({ provider, sizeBytes, count, concurrency, prefix, partMB, onProgress }) {
  const client = s3ByProvider[provider];
  const Bucket = bucketByProvider[provider];
  const limit = pLimit(concurrency);
  const perObject = [];
  const keys = [];
  let bytesTotal = 0;

  const tasks = Array.from({ length: count }, () =>
    limit(async () => {
      const Body = randomStream(sizeBytes);
      const Key = makeKey(prefix);
      const t0 = now();
      await putObjectMultiAware(client, { Bucket, Key, Body, ContentLength: sizeBytes }, partMB);
      const ms = now() - t0;
      perObject.push(ms);
      keys.push(Key);
      bytesTotal += sizeBytes;
      onProgress && onProgress({ provider, op: 'upload', done: perObject.length, total: count, lastMs: ms });
    })
  );

  const tStart = now();
  await Promise.all(tasks);
  const durationMs = now() - tStart;

  return {
    provider,
    op: 'upload',
    count,
    sizeBytes,
    partMB: partMB || null,
    concurrency,
    keys,
    metrics: {
      totalBytes: bytesTotal,
      totalMB: bytesTotal / (1024 * 1024),
      durationMs,
      throughputMBps: (bytesTotal / (1024 * 1024)) / (durationMs / 1000),
      p50ms: percentile(perObject, 50),
      p95ms: percentile(perObject, 95),
      p99ms: percentile(perObject, 99)
    }
  };
}

/**
 * Run a batch of downloads in parallel with a concurrency limit
 * Uses GetObject directly and reads the stream to completion
 * Skips the extra HeadObject round trip
 */
async function runDownloadTest({ provider, keys, concurrency, onProgress }) {
  const client = s3ByProvider[provider];
  const Bucket = bucketByProvider[provider];
  const limit = pLimit(concurrency);
  const perObject = [];
  let bytesTotal = 0;

  const tasks = keys.map((Key) =>
    limit(async () => {
      const t0 = now();
      const out = await client.send(new GetObjectCommand({ Bucket, Key }));
      const size = Number(out.ContentLength || 0);
      await new Promise((res, rej) => {
        out.Body.on('data', () => {});
        out.Body.on('end', res);
        out.Body.on('error', rej);
      });
      const ms = now() - t0;
      perObject.push(ms);
      bytesTotal += size;
      onProgress && onProgress({ provider, op: 'download', done: perObject.length, total: keys.length, lastMs: ms });
    })
  );

  const tStart = now();
  await Promise.all(tasks);
  const durationMs = now() - tStart;

  return {
    provider,
    op: 'download',
    count: keys.length,
    concurrency,
    metrics: {
      totalBytes: bytesTotal,
      totalMB: bytesTotal / (1024 * 1024),
      durationMs,
      throughputMBps: (bytesTotal / (1024 * 1024)) / (durationMs / 1000),
      p50ms: percentile(perObject, 50),
      p95ms: percentile(perObject, 95),
      p99ms: percentile(perObject, 99)
    }
  };
}

/**
 * Readiness probe
 * Attempts very cheap list calls with small MaxKeys to validate creds and reachability
 * Returns 200 when basic calls succeed against configured buckets
 */
app.get('/ready', async (req, res) => {
  try {
    const awsBucket = bucketByProvider.aws;
    const b2Bucket = bucketByProvider.b2;

    const abortAws = AbortSignal.timeout(2000);
    const abortB2 = AbortSignal.timeout(2000);

    if (awsBucket) {
      await awsClient.send(new ListObjectsV2Command({ Bucket: awsBucket, MaxKeys: 0 }), { abortSignal: abortAws });
    }
    if (b2Bucket) {
      await b2Client.send(new ListObjectsV2Command({ Bucket: b2Bucket, MaxKeys: 0 }), { abortSignal: abortB2 });
    }
    res.status(200).send('ready');
  } catch {
    res.status(503).send('not ready');
  }
});

/**
 * Throttled SSE writer to limit event rate
 * Always emits terminal progress when done equals total
 * Always emits start phase done and error
 */
function makeThrottledSender(res, minMs = 150) {
  let last = 0;
  return (event, data) => {
    const t = Date.now();
    const isTerminalProgress = event === 'progress' && data && Number(data.done) === Number(data.total);
    const always = event === 'done' || event === 'error' || event === 'start' || event === 'phase' || isTerminalProgress;
    if (always || t - last >= minMs) {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      last = t;
    }
  };
}

/**
 * Live race endpoint
 * Streams progress using SSE
 * Phase one uploads to both providers
 * Phase two downloads the just uploaded objects
 * Emits a done event with a results array containing four result blocks
 */
app.get('/api/race/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  /** Keep connection open through proxies */
  const heartbeat = setInterval(() => {
    res.write(`:keepalive ${Date.now()}\n\n`);
  }, 15000);

  const send = makeThrottledSender(res, 150);

  /** Parse query params with defaults suitable for a short demo */
  const sizeBytes = Number(req.query.sizeBytes || 16 * 1024 * 1024);
  const count = Number(req.query.count || 8);
  const concurrency = Number(req.query.concurrency || 8);
  const partMB = req.query.partMB ? Number(req.query.partMB) : null;
  const prefix = req.query.prefix || KEY_PREFIX;

  send('start', { sizeBytes, count, concurrency, partMB, prefix });

  const onProgress = ({ provider, op, done, total }) => send('progress', { provider, op, done, total });

  try {
    /** Phase one uploads */
    const [awsUp, b2Up] = await Promise.all([
      runUploadTest({ provider: 'aws', sizeBytes, count, concurrency, prefix, partMB, onProgress }),
      runUploadTest({ provider: 'b2', sizeBytes, count, concurrency, prefix, partMB, onProgress })
    ]);

    send('phase', { phase: 'downloads-start' });

    /** Phase two downloads */
    const [awsDown, b2Down] = await Promise.all([
      runDownloadTest({ provider: 'aws', keys: awsUp.keys, concurrency, onProgress }),
      runDownloadTest({ provider: 'b2', keys: b2Up.keys, concurrency, onProgress })
    ]);

    /** Final results payload */
    send('done', { results: [awsUp, b2Up, awsDown, b2Down] });
  } catch (e) {
    send('error', { message: e?.message || 'race failed' });
  } finally {
    clearInterval(heartbeat);
    setTimeout(() => res.end(), 250);
  }
});

/** Start the HTTP server */
app.listen(PORT, () => console.log(`b2-s3-speed-demo listening on :${PORT}`));
