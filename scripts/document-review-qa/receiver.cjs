// Praxis stand-in speaking the /api/chat idempotency contract (keyed turns run once).
const http = require('http');
const ledger = new Map();
const turns = [];
const requests = [];
http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        const key = body.idempotency_key || req.headers['idempotency-key'] || null;
        requests.push({ t: new Date().toISOString(), url: req.url, key, attempt: body.attempt });
        const json = (s, p) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(p)); };
        if (req.url === '/__state') return json(200, { turns, requests });
        if (req.method !== 'POST' || req.url !== '/api/chat') return json(404, { error: 'not found' });
        if (key && ledger.has(key)) return json(200, { ...ledger.get(key), duplicate: true });
        turns.push({ key, message: body.message });
        const reply = { response: `Received your review (turn ${turns.length}). Thanks Robert.`, mode: 'praxis', voiceData: [] };
        if (key) ledger.set(key, reply);
        json(200, reply);
    });
}).listen(4199, '127.0.0.1', () => console.log('receiver on 4199'));
