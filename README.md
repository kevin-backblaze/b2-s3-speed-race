# B2 vs S3 Speed Race

A tiny Node/Express app that **races upload and download performance** between **Backblaze B2 (S3-compatible)** and **AWS S3**.  
It streams **live progress** via **Server-Sent Events (SSE)** and reports throughput plus latency percentiles (p50/p95/p99).

---

## Features
- Parallel **upload & download race** with configurable `sizeBytes`, `count`, and `concurrency`
- **SSE** progress stream with throttling & heartbeat (keeps proxies from closing idle connections)
- Efficient S3 clients (shared keep-alive pools, large socket pools)
- **Random data streaming** to avoid large memory allocations
- Health and readiness endpoints: **`/healthz`** and **`/ready`**
- Production-ready: plays nicely with **PM2**, **systemd**, and **Nginx** (SSE-friendly)

---

## Project Structure
```
.
├─ server.js            # main app (Express + SSE + AWS SDK v3)
├─ package.json
├─ public/              # optional static UI (served by Express)
│  ├─ index.html
│  └─ app.js
├─ .env                 # your local secrets (ignored by git)
├─ .env.example         # safe template for others
└─ README.md
```

---

## Quick Start (local)
```bash
npm ci
cp .env.example .env
# edit .env with your buckets and keys
npm start
# open http://localhost:3000
```

### Environment
Copy `.env.example` → `.env` and fill in values. Key vars:

```
PORT=3000
KEY_PREFIX=perf-ui

# AWS
AWS_REGION=us-east-1
AWS_S3_BUCKET=your-aws-bucket
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...

# Backblaze B2 (S3-compatible)
B2_REGION=us-east-005
B2_ENDPOINT=https://s3.us-east-005.backblazeb2.com
B2_S3_BUCKET=your-b2-bucket
B2_ACCESS_KEY_ID=...
B2_SECRET_ACCESS_KEY=...
```

> **Never commit `.env`.** This repo includes a `.gitignore` and `.env.example`.

---

## API

### Health & Readiness
- `GET /healthz` → `"ok"` when the process is up
- `GET /ready` → `"ready"` if buckets are reachable via cheap list calls; otherwise `503`

### Live Race (SSE)
- `GET /api/race/stream?sizeBytes=16777216&count=8&concurrency=8&partMB=16&prefix=mytest`

**SSE events**
- `start` – `{ sizeBytes, count, concurrency, partMB, prefix }`
- `progress` – `{ provider: "aws"|"b2", op: "upload"|"download", done, total }`
- `phase` – e.g. `{ phase: "downloads-start" }`
- `done` – `{ results: [awsUpload, b2Upload, awsDownload, b2Download] }`
- `error` – `{ message }`

**Minimal curl demo**
```bash
curl -sN "http://localhost:3000/api/race/stream?count=4&concurrency=4"   | sed -n 's/^event: //p; s/^data: //p'
```

**Tiny browser client**
```html
<script>
const es = new EventSource('/api/race/stream?count=8&concurrency=8');
es.addEventListener('progress', e => console.log('progress', JSON.parse(e.data)));
es.addEventListener('phase',    e => console.log('phase', JSON.parse(e.data)));
es.addEventListener('done',     e => console.log('done', JSON.parse(e.data)));
es.addEventListener('error',    e => console.error('error', e));
</script>
```

---

## Production

### PM2 (single host, all CPU cores)
```bash
pm2 start server.js --name b2-s3-speed-race -i max --update-env
pm2 save
# start on boot (example for user 'ec2-user')
pm2 startup systemd -u ec2-user --hp /home/ec2-user
# run the printed command, then:
pm2 save
# zero-downtime reload on deploys
pm2 reload b2-s3-speed-race
pm2 logs b2-s3-speed-race
```

**Optional: log rotation**
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 7
pm2 save
```

### systemd (alternative without PM2)
Create `/etc/systemd/system/myapp.service`:
```ini
[Unit]
Description=Node app
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/b2-s3-speed-race
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node /home/ec2-user/b2-s3-speed-race/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```
Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now myapp
journalctl -u myapp -f
```

### Nginx tips for SSE
In your `location /` that proxies to the app:
```nginx
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_buffering off;
proxy_read_timeout 3600s;
```

---

## Security & Hygiene
- Secrets live only in `.env` (ignored by git)
- Share required vars via `.env.example`
- Least-privilege access keys for both providers

---

## License
MIT
