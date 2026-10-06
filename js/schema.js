/* schema.js: check a parsed document against a JSON Schema.

   Covers the keywords people use day to day (draft 2020-12, and the draft-07 spellings):
     type, enum, const, $ref (inside the same schema), $defs / definitions, allOf, anyOf, oneOf, not, if / then / else,
     properties, required, additionalProperties, patternProperties, propertyNames, minProperties, maxProperties,
     dependentRequired, dependencies, items, prefixItems, additionalItems, contains, minContains, maxContains,
     minItems, maxItems, uniqueItems, minLength, maxLength, pattern, format, minimum, maximum,
     exclusiveMinimum, exclusiveMaximum, multipleOf.
   Keywords it cannot evaluate are reported in `ignored` so a pass is never silently wrong.

   Returns { errors:[{ path, msg }], capped, ignored:[...] }. */
(() => {
'use strict';
const C = JF.core;
const SAFE = /^[A-Za-z_$][\w$]*$/;
const sub = (p, k) => p + (SAFE.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']');
const UNSUPPORTED = ['unevaluatedProperties', 'unevaluatedItems', 'dependentSchemas', '$dynamicRef', '$recursiveRef', 'contentSchema'];
const CAP = 2000;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const q = k => JSON.stringify(k);

const validDate = s => !Number.isNaN(Date.parse(s));
const FORMATS = {
  'date-time': s => /^\d{4}-\d\d-\d\d[Tt ]\d\d:\d\d:\d\d(\.\d+)?([Zz]|[+-]\d\d:\d\d)$/.test(s) && validDate(s.replace(' ', 'T')),
  date: s => /^\d{4}-\d\d-\d\d$/.test(s) && validDate(s + 'T00:00:00Z'),
  time: s => /^([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]\d\d:\d\d)?$/.test(s),
  email: s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uri: s => /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/.test(s),
  uuid: s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  ipv4: s => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s),
  hostname: s => s.length <= 253 && /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(s),
};

JF.validate = function (inst, schema) {
  const ignored = new Set(), regexes = new Map();
  const regex = src => {
    if (!regexes.has(src)) { let re = null; try { re = new RegExp(src, 'u'); } catch (e) { try { re = new RegExp(src); } catch (x) { ignored.add('pattern ' + src + ' (not a valid regular expression)'); } } regexes.set(src, re); }
    return regexes.get(src);
  };
  function deref(ref) {
    if (ref === '#') return schema;
    if (ref.slice(0, 2) !== '#/') return undefined;
    let cur = schema;
    for (const raw of ref.slice(2).split('/')) {
      let part;
      try { part = decodeURIComponent(raw); } catch (e) { part = raw; }
      part = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (cur === null || typeof cur !== 'object' || !has(cur, part)) return undefined;
      cur = cur[part];
    }
    return cur;
  }

  /* refs: how many $ref hops were followed without moving to a child value (stops reference loops) */
  function check(nd, s, path, out, refs) {
    if (s === true) return true;
    if (s === false) { if (out.length < CAP) out.push({ path, msg: 'no value is allowed here' }); return false; }
    if (!isObj(s)) return true;
    let ok = true;
    const bad = msg => { ok = false; if (out.length < CAP) out.push({ path, msg }); };
    const sub1 = (child, cs, cp) => { if (!check(child, cs, cp, out, 0)) ok = false; };
    const passes = cs => check(nd, cs, path, [], refs);
    for (const k of UNSUPPORTED) if (has(s, k)) ignored.add(k);

    if (typeof s.$ref === 'string') {
      const target = refs > 50 ? undefined : deref(s.$ref);
      if (target === undefined) ignored.add('$ref ' + s.$ref + (refs > 50 ? ' (loops)' : ' (only references inside this schema are followed)'));
      else if (!check(nd, target, path, out, refs + 1)) ok = false;
    }

    const tn = C.typeName(nd);
    const isInt = nd.t === 'n' && Number.isInteger(Number(nd.v));
    if (s.type !== undefined) {
      const want = Array.isArray(s.type) ? s.type : [s.type];
      if (!want.some(t => t === tn || (t === 'integer' && isInt))) bad('expected ' + want.join(' or ') + ', got ' + (tn === 'number' && !isInt ? 'a non-integer number' : tn));
    }
    if (Array.isArray(s.enum) || has(s, 'const')) {
      const cn = C.canon(nd);
      if (Array.isArray(s.enum) && !s.enum.some(v => C.canon(C.fromJS(v)) === cn)) bad('not one of the allowed values: ' + s.enum.map(v => JSON.stringify(v)).join(', ').slice(0, 200));
      if (has(s, 'const') && C.canon(C.fromJS(s.const)) !== cn) bad('must equal ' + JSON.stringify(s.const).slice(0, 200));
    }

    if (nd.t === 'n') {
      const x = Number(nd.v);
      const exMin = s.exclusiveMinimum === true ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum : undefined;
      const exMax = s.exclusiveMaximum === true ? s.maximum : typeof s.exclusiveMaximum === 'number' ? s.exclusiveMaximum : undefined;
      if (typeof s.minimum === 'number' && s.exclusiveMinimum !== true && x < s.minimum) bad('below the minimum of ' + s.minimum);
      if (typeof s.maximum === 'number' && s.exclusiveMaximum !== true && x > s.maximum) bad('above the maximum of ' + s.maximum);
      if (typeof exMin === 'number' && x <= exMin) bad('must be greater than ' + exMin);
      if (typeof exMax === 'number' && x >= exMax) bad('must be less than ' + exMax);
      if (typeof s.multipleOf === 'number' && s.multipleOf > 0) { const r = x / s.multipleOf; if (Math.abs(r - Math.round(r)) > 1e-9) bad('not a multiple of ' + s.multipleOf); }
    }

    if (nd.t === 's') {
      if (typeof s.minLength === 'number' || typeof s.maxLength === 'number') {
        const len = [...nd.v].length;
        if (len < s.minLength) bad('shorter than ' + s.minLength + ' characters');
        if (len > s.maxLength) bad('longer than ' + s.maxLength + ' characters');
      }
      if (typeof s.pattern === 'string') { const re = regex(s.pattern); if (re && !re.test(nd.v)) bad('does not match the pattern ' + s.pattern); }
      if (typeof s.format === 'string' && has(FORMATS, s.format) && !FORMATS[s.format](nd.v)) bad('not a valid ' + s.format);
    }

    if (nd.t === 'a') {
      const len = nd.e.length;
      if (len < s.minItems) bad('fewer than ' + s.minItems + ' items');
      if (len > s.maxItems) bad('more than ' + s.maxItems + ' items');
      if (s.uniqueItems === true && new Set(nd.e.map(C.canon)).size !== len) bad('items are not unique');
      const tuple = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : null;
      const rest = Array.isArray(s.items) ? s.additionalItems : s.items;
      for (let j = 0; j < len; j++) {
        if (tuple && j < tuple.length) sub1(nd.e[j], tuple[j], path + '[' + j + ']');
        else if (rest !== undefined) sub1(nd.e[j], rest, path + '[' + j + ']');
      }
      if (s.contains !== undefined) {
        let hits = 0;
        for (const x of nd.e) if (check(x, s.contains, path, [], 0)) hits++;
        const lo = typeof s.minContains === 'number' ? s.minContains : 1;
        if (hits < lo) bad(lo === 1 ? 'no item matches "contains"' : 'fewer than ' + lo + ' items match "contains"');
        if (typeof s.maxContains === 'number' && hits > s.maxContains) bad('more than ' + s.maxContains + ' items match "contains"');
      }
    }

    if (nd.t === 'o') {
      const props = new Map(nd.e);                                 /* last duplicate wins */
      if (Array.isArray(s.required)) for (const k of s.required) if (!props.has(k)) bad('missing required key ' + q(k));
      if (props.size < s.minProperties) bad('fewer than ' + s.minProperties + ' keys');
      if (props.size > s.maxProperties) bad('more than ' + s.maxProperties + ' keys');
      const known = isObj(s.properties) ? s.properties : null;
      const pats = isObj(s.patternProperties) ? Object.keys(s.patternProperties).map(p => [regex(p), s.patternProperties[p]]).filter(r => r[0]) : [];
      for (const [k, v] of props) {
        const cp = sub(path, k);
        let matched = false;
        if (known && has(known, k)) { matched = true; sub1(v, known[k], cp); }
        for (const [re, ps] of pats) if (re.test(k)) { matched = true; sub1(v, ps, cp); }
        if (!matched && s.additionalProperties !== undefined) {
          if (s.additionalProperties === false) { ok = false; if (out.length < CAP) out.push({ path: cp, msg: 'key ' + q(k) + ' is not allowed here' }); }
          else sub1(v, s.additionalProperties, cp);
        }
        if (s.propertyNames !== undefined && !check({ t: 's', v: k }, s.propertyNames, cp, [], 0)) bad('key ' + q(k) + ' does not fit the schema for key names');
      }
      const deps = Object.assign({}, isObj(s.dependencies) ? s.dependencies : null, isObj(s.dependentRequired) ? s.dependentRequired : null);
      for (const k of Object.keys(deps)) {
        if (!props.has(k)) continue;
        if (Array.isArray(deps[k])) { for (const need of deps[k]) if (!props.has(need)) bad('key ' + q(need) + ' is required when ' + q(k) + ' is present'); }
        else if (!check(nd, deps[k], path, out, refs)) ok = false;
      }
    }

    if (Array.isArray(s.allOf)) for (const cs of s.allOf) if (!check(nd, cs, path, out, refs)) ok = false;
    for (const kw of ['anyOf', 'oneOf']) {
      if (!Array.isArray(s[kw])) continue;
      const tries = s[kw].map(cs => { const errs = []; return { ok: check(nd, cs, path, errs, refs), errs }; });
      const good = tries.filter(r => r.ok).length;
      if (good === 0) {
        bad('matches none of the ' + tries.length + ' ' + kw + ' options');
        const closest = tries.reduce((m, r) => (r.errs.length < m.errs.length ? r : m), tries[0]);   /* show why the nearest option failed */
        if (closest) for (const e of closest.errs.slice(0, 5)) if (out.length < CAP) out.push({ path: e.path, msg: 'closest ' + kw + ' option: ' + e.msg });
      }
      else if (kw === 'oneOf' && good > 1) bad('matches ' + good + ' oneOf options, expected exactly one');
    }
    if (s.not !== undefined && passes(s.not)) bad('matches a schema it must not match');
    if (s.if !== undefined) {
      const branch = passes(s.if) ? s.then : s.else;
      if (branch !== undefined && !check(nd, branch, path, out, refs)) ok = false;
    }
    return ok;
  }

  const errors = [];
  check(inst, schema, '$', errors, 0);
  return { errors, capped: errors.length >= CAP, ignored: [...ignored] };
};
})();
