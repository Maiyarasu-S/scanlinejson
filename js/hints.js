/* hints.js: recognise what a value probably is (a Unix time, a URL, a JWT, base64 text, JSON inside
   a string) and decode it. Everything here is a guess shown beside the data, never a change to it. */
(() => {
'use strict';
const C = JF.core;
const TIME_KEY = /(time|date|stamp|_at$|[a-z]At$|^ts$|_ts$|^exp$|^iat$|^nbf$|expir|created|updated|modified|born)/;
const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const Y2000 = 946684800, Y2100 = 4102444800;

/* A number that could be a Unix time between 2000 and 2100, in seconds or milliseconds.
   `likely` is true only when the key name also says so, which is when the tree shows it inline. */
function stamp(v, key) {
  if (!/^\d{9,13}(\.\d+)?$/.test(v)) return null;
  const x = Number(v);
  let ms, unit;
  if (x >= Y2000 && x < Y2100) { ms = x * 1000; unit = 'seconds'; }
  else if (x >= Y2000 * 1000 && x < Y2100 * 1000) { ms = x; unit = 'milliseconds'; }
  else return null;
  return { ms, unit, iso: new Date(ms).toISOString().replace('.000Z', 'Z'), likely: typeof key === 'string' && TIME_KEY.test(key) };
}

function ago(ms, now = Date.now()) {
  const d = ms - now, a = Math.abs(d);
  const units = [[31557600000, 'year'], [2629800000, 'month'], [86400000, 'day'], [3600000, 'hour'], [60000, 'minute']];
  for (const [size, name] of units) {
    if (a >= size) { const k = Math.floor(a / size), txt = k + ' ' + name + (k === 1 ? '' : 's'); return d < 0 ? txt + ' ago' : 'in ' + txt; }
  }
  return 'just now';
}

function b64bytes(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (t.length % 4 === 1) return null;
  t += '==='.slice(0, (4 - t.length % 4) % 4);
  let bin;
  try { bin = atob(t); } catch (e) { return null; }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
/* Base64 that decodes to readable UTF-8 text, or null. Random strings almost never survive both checks. */
function b64text(s) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s) || /^[0-9a-fA-F]+$/.test(s)) return null;
  const bytes = b64bytes(s);
  if (!bytes || !bytes.length) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { return null; }
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/.test(text) ? null : text;
}

const holdsJSON = s => {
  const t = s.trim(), a = t[0], z = t[t.length - 1];
  return t.length > 2 && ((a === '{' && z === '}') || (a === '[' && z === ']'));
};

/* 'url' | 'jwt' | 'json' | 'b64' | null. Called for every string the tree draws, so cheap tests come first. */
function kind(s) {
  const L = s.length;
  if (L < 3 || L > 200000) return null;
  const c = s.charCodeAt(0);
  if ((c === 104 || c === 72) && L < 2048 && /^https?:\/\/[^\s"'<>`\\]+$/i.test(s)) return 'url';
  if (c === 101 && /^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*$/.test(s)) return 'jwt';
  if (c === 123 || c === 91 || c === 32 || c === 10) {
    if (!holdsJSON(s)) return null;
    if (L <= 50000) { try { JSON.parse(s); } catch (e) { return null; } }
    return 'json';
  }
  if (L >= 16 && L <= 100000 && b64text(s) !== null) return 'b64';
  return null;
}

const tryParse = text => { try { return C.parse(text, false).root; } catch (e) { return null; } };

/* Decode a string of the given kind into something the tree can draw: { root, label, fn }. */
function decode(k, s) {
  if (k === 'json') { const root = tryParse(s); return root && { root, label: 'JSON inside this string', fn: 'fromjson' }; }
  if (k === 'b64') {
    const text = b64text(s);
    if (text === null) return null;
    const root = holdsJSON(text) ? tryParse(text) : null;
    return { root: root || { t: 's', v: text }, label: root ? 'base64, decoded and parsed' : 'base64, decoded', fn: '@base64d' };
  }
  if (k === 'jwt') {
    const parts = s.split('.'), dec = p => { const b = b64bytes(p); if (!b) return null; try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { return null; } };
    const head = dec(parts[0]), body = dec(parts[1]);
    if (head === null || body === null) return null;
    return {
      root: { t: 'o', e: [['header', tryParse(head) || { t: 's', v: head }], ['payload', tryParse(body) || { t: 's', v: body }], ['signature', { t: 's', v: parts[2] }]] },
      label: 'JWT decoded (signature not verified)', fn: 'jwt',
    };
  }
  return null;
}

/* The whole input is a bare JWT (not JSON), as copied from an Authorization header or a cookie.
   Returns the token, or null. A "Bearer " prefix and surrounding whitespace are allowed; the header and
   payload must both decode, so a random dotted string does not count. */
const BARE = /^(?:Bearer\s+)?(eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*)$/i;
function bareJwt(text) {
  if (text.length > 100000) return null;
  const m = BARE.exec(text.trim());
  if (!m) return null;
  const d = decode('jwt', m[1]);
  return d && d.root.e[0][1].t === 'o' && d.root.e[1][1].t === 'o' ? m[1] : null;
}

/* Short plain-text facts about a value, for the inspector line. */
function describe(nd, key, now = Date.now()) {
  const out = [];
  if (nd.t === 'n') {
    if (/^-?\d+$/.test(nd.v) && !Number.isSafeInteger(Number(nd.v))) out.push('integer beyond 2^53, digits kept exact');
    const ts = stamp(nd.v, key);
    if (ts) out.push('as Unix ' + ts.unit + ': ' + ts.iso + ' (' + ago(ts.ms, now) + ')');
  } else if (nd.t === 's') {
    const s = nd.v;
    if (s.length >= 10 && s.length <= 40 && ISO.test(s)) {
      const ms = Date.parse(s.replace(' ', 'T'));
      if (!Number.isNaN(ms)) out.push(ago(ms, now) + ', ' + new Date(ms).toLocaleString() + ' local');
    }
    const k = kind(s);
    if (k === 'url') { try { out.push('link to ' + new URL(s).host); } catch (e) {} }
    else if (k === 'json') out.push('holds JSON: use the {…} badge to expand it');
    else if (k === 'b64') { const t = b64text(s); out.push('base64 for ' + t.length.toLocaleString('en') + ' characters of text'); }
    else if (k === 'jwt') {
      const d = decode('jwt', s);
      if (d) {
        const js = C.toJS(d.root), h = js.header, p = js.payload;
        let line = 'JWT' + (h && typeof h.alg === 'string' ? ', ' + h.alg : '');
        if (p && typeof p.exp === 'number') line += p.exp * 1000 < now ? ', expired ' + ago(p.exp * 1000, now) : ', expires ' + ago(p.exp * 1000, now);
        out.push(line + ' (signature not verified)');
      }
    }
  }
  return out;
}

JF.hints = { stamp, ago, kind, decode, describe, b64text, bareJwt };
})();
