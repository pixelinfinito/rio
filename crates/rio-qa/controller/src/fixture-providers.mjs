import { randomBytes, randomUUID, createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

const token = () => randomBytes(24).toString('base64url');
const json = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
const xmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const xml = (response, status, value, headers = {}) => { response.writeHead(status, { 'content-type': 'application/xml', ...headers }); response.end(`<?xml version="1.0" encoding="UTF-8"?>${value}`); };
const s3Error = (response, status, code) => xml(response, status, `<Error><Code>${code}</Code><Message>Synthetic fixture: ${code}</Message></Error>`);

/** In-memory OIDC authorization-code provider. Codes bind client, redirect,
 * nonce and PKCE and are single-use. It never contacts an upstream identity. */
export class OAuthDouble {
  constructor({ appOrigins = [], identity = { sub: 'rio-qa-user', email: 'shopper@example.test', name: 'QA shopper' } } = {}) {
    this.origins = new Set(appOrigins); this.identity = identity;
    this.variables = { client_id: 'rio-qa-client', client_secret: token() };
    this.keys = generateKeyPairSync('ec', { namedCurve: 'P-256' }); this.kid = randomUUID();
    this.codes = new Map(); this.access = new Map(); this.refresh = new Map();
  }
  setUrl(url) { this.url = url; this.variables.issuer = url; }
  prune() {
    for (const map of [this.codes, this.access, this.refresh]) for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key);
  }
  issue(client, nonce) {
    const now = Math.floor(Date.now() / 1000);
    const claims = { ...this.identity, iss: this.url, aud: client, iat: now, exp: now + 300, ...(nonce ? { nonce } : {}), email_verified: true };
    const input = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: this.kid })).toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
    const id_token = input + '.' + cryptoSign('sha256', Buffer.from(input), { key: this.keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const access_token = token(), refresh_token = token();
    this.access.set(access_token, { claims, expires: Date.now() + 300000 }); this.refresh.set(refresh_token, { client, expires: Date.now() + 3600000 });
    return { access_token, refresh_token, token_type: 'Bearer', expires_in: 300, id_token, scope: 'openid profile email' };
  }
  handle(request, response, url, body) {
    this.prune();
    if (url.pathname === '/.well-known/openid-configuration') return json(response, 200, {
      issuer: this.url, authorization_endpoint: this.url + '/authorize', token_endpoint: this.url + '/token', userinfo_endpoint: this.url + '/userinfo', jwks_uri: this.url + '/jwks',
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['ES256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'], code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'profile', 'email'],
    });
    if (url.pathname === '/jwks') return json(response, 200, { keys: [{ ...this.keys.publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'ES256', kid: this.kid }] });
    if (url.pathname === '/authorize' && request.method === 'GET') {
      const p = url.searchParams; let redirect;
      try { redirect = new URL(p.get('redirect_uri')); } catch { return json(response, 400, { error: 'invalid_redirect_uri' }); }
      if (!this.origins.has(redirect.origin) || redirect.username || redirect.password || redirect.hash) return json(response, 400, { error: 'invalid_redirect_uri' });
      if (p.get('client_id') !== this.variables.client_id || p.get('response_type') !== 'code' || p.has('code_challenge') && (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge')))) return json(response, 400, { error: 'invalid_request' });
      if (this.codes.size >= 1000) return json(response, 429, { error: 'fixture_capacity' });
      const code = token(); this.codes.set(code, { client: p.get('client_id'), redirect: redirect.href, nonce: p.get('nonce'), challenge: p.get('code_challenge'), expires: Date.now() + 90000 });
      redirect.searchParams.set('code', code); if (p.has('state')) redirect.searchParams.set('state', p.get('state'));
      response.writeHead(302, { location: redirect.href, 'cache-control': 'no-store' }); response.end(); return;
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      const p = new URLSearchParams(body.toString());
      let client = p.get('client_id'), secret = p.get('client_secret');
      if (request.headers.authorization?.startsWith('Basic ')) { const value = Buffer.from(request.headers.authorization.slice(6), 'base64').toString(), split = value.indexOf(':'); client = value.slice(0, split); secret = value.slice(split + 1); }
      if (client !== this.variables.client_id || secret && secret !== this.variables.client_secret) return json(response, 401, { error: 'invalid_client' });
      if (this.access.size >= 1000 || this.refresh.size >= 1000) return json(response, 429, { error: 'fixture_capacity' });
      if (p.get('grant_type') === 'authorization_code') {
        const grant = this.codes.get(p.get('code'));
        if (!grant || grant.client !== client || grant.redirect !== p.get('redirect_uri') || grant.challenge && createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== grant.challenge || !grant.challenge && secret !== this.variables.client_secret) return json(response, 400, { error: 'invalid_grant' });
        this.codes.delete(p.get('code')); return json(response, 200, this.issue(client, grant.nonce));
      }
      if (p.get('grant_type') === 'refresh_token') {
        const grant = this.refresh.get(p.get('refresh_token'));
        if (!grant || grant.client !== client || secret !== this.variables.client_secret) return json(response, 400, { error: 'invalid_grant' });
        this.refresh.delete(p.get('refresh_token')); return json(response, 200, this.issue(client));
      }
      return json(response, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/userinfo') {
      const grant = this.access.get(request.headers.authorization?.replace(/^Bearer /, ''));
      return grant ? json(response, 200, { sub: grant.claims.sub, email: grant.claims.email, name: grant.claims.name, email_verified: true }) : json(response, 401, { error: 'invalid_token' });
    }
    return json(response, 404, { error: 'fixture_route_not_found' });
  }
}

/** A bounded S3 API double. Objects and multipart state are discarded between
 * chains; no AWS credentials are used and no request is forwarded. */
export class S3Double {
  constructor({ maxBytes = 128 * 1024 ** 2 } = {}) {
    this.maxBytes = maxBytes; this.buckets = new Map([['qa-fixtures', new Map()]]); this.uploads = new Map();
    this.variables = { access_key: 'RIOQASYNTHETIC', secret_key: token(), region: 'us-east-1', bucket: 'qa-fixtures' };
  }
  setUrl(url) { this.url = url; }
  size() { return [...this.buckets.values()].reduce((sum, bucket) => sum + [...bucket.values()].reduce((n, object) => n + object.body.length, 0), 0) + [...this.uploads.values()].reduce((sum, upload) => sum + [...upload.parts.values()].reduce((n, part) => n + part.body.length, 0), 0); }
  handle(request, response, url, body) {
    let path; try { path = decodeURIComponent(url.pathname.slice(1)); } catch { return s3Error(response, 400, 'InvalidURI'); }
    const slash = path.indexOf('/'), name = slash < 0 ? path : path.slice(0, slash), key = slash < 0 ? '' : path.slice(slash + 1), p = url.searchParams;
    const bucket = this.buckets.get(name), now = new Date().toISOString(), etag = '"' + createHash('md5').update(body).digest('hex') + '"';
    if (!name && request.method === 'GET') return xml(response, 200, `<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets>${[...this.buckets.keys()].sort().map(name => `<Bucket><Name>${xmlEscape(name)}</Name><CreationDate>${now}</CreationDate></Bucket>`).join('')}</Buckets></ListAllMyBucketsResult>`);
    if (!key && request.method === 'PUT') { if (!bucket) { if (this.buckets.size >= 100) return s3Error(response, 507, 'FixtureCapacity'); this.buckets.set(name, new Map()); } response.writeHead(200); response.end(); return; }
    if (!bucket) return s3Error(response, 404, 'NoSuchBucket');
    if (!key && request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
    if (!key && request.method === 'DELETE') { if (bucket.size) return s3Error(response, 409, 'BucketNotEmpty'); this.buckets.delete(name); response.writeHead(204); response.end(); return; }
    if (!key && request.method === 'GET') {
      const prefix = p.get('prefix') || '', after = p.get('start-after') || p.get('continuation-token') || '';
      const all = [...bucket].filter(([key]) => key.startsWith(prefix) && key > after).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      const limit = Math.min(1000, Math.max(0, Number(p.get('max-keys') ?? 1000) || 0)), entries = all.slice(0, limit), truncated = all.length > entries.length;
      return xml(response, 200, `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(name)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${entries.length}</KeyCount><MaxKeys>${limit}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated && entries.length ? `<NextContinuationToken>${xmlEscape(entries.at(-1)[0])}</NextContinuationToken>` : ''}${entries.map(([key, value]) => `<Contents><Key>${xmlEscape(key)}</Key><Size>${value.body.length}</Size><ETag>${xmlEscape(value.etag)}</ETag><LastModified>${value.modified}</LastModified><StorageClass>STANDARD</StorageClass></Contents>`).join('')}</ListBucketResult>`);
    }
    if (key && request.method === 'POST' && p.has('uploads')) {
      if (this.uploads.size >= 100) return s3Error(response, 507, 'FixtureCapacity');
      const id = token(); this.uploads.set(id, { name, key, parts: new Map(), type: request.headers['content-type'] || 'application/octet-stream' });
      return xml(response, 200, `<InitiateMultipartUploadResult><Bucket>${xmlEscape(name)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (p.has('uploadId')) {
      const upload = this.uploads.get(p.get('uploadId'));
      if (!upload || upload.name !== name || upload.key !== key) return s3Error(response, 404, 'NoSuchUpload');
      if (request.method === 'PUT') {
        const part = Number(p.get('partNumber'));
        if (!Number.isInteger(part) || part < 1 || part > 10000) return s3Error(response, 400, 'InvalidPart');
        if (this.size() - (upload.parts.get(part)?.body.length || 0) + body.length > this.maxBytes) return s3Error(response, 507, 'FixtureCapacity');
        upload.parts.set(part, { body, etag }); response.writeHead(200, { etag }); response.end(); return;
      }
      if (request.method === 'DELETE') { this.uploads.delete(p.get('uploadId')); response.writeHead(204); response.end(); return; }
      if (request.method === 'POST') {
        if (bucket.size >= 10000 && !bucket.has(key)) return s3Error(response, 507, 'FixtureCapacity');
        const requested = [...body.toString().matchAll(/<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>(.*?)<\/ETag>\s*<\/Part>/gs)].map(match => ({ n: Number(match[1]), etag: match[2].replaceAll('&quot;', '"') }));
        if (!requested.length || requested.some((part, i) => i && part.n <= requested[i - 1].n || upload.parts.get(part.n)?.etag !== part.etag)) return s3Error(response, 400, 'InvalidPart');
        const data = Buffer.concat(requested.map(part => upload.parts.get(part.n).body));
        const sum = '"' + createHash('md5').update(data).digest('hex') + '-' + requested.length + '"';
        bucket.set(key, { body: data, etag: sum, type: upload.type, modified: now }); this.uploads.delete(p.get('uploadId'));
        return xml(response, 200, `<CompleteMultipartUploadResult><Location>${xmlEscape(this.url + '/' + name + '/' + key)}</Location><Bucket>${xmlEscape(name)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(sum)}</ETag></CompleteMultipartUploadResult>`);
      }
      return s3Error(response, 501, 'NotImplemented');
    }
    if (key && request.method === 'PUT') {
      if (bucket.size >= 10000 && !bucket.has(key) || this.size() - (bucket.get(key)?.body.length || 0) + body.length > this.maxBytes) return s3Error(response, 507, 'FixtureCapacity');
      bucket.set(key, { body, etag, type: request.headers['content-type'] || 'application/octet-stream', modified: now }); response.writeHead(200, { etag }); response.end(); return;
    }
    if (key && request.method === 'DELETE') { bucket.delete(key); response.writeHead(204); response.end(); return; }
    const value = bucket.get(key);
    if (key && ['GET', 'HEAD'].includes(request.method)) {
      if (!value) return s3Error(response, 404, 'NoSuchKey');
      let content = value.body, status = 200, range = {};
      if (request.headers.range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range), start = match && Number(match[1]), end = match && (match[2] ? Number(match[2]) : content.length - 1);
        if (!match || start > end || start >= content.length || end >= content.length) return s3Error(response, 416, 'InvalidRange');
        range = { 'content-range': `bytes ${start}-${end}/${content.length}` }; content = content.subarray(start, end + 1); status = 206;
      }
      response.writeHead(status, { etag: value.etag, 'content-type': value.type, 'content-length': content.length, 'last-modified': new Date(value.modified).toUTCString(), ...range }); response.end(request.method === 'HEAD' ? undefined : content); return;
    }
    return s3Error(response, 501, 'NotImplemented');
  }
}
