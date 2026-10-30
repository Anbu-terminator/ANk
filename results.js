// Vercel Serverless Function: /api/results
// Keeps every QC result (with timestamp) in ONE JSON file stored in Vercel Blob.
//   GET  /api/results                -> { stats, recent, updatedAt }
//   GET  /api/results?download=1     -> the full JSON file (download)
//   POST /api/results {record}       -> append one result, returns fresh stats
//   POST /api/results {action:"reset"} -> archive current file, start from zero
import { get, put } from '@vercel/blob';

const ACCESS = 'private';          // must match the type of Blob store you create ('private' or 'public')
const FILE = 'qc/results.json';
const MAX_TRIES = 6;

const emptyFile = () => ({ version: 1, createdAt: new Date().toISOString(), updatedAt: null, records: [] });

async function readFile() {
  const r = await get(FILE, { access: ACCESS, useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return { data: emptyFile(), etag: null };
  const text = await new Response(r.stream).text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('results.json is corrupted - refusing to overwrite it'); }
  if (!data || !Array.isArray(data.records)) data = Object.assign(emptyFile(), { records: [] });
  return { data, etag: r.blob.etag };
}

async function writeFile(data, etag) {
  const opts = { access: ACCESS, contentType: 'application/json', allowOverwrite: !!etag };
  if (etag) opts.ifMatch = etag;   // only write if nobody changed the file since we read it
  await put(FILE, JSON.stringify(data, null, 2), opts);
}

const isConflict = e => e && (e.name === 'BlobPreconditionFailedError' || /precondition|already exists/i.test(e.message || ''));

// Read -> change -> write. If two scans save at the same moment, one retries instead of losing data.
async function update(mutator) {
  for (let i = 0; i < MAX_TRIES; i++) {
    const { data, etag } = await readFile();
    const out = await mutator(data);
    if (out && out.skipWrite) return data;
    try {
      await writeFile(data, etag);
      return data;
    } catch (e) {
      if (!isConflict(e) || i === MAX_TRIES - 1) throw e;
      await new Promise(r => setTimeout(r, 80 + Math.random() * 220));
    }
  }
}

function summarize(data) {
  const records = data.records;
  const pass = records.filter(r => r.result === 'PASS').length;
  return {
    ok: true,
    stats: { checked: records.length, pass, fail: records.length - pass },
    recent: records.slice(-10).reverse(),
    updatedAt: data.updatedAt
  };
}

const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);

function validate(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const result = rec.result === 'PASS' || rec.result === 'FAIL' ? rec.result : null;
  const deviceId = str(rec.deviceId, 200);
  const id = str(rec.id, 64);
  if (!result || !deviceId || !id) return null;
  const t = new Date(rec.timestamp);
  return {
    id,
    timestamp: isNaN(t) ? new Date().toISOString() : t.toISOString(),
    time: str(rec.time, 40),
    model: str(rec.model, 200),
    deviceId,
    label: str(rec.label, 200),
    result,
    reason: str(rec.reason, 300),
    receivedAt: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const { data } = await readFile();
      if (req.query && req.query.download) {
        const day = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="qc-results-${day}.json"`);
        return res.status(200).send(JSON.stringify(data, null, 2));
      }
      return res.status(200).json(summarize(data));
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body) return res.status(400).json({ ok: false, error: 'Invalid JSON body' });

      if (body.action === 'reset') {
        const data = await update(async d => {
          if (d.records.length) {
            await put(`qc/archive-${Date.now()}.json`, JSON.stringify(d, null, 2),
              { access: ACCESS, contentType: 'application/json', allowOverwrite: false });
          }
          d.records = [];
          d.updatedAt = new Date().toISOString();
        });
        return res.status(200).json(summarize(data));
      }

      const rec = validate(body.record);
      if (!rec) return res.status(400).json({ ok: false, error: 'Invalid record' });
      const data = await update(d => {
        if (d.records.some(r => r.id === rec.id)) return { skipWrite: true };   // retry of an already-saved result
        d.records.push(rec);
        d.updatedAt = rec.receivedAt;
      });
      return res.status(200).json(summarize(data));
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    console.error('results api error:', e);
    return res.status(500).json({ ok: false, error: 'Storage error: ' + (e.message || 'unknown') });
  }
}
