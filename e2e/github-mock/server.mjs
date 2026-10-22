// A stand-in for the GitHub REST API used by the e2e suite: it accepts PR
// comments (POST /repos/:owner/:repo/issues/:number/comments) when they carry
// the expected token, and lets the tests read (GET /__comments) or clear
// (DELETE /__comments) what it received.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 9999);
const TOKEN = process.env.EXPECTED_TOKEN ?? '';
const comments = [];

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.url === '/__comments' && req.method === 'GET') return send(res, 200, comments);
      if (req.url === '/__comments' && req.method === 'DELETE') {
        comments.length = 0;
        return send(res, 204, {});
      }
      if (req.url === '/health') return send(res, 200, { ok: true });
      const match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(req.url ?? '');
      if (!match || req.method !== 'POST') return send(res, 404, { message: 'Not Found' });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { message: 'Bad credentials' });
      const body = JSON.parse(raw || '{}');
      const id = comments.length + 1;
      const [, owner, repo, number] = match;
      comments.push({ id, owner, repo, number: Number(number), body: body.body, headers: { apiVersion: req.headers['x-github-api-version'] } });
      send(res, 201, { id, html_url: `https://github.com/${owner}/${repo}/pull/${number}#issuecomment-${id}`, body: body.body });
    });
  })
  .listen(PORT, () => console.log(`github-mock listening on ${PORT}`));
