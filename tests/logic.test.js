/* Logic tests for everything that does not touch the page.  Run:  node tests/logic.test.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const dir = path.join(__dirname, '..', 'js');
for (const f of ['core.js', 'query.js', 'convert.js', 'diff.js', 'schema.js', 'hints.js', 'find.js', 'modes.js'])
  vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f });

const C = JF.core;
let pass = 0, fail = 0;
function eq(got, want, name) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log('FAIL ' + name + '\n   got  ' + g + '\n   want ' + w); }
}
const ok = (cond, name) => eq(!!cond, true, name);
const min = (t, lax) => C.ser(C.parse(t, lax).root, '', (c, s) => s, false);
const strictErr = t => { try { C.parse(t, false); return null; } catch (e) { return e.message; } };
const fixMsgs = t => C.parse(t, true).fixLog.map(f => f.msg);
const P = t => C.parse(t, false).root;

/* ---------- strict parsing ---------- */
eq(min('{"a":[1,2,{"b":null}],"c":true}'), '{"a":[1,2,{"b":null}],"c":true}', 'strict round trip');
eq(min('{"big":9007199254740993,"f":1.50,"e":1E+5}'), '{"big":9007199254740993,"f":1.50,"e":1E+5}', 'numbers keep their source text');
eq(min('"\\u00e9\\n"'), '"é\\n"', 'escapes');
for (const [t, m] of [
  ['{"a":1,}', 'Trailing comma before "}"'], ["{'a':1}", 'Keys need double quotes, not single quotes'],
  ['{a:1}', 'Key "a" needs double quotes'], ['[1 2]', 'Expected "," or "]"'], ['[.5]', 'Numbers need a digit before the decimal point'],
  ['[+1]', 'Numbers cannot start with "+"'], ['[0x1F]', 'Hex numbers are not allowed in JSON'], ['[NaN]', 'NaN is not allowed in JSON. Use null'],
  ['[True]', 'JSON spells True as true'], ['[01]', 'Numbers cannot have leading zeros'], ['{"a":1} x', 'Unexpected content after the end of the JSON'],
  ['{"a":1}\n}', 'Unexpected content after the end of the JSON'], ['["a', 'String is never closed'], ['[1,', 'Array is never closed'],
  ['{"a":“x”}', 'Curly "smart" quotes are not valid here. Use straight double quotes'], ['// hi\n1', 'Comments are not allowed in JSON'],
  ['[1, 2]', 'Unusual whitespace character (U+00A0). JSON allows only spaces, tabs and line breaks'], ['', 'Unexpected end of input'],
]) eq(strictErr(t), m, 'strict rejects ' + JSON.stringify(t));
eq((() => { try { C.parse('{"a": tru }', false); } catch (e) { return e.at; } })(), 6, 'error offset');

/* ---------- lax parsing: the cases auto-fix repairs ---------- */
eq(min("{'a':1, b:2, /* c */ \"d\":[1,2,],}", true), '{"a":1,"b":2,"d":[1,2]}', 'quotes, bare keys, comments, trailing commas');
eq(min('[NaN, Infinity, -Infinity, +Infinity, undefined, None, True, False]', true), '[null,null,null,null,null,null,true,false]', 'non-JSON words');
eq(min('[.5, -.5, +1, 5., 0xFF, -0x10, 0xFFFFFFFFFFFFFFFFFF]', true), '[0.5,-0.5,1,5,255,-16,4722366482869645213695]', 'number spellings, hex stays exact');
eq(min('{“name”: “ada”, ‘k’: ‘v’}', true), '{"name":"ada","k":"v"}', 'smart quotes');
eq(min('```json\n{"a": 1}\n```', true), '{"a":1}', 'code fence');
eq(min('Here you go:\n\n```json\n{"a": [1, 2]}\n```\nHope that helps!', true), '{"a":[1,2]}', 'code fence with prose around it');
eq(min('```\n{"a": 1, "b": [1, 2', true), '{"a":1,"b":[1,2]}', 'code fence that never closes');
eq(min('callback({"a": 1});', true), '{"a":1}', 'JSONP');
eq(min('window.my.cb([1,2])', true), '[1,2]', 'JSONP with a dotted name');
eq(min('[1 2 "a" {"b":1}]', true), '[1,2,"a",{"b":1}]', 'missing commas');
eq(min('[1,,2,]', true), '[1,2]', 'extra commas');
eq(min('{"a":"it\\\'s","b":"\\x41"}', true), '{"a":"it\'s","b":"A"}', 'invalid escapes');
eq(min('{"a":"line1\nline2"}', true), '{"a":"line1\\nline2"}', 'raw line break in a string');
eq(min('{ "a": 1}', true), '{"a":1}', 'non-breaking spaces');
eq(fixMsgs('{  "a": 1}'), ['Non-standard whitespace', 'Non-standard whitespace'], 'one fix per run of odd whitespace');

/* truncated input */
for (const [t, want] of [
  ['{"a": [1, 2, {"b": "hel', '{"a":[1,2,{"b":"hel"}]}'], ['{"a": 1, "b', '{"a":1}'], ['{"a": 1, "b":', '{"a":1,"b":null}'],
  ['[1, 2,', '[1,2]'], ['[tru', '[true]'], ['[1, fal', '[1,false]'], ['{"a": nu', '{"a":null}'], ['[1.', '[1]'], ['[1e', '[1]'],
  ['[1, -', '[1,null]'], ['{"a":"x\\', '{"a":"x"}'], ['{"a":"x\\u00', '{"a":"x"}'], ['[[[[', '[[[[]]]]'], ['{', '{}'],
]) eq(min(t, true), want, 'truncated ' + JSON.stringify(t));
ok(C.parse('{"a": [1, 2', true).cut, 'truncation is flagged');
ok(!C.parse('{a: 1}', true).cut, 'ordinary fixes are not flagged as truncation');
eq(fixMsgs('{"a": [1, {"b": "x'), ['Unclosed string', 'Unclosed object', 'Unclosed array', 'Unclosed object'], 'one logged fix per closed container');
eq(C.parse('{"a":1,}', true).fixLog[0], { at: 6, msg: 'Trailing comma' }, 'fix log records the offset');
eq(strictErr('[1, 2') && (() => { try { C.parse('{"a": [1, 2, "b": 3}', true); return 'parsed'; } catch (e) { return e.message; } })(), 'Expected "," or "]"', 'lax still refuses what it cannot repair');
ok(C.analyse('{"a":1}').ok, 'analyse: valid');
eq((r => [r.ok, r.err.message, r.err.at, r.fixed.fixes])(C.analyse('{"a":1,}')), [false, 'Trailing comma before "}"', 6, 1], 'analyse: fixable');
eq((r => [r.ok, r.fixed])(C.analyse('{"a" 1}')), [false, null], 'analyse: not fixable');

/* duplicate keys */
{
  const r = C.parse('{"a":1,\n "b":2,\n "a":3}', false);
  eq([r.dups, r.dupLog], [1, [{ at: 17, first: 1, key: 'a' }]], 'duplicate key offsets');
  ok(r.root.e[2][1].dup && !r.root.e[0][1].dup, 'later duplicate is marked on the node');
}

/* JSON Lines */
{
  const r = C.parse('{"a":1}\n{"a":2}\n\n[3]\n', false);
  eq([r.jsonl, r.docs, r.root.jl, r.root.e.length], [true, 3, true, 3], 'JSON Lines detected');
  eq(C.parse('1\n2\n3', false).docs, 3, 'JSON Lines of scalars');
  eq(strictErr('{"a":1} {"a":2}'), 'Unexpected content after the end of the JSON', 'two values on one line are not JSON Lines');
  eq(strictErr('{"a":1}\n{"a":}'), 'Expected a value, found "}"', 'error inside a later JSON Lines document');
  eq(C.parse('{"a":1}', false).jsonl, false, 'single document is not JSON Lines');
}

/* flattening a tree for the trip from the worker, and rebuilding it in slices */
for (const [text, lax] of [['{"a":[1,2,{"b":null,"c":[]}],"d":true,"e":{},"f":"x\\ny","a":false,"big":9007199254740993}', false],
                           ['{"id":1}\n{"id":2}\n[]\n"s"\n', false], ['[]', false], ['"lone"', false], ['{"a": [1, {"b": "cut', true], ["{a: NaN, 'b': [.5, 0xFF,], \"c\":", true]]) {
  const res = C.parse(text, lax), p = C.pack(res), step = C.unpacker(p);
  let root, calls = 0;
  while ((root = step(0)) === undefined) calls++;
  eq([p.n, C.canon(root), !!root.jl], [res.nodes, C.canon(res.root), !!res.root.jl], 'pack and rebuild ' + JSON.stringify(text).slice(0, 40));
  eq(JSON.stringify(root), JSON.stringify(res.root), 'rebuilt tree is identical, flags included ' + JSON.stringify(text).slice(0, 40));
}
{
  const big = C.parse(JSON.stringify(Array.from({ length: 5000 }, (x, i) => ({ id: i, tags: ['a', 'b'], ok: i % 2 === 0, n: null }))), false);
  const step = C.unpacker(C.pack(big));
  let root, calls = 1;
  while ((root = step(0)) === undefined) calls++;
  ok(calls > 5 && C.canon(root) === C.canon(big.root), 'a large tree is rebuilt over several slices');
}

/* helpers */
eq(C.canon(P('{"b":1.0,"a":[1,2],"b":2}')), '{"a":[1,2],"b":2}', 'canon sorts keys, last duplicate wins');
eq(C.canon(P('[1.0,1e2,-0,9007199254740993]')), '[1,100,0,9007199254740993]', 'canon normalises numbers');
eq(C.toJS(P('{"__proto__":{"x":1},"a":[true,null]}')).a, [true, null], 'toJS');
ok(Object.keys(C.toJS(P('{"__proto__":{"x":1}}'))).includes('__proto__'), 'toJS keeps __proto__ as a plain key');
eq(C.canon(C.fromJS({ a: [1, 'x', null, false] })), '{"a":[1,"x",null,false]}', 'fromJS');
eq(C.lines('ab\ncd\nef', [0, 3, 4, 7]), [{ line: 1, col: 1 }, { line: 2, col: 1 }, { line: 2, col: 2 }, { line: 3, col: 2 }], 'lines');
eq(C.ser(P('{"b":1,"a":{"d":1,"c":2}}'), '  ', (c, s) => s, true), '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}', 'pretty, sorted');

/* ---------- query ---------- */
const DOC = P(`{"host":"node-07","online":true,"ports":[22,80,443,8080],"odd key":{"a b":1},
  "tls":{"version":"1.3","expires":"2027-03-14T00:00:00Z"},"big":9007199254740993,
  "users":[{"id":1001,"name":"ada","sudo":true,"tags":["a","b"]},{"id":1002,"name":"linus","sudo":false,"tags":[]},{"id":1003,"name":"grace","sudo":true,"email":null}]}`);
const qv = text => { const r = JF.query(DOC, text); return r.none ? '(none)' : C.ser(r.root, '', (c, s) => s, false); };
const qerr = text => { try { JF.query(DOC, text); return null; } catch (e) { return e.message; } };
for (const [text, want] of [
  ['$.users[0].name', '"ada"'], ['.users[0].name', '"ada"'], ['$["odd key"]["a b"]', '1'], ["$['odd key']", '{"a b":1}'], ['."odd key"', '{"a b":1}'],
  ['$.ports[-1]', '8080'], ['$.ports[1:3]', '[80,443]'], ['$.ports[:2]', '[22,80]'], ['$.ports[-2:]', '[443,8080]'], ['$.ports[::2]', '[22,443]'],
  ['$.ports[0,2]', '[22,443]'], ['$.users[*].name', '["ada","linus","grace"]'], ['.users[].name', '["ada","linus","grace"]'],
  ['$..name', '["ada","linus","grace"]'], ['$..id', '[1001,1002,1003]'], ['$.tls.*', '["1.3","2027-03-14T00:00:00Z"]'],
  ['$.users[?(@.sudo)].name', '["ada","grace"]'], ['$.users[?(@.id > 1001 && @.name != "grace")].name', '["linus"]'],
  ['$.users[?@.id>=1002].id', '[1002,1003]'], ['$.ports[?(@ > 100)]', '[443,8080]'],
  ['.users[] | select(.sudo) | .name', '["ada","grace"]'], ['.users[] | select(.id == 1002 or .name == "ada") | .id', '[1001,1002]'],
  ['.users[] | select(.email == null) | .id', '[1001,1002,1003]'], ['.users[] | select(has("email")) | .id', '[1003]'],
  ['.users[] | select(.tags | length > 1) | .name', '["ada"]'], ['.users[] | select(.name | test("^l")) | .name', '["linus"]'],
  ['.users[] | select(.name | startswith("gr")) | .id', '[1003]'], ['.users[] | select(.sudo | not) | .name', '["linus"]'],
  ['.users | length', '3'], ['.users | map(.name)', '["ada","linus","grace"]'], ['.users | map(.name) | sort', '["ada","grace","linus"]'],
  ['.users | sort_by(.name) | map(.id)', '[1001,1003,1002]'], ['[.users[] | select(.sudo)] | length', '2'], ['.tls | keys', '["expires","version"]'],
  ['keys_unsorted | length', '7'], ['.ports | first', '22'], ['.ports | last', '8080'], ['.ports | reverse', '[8080,443,80,22]'], ['.ports | add', '8625'],
  ['.ports | min', '22'], ['.ports | max', '8080'], ['.host | length', '7'], ['.host | type', '"string"'], ['.users[0].tags | contains("a")', 'true'],
  ['.users | map(.tags) | flatten', '["a","b"]'], ['.tls | to_entries | .[0].key', '"version"'], ['.ports | map(. > 100)', '[false,false,true,true]'],
  ['.big == 9007199254740993', 'true'], ['.big > 9007199254740992', 'true'], ['$', C.canon(DOC) && C.ser(DOC, '', (c, s) => s, false)],
  ['.', C.ser(DOC, '', (c, s) => s, false)], ['.missing', '(none)'], ['.missing.deeper?', '(none)'], ['$.users[*].email', '[null]'], ['.users[9]', '(none)'],
  ['.users | map(.sudo) | unique', '[false,true]'], ['(.users | length) > 2', 'true'], ['.ports[1:3] | length', '2'], ['$.users[0:2].name', '["ada","linus"]'], ['.users[1:] | .[0].name', '"linus"'],
]) eq(qv(text), want, 'query ' + text);
eq(JF.query(DOC, '$.users[1].name').path, '$.users[1].name', 'single result keeps its path');
eq(JF.query(DOC, '$.users[?(@.sudo)].name').root.cp, ['$.users[0].name', '$.users[2].name'], 'matches keep their paths');
eq(JF.query(DOC, '.users | sort_by(.name) | .[1]').path, '$.users[2]', 'paths survive sorting');
eq(JF.query(DOC, '$..name').single, false, 'recursive descent lists matches');
eq(JF.query(DOC, '.users | length').path, '(result)', 'computed values have no path');
for (const [text, m] of [
  ['$.users[', 'Expected an index, a slice, a quoted key, * or ?(…)'], ['$.users[0', 'Expected "]"'], ['users', 'Unknown word "users". Paths start with $ or a dot, like $.users'],
  ['$.users.', 'Expected a key after "."'], ['.a | nope', 'Unknown word "nope". Paths start with $ or a dot, like $.nope'], ['.a )', 'Unexpected ")"'],
  ['.host | keys', 'keys works on objects and arrays, not on a string'], ['select', 'select needs an argument, like select(…)'], ['$.a["x', 'String is never closed'],
]) eq(qerr(text), m, 'query error ' + text);
eq((() => { try { JF.query(DOC, '$.users[0'); } catch (e) { return e.col; } })(), 10, 'query error column');

/* ---------- converters ---------- */
const V = JF.convert;
eq(V.yaml(P('{"name":"ada","n":1,"ok":true,"none":null,"list":[1,"two",{"a":1,"b":[]}],"empty":{},"nested":{"x":{"y":"z"}}}'), 2, false),
  'name: ada\n"n": 1\nok: true\nnone: null\nlist:\n  - 1\n  - two\n  - a: 1\n    b: []\nempty: {}\nnested:\n  x:\n    "y": z\n', 'yaml structure');
eq(V.yaml(P('["yes","1.5","a: b","",  " pad","#x","plain text","null","2027-03-14","multi\\nline\\n","x\\ny"]'), 2, false),
  '- "yes"\n- "1.5"\n- "a: b"\n- ""\n- " pad"\n- "#x"\n- plain text\n- "null"\n- "2027-03-14"\n- |\n  multi\n  line\n- |-\n  x\n  y\n', 'yaml quoting and block strings');
eq(V.yaml(P('[[1,2],[3]]'), 2, false), '- - 1\n  - 2\n- - 3\n', 'yaml nested arrays');
eq(V.yaml(P('{"b":1,"a":2}'), 2, true), 'a: 2\nb: 1\n', 'yaml sorted');
eq(V.yaml(P('"just a string"'), 2, false), 'just a string\n', 'yaml scalar root');
eq(V.csv(P('[{"id":1,"name":"ada","tls":{"v":"1.3"},"tags":["a","b"]},{"id":2,"name":"x, \\"y\\"","extra":null}]')),
  'id,name,tls.v,tags,extra\n1,ada,1.3,"[""a"",""b""]",\n2,"x, ""y""",,,\n', 'csv: union of columns, nested keys, quoting');
eq(V.csv(P('[[1,2],["a","b"]]')), '1,2\na,b\n', 'csv from arrays');
eq(V.csv(P('[1,"a"]')), 'value\n1\na\n', 'csv from scalars');
eq(V.csv(P('{"a":1,"b":"x"}')), 'a,b\n1,x\n', 'csv from one object');
eq((() => { try { V.csv(P('"x"')); } catch (e) { return e.message; } })(), 'CSV needs an array of objects (or one object). This value is a string', 'csv refuses scalars');
eq(V.ts(DOC, '  '), [
  'export interface Root {', '  host: string;', '  online: boolean;', '  ports: number[];', '  "odd key": OddKey;', '  tls: Tls;', '  big: number;', '  users: User[];', '}', '',
  'export interface User {', '  id: number;', '  name: string;', '  sudo: boolean;', '  tags?: string[];', '  email?: null;', '}', '',
  'export interface Tls {', '  version: string;', '  expires: string;', '}', '',
  'export interface OddKey {', '  "a b": number;', '}', '',
].join('\n'), 'typescript');
eq(V.ts(P('[1,"a",null,[true]]'), '  '), 'export type Root = (number | string | null | boolean[])[];\n', 'typescript union root');
eq(V.ts(P('[]'), '  '), 'export type Root = unknown[];\n', 'typescript empty array');
eq(V.ts(P('{"a":{"x":1},"b":{"x":2}}'), '  '), 'export interface Root {\n  a: A;\n  b: A;\n}\n\nexport interface A {\n  x: number;\n}\n', 'typescript reuses identical shapes');
eq(C.ser(V.schema(P('{"id":1,"score":1.5,"tags":["a"],"mix":[1,"a"],"rows":[{"a":1},{"a":2.5,"b":null}]}')), '', (c, s) => s, false),
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"id":{"type":"integer"},"score":{"type":"number"},' +
  '"tags":{"type":"array","items":{"type":"string"}},"mix":{"type":"array","items":{"type":["integer","string"]}},' +
  '"rows":{"type":"array","items":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"null"}},"required":["a"]}}},' +
  '"required":["id","score","tags","mix","rows"]}', 'generated schema');

/* ---------- diff ---------- */
const dv = (a, b) => JF.diff(P(a), P(b)).rows.map(r => r.op + ' ' + (r.pathA || r.pathB) + (r.a ? ' ' + C.canon(r.a) : '') + (r.b ? ' > ' + C.canon(r.b) : ''));
eq(dv('{"a":1,"b":{"c":[1,2,3]},"d":"x"}', '{"b":{"c":[1,2,3]},"a":1.0,"d":"x"}'), [], 'diff ignores key order and 1 vs 1.0');
eq(dv('{"a":1,"b":2,"c":{"d":"x"}}', '{"a":1,"c":{"d":"y"},"e":[1]}'), ['- $.b 2', '~ $.c.d "x" > "y"', '+ $.e > [1]'], 'diff of objects');
eq(dv('[1,2,3,4]', '[1,3,4]'), ['- $[1] 2'], 'diff: removing one item is one removal');
eq(dv('[1,2,3]', '[0,1,2,3]'), ['+ $[0] > 0'], 'diff: inserting at the front is one addition');
eq(dv('[{"id":1,"n":"a"},{"id":2,"n":"b"}]', '[{"id":1,"n":"a"},{"id":2,"n":"B"},{"id":3}]'), ['~ $[1].n "b" > "B"', '+ $[2] > {"id":3}'], 'diff: changed item is diffed inside');
eq(dv('{"a":[1,2]}', '{"a":{"x":1}}'), ['~ $.a [1,2] > {"x":1}'], 'diff: type change');
eq(dv('9007199254740993', '9007199254740992'), ['~ $ 9007199254740993 > 9007199254740992'], 'diff: big integers compare exactly');
eq((r => [r.add, r.del, r.chg, r.capped])(JF.diff(P('[1,2,3]'), P('[4,5]'))), [0, 1, 2, false], 'diff counts');
eq(JF.diff(P('[1,2,3,4]'), P('[1,3,4,5]')).rows.map(r => [r.op, r.pathA, r.pathB]), [['-', '$[1]', null], ['+', null, '$[3]']], 'diff paths point into the right side');

/* ---------- schema validation ---------- */
const check = (doc, schema) => JF.validate(P(doc), C.toJS(P(schema))).errors.map(e => e.path + ': ' + e.msg);
const SCHEMA = `{"type":"object","required":["id","name"],"additionalProperties":false,"properties":{
  "id":{"type":"integer","minimum":1},"name":{"type":"string","minLength":2,"pattern":"^[a-z]+$"},
  "email":{"type":"string","format":"email"},"tags":{"type":"array","items":{"type":"string"},"uniqueItems":true,"maxItems":3},
  "role":{"enum":["admin","user"]},"parent":{"$ref":"#"},"when":{"type":["string","null"],"format":"date-time"}}}`;
eq(check('{"id":1,"name":"ada","email":"a@b.co","tags":["x"],"role":"admin","when":null}', SCHEMA), [], 'valid document passes');
eq(check('{"id":0,"name":"A","email":"nope","tags":["x","x",3,"y"],"role":"root","extra":1,"when":"soon"}', SCHEMA), [
  '$.id: below the minimum of 1', '$.name: shorter than 2 characters', '$.name: does not match the pattern ^[a-z]+$', '$.email: not a valid email',
  '$.tags: more than 3 items', '$.tags: items are not unique', '$.tags[2]: expected string, got number',
  '$.role: not one of the allowed values: "admin", "user"', '$.extra: key "extra" is not allowed here', '$.when: not a valid date-time',
], 'each kind of failure is reported with its path');
eq(check('{"name":"ada","parent":{"id":"x","name":"bo"}}', SCHEMA), ['$: missing required key "id"', '$.parent.id: expected integer, got string'], 'required and recursive $ref');
eq(check('{"id":1.5,"name":"ada"}', SCHEMA), ['$.id: expected integer, got a non-integer number'], 'integer check');
eq(check('{"id":1.0,"name":"ada"}', SCHEMA), [], '1.0 counts as an integer');
eq(check('5', '{"anyOf":[{"type":"string"},{"type":"number","minimum":10}]}'), ['$: matches none of the 2 anyOf options', '$: closest anyOf option: expected string, got number'], 'anyOf');
eq(check('5', '{"oneOf":[{"type":"number"},{"minimum":1}]}'), ['$: matches 2 oneOf options, expected exactly one'], 'oneOf');
eq(check('{"kind":"a"}', '{"if":{"properties":{"kind":{"const":"a"}}},"then":{"required":["x"]},"else":{"required":["y"]}}'), ['$: missing required key "x"'], 'if / then / else');
eq(check('[1,"a",true]', '{"prefixItems":[{"type":"number"},{"type":"string"}],"items":false}'), ['$[2]: no value is allowed here'], 'prefixItems and items:false');
eq(check('[1,"a"]', '{"items":[{"type":"string"}],"additionalItems":{"type":"number"}}'), ['$[0]: expected string, got number', '$[1]: expected number, got string'], 'draft-07 tuple items');
eq(check('{"a":1,"b_x":"s"}', '{"patternProperties":{"^b_":{"type":"number"}},"additionalProperties":{"type":"string"}}'), ['$.a: expected string, got number', '$.b_x: expected number, got string'], 'patternProperties');
eq(check('{"n":{"v":3}}', '{"properties":{"n":{"$ref":"#/$defs/node"}},"$defs":{"node":{"properties":{"v":{"multipleOf":2,"exclusiveMaximum":3}}}}}'), ['$.n.v: must be less than 3', '$.n.v: not a multiple of 2'], '$defs, multipleOf, exclusiveMaximum');
eq(check('"x"', '{"not":{"type":"string"}}'), ['$: matches a schema it must not match'], 'not');
eq(check('[1,2]', '{"contains":{"type":"string"}}'), ['$: no item matches "contains"'], 'contains');
eq(check('{"card":1}', '{"dependentRequired":{"card":["cvv"]}}'), ['$: key "cvv" is required when "card" is present'], 'dependentRequired');
eq(JF.validate(P('1'), C.toJS(P('{"$ref":"https://example.com/s.json","unevaluatedProperties":false}'))).ignored,
  ['unevaluatedProperties', '$ref https://example.com/s.json (only references inside this schema are followed)'], 'unsupported keywords are reported, not skipped silently');
eq(JF.validate(P('1'), C.toJS(P('{"$ref":"#"}'))).errors, [], 'a self-referencing schema terminates');
eq(JF.validate(DOC, C.toJS(V.schema(DOC))).errors, [], 'a document validates against its own generated schema');

/* ---------- hints ---------- */
const H = JF.hints;
eq(H.stamp('1767225600', 'created_at'), { ms: 1767225600000, unit: 'seconds', iso: '2026-01-01T00:00:00Z', likely: true }, 'timestamp in seconds');
eq((s => [s.unit, s.iso, s.likely])(H.stamp('1767225600123', 'n')), ['milliseconds', '2026-01-01T00:00:00.123Z', false], 'timestamp in milliseconds');
eq([H.stamp('1846203', 'uptime_s'), H.stamp('9007199254740993', 'id'), H.stamp('443', 'port')], [null, null, null], 'ordinary numbers are not timestamps');
eq(['updatedAt', 'expires', 'iat', 'timestamp', 'format', 'rating', 'candidate'].map(k => H.stamp('1767225600', k).likely), [true, true, true, true, false, false, true], 'key names that suggest a time');
const b64 = s => Buffer.from(s).toString('base64'), b64u = s => Buffer.from(s).toString('base64url');
const JWT = b64u('{"alg":"HS256","typ":"JWT"}') + '.' + b64u('{"sub":"ada","exp":1893456000}') + '.c2lnbmF0dXJl';
eq(['https://example.com/a?b=1', 'http://x', 'https://bad url', JWT, '{"a":1}', '[1, 2]', '{not json}', '{}', b64('stay curious, stay kind'), 'TLS_AES_256_GCM_SHA384',
    'deadbeefdeadbeefdeadbeef', 'node-07.lab.internal', 'hello world, plain text'].map(H.kind),
  ['url', 'url', null, 'jwt', 'json', 'json', null, null, 'b64', null, null, null, null], 'value kinds');
eq(C.canon(H.decode('json', '{"a":[1,2]}').root), '{"a":[1,2]}', 'decode JSON in a string');
eq(H.decode('b64', b64('stay curious, stay kind')).root, { t: 's', v: 'stay curious, stay kind' }, 'decode base64 text');
eq(C.canon(H.decode('b64', b64('{"deep":true}')).root), '{"deep":true}', 'base64 that holds JSON is parsed too');
eq(C.canon(H.decode('jwt', JWT).root), '{"header":{"alg":"HS256","typ":"JWT"},"payload":{"exp":1893456000,"sub":"ada"},"signature":"c2lnbmF0dXJl"}', 'decode JWT');
const NOW = Date.UTC(2026, 9, 5);
eq(H.describe({ t: 'n', v: '9007199254740993' }, 'id', NOW), ['integer beyond 2^53, digits kept exact'], 'describe big integer');
eq(H.describe({ t: 'n', v: '1767225600' }, 'x', NOW), ['as Unix seconds: 2026-01-01T00:00:00Z (9 months ago)'], 'describe timestamp');
eq(H.describe({ t: 's', v: JWT }, 't', NOW), ['JWT, HS256, expires in 3 years (signature not verified)'], 'describe JWT');
eq(H.describe({ t: 's', v: 'https://example.com/x' }, 'u', NOW), ['link to example.com'], 'describe URL');
eq([H.ago(NOW - 90000, NOW), H.ago(NOW + 3 * 86400000, NOW), H.ago(NOW - 5000, NOW)], ['1 minute ago', 'in 3 days', 'just now'], 'relative times');
/* a bare JWT as the whole input */
const UNSIGNED = b64u('{"alg":"none","typ":"JWT"}') + '.' + b64u('{"sub":"example-user","exp":4102444799}') + '.';
eq([H.bareJwt(JWT), H.bareJwt('  ' + JWT + '\n'), H.bareJwt('Bearer ' + JWT), H.bareJwt('bearer\t' + JWT), H.bareJwt(UNSIGNED)],
  [JWT, JWT, JWT, JWT, UNSIGNED], 'bare JWT: plain, padded, with a Bearer prefix, unsigned');
eq([H.bareJwt('"' + JWT + '"'), H.bareJwt('{"t":"' + JWT + '"}'), H.bareJwt(JWT + ' trailing'), H.bareJwt('Token ' + JWT)], [null, null, null, null],
  'not bare: quoted (that is valid JSON), inside JSON, extra text, another scheme');
eq([H.bareJwt('eyJhbGciOi.eyJzdWIi.sig'), H.bareJwt(b64u('[1]').replace(/^/, 'eyJ') + '.' + b64u('{"a":1}') + '.x'), H.bareJwt(b64u('"s"') + '.' + b64u('{"a":1}') + '.')],
  [null, null, null], 'not bare: parts that do not decode to JSON objects');
eq(H.describe({ t: 's', v: UNSIGNED }, 't', NOW), ['JWT, none, expires in 73 years (signature not verified)'], 'describe an unsigned JWT');

/* ---------- search in text output ---------- */
const F = JF.find;
const hits = (text, term, cap = 100) => { const p = F.pattern(term); return F.ranges(text, p.mark, cap); };
eq([F.pattern(''), F.pattern('/a(/').error], [null, 'not a valid pattern'], 'empty and bad patterns');
eq(hits('A.b a.B axb', 'a.b').ranges, [[0, 3], [4, 7]], 'plain text matches literally and ignores case');
eq(hits('a1 b22 c333', '/\\d+/').ranges, [[1, 2], [4, 6], [8, 11]], 'regular expression');
eq(hits('Ab ab', '/ab/').ranges, [[3, 5]], 'a regular expression without i is case sensitive');
eq(hits('Ab ab', '/ab/ig').ranges, [[0, 2], [3, 5]], 'flags are kept, g and y are dropped');
eq(hits('abc', '/x*/').ranges, [], 'empty matches are skipped and do not loop');
eq((r => [r.ranges.length, r.more])(hits('aaaaa', 'a', 3)), [3, true], 'matches are capped');
eq((r => [r.ranges.length, r.more])(hits('aaa', 'a', 3)), [3, false], 'exactly the cap is not more');
const tok = t => F.tokens(t).map(x => x[2] + ':' + t.slice(x[0], x[1]));
eq(tok('{"a":"x\\"y","n":-1.5e3,"t":true,"f":false,"z":null,"l":[1,"s"]}'),
  ['k:"a"', 's:"x\\"y"', 'k:"n"', 'nu:-1.5e3', 'k:"t"', 'b:true', 'k:"f"', 'b:false', 'k:"z"', 'z:null', 'k:"l"', 'nu:1', 's:"s"'], 'tokens of minified JSON');
eq(tok('{"a": "b"}\n{"a" :1}'), ['k:"a"', 's:"b"', 'k:"a"', 'nu:1'], 'tokens across JSON Lines, space before the colon');
eq(F.paint('{"a":1}', F.tokens('{"a":1}'), [], -1), '{<span class="k">&quot;a&quot;</span>:<span class="nu">1</span>}', 'paint colours like the serialiser');
eq(F.paint('ab<cd', [], [[1, 4]], 0), 'a<mark data-m="0" class="now">b&lt;c</mark>d', 'paint escapes and marks the current match');
eq(F.paint('"ab":12', [[0, 4, 'k'], [5, 7, 'nu']], [[2, 6]], -1),
  '<span class="k">&quot;a</span><span class="k"><mark data-m="0">b&quot;</mark></span><mark data-m="0">:</mark><span class="nu"><mark data-m="0">1</mark></span><span class="nu">2</span>',
  'a match that crosses colour spans is split, every piece keeps its index');
eq(F.paint('', [], [], -1), '', 'paint empty text');

/* ---------- modes: prompt text and where the page starts ---------- */
const M = JF.modes;
eq(['pretty', 'min', 'yaml', 'csv', 'ts', 'schema', 'diff', 'check'].map(m => M.prompt({ mode: m, ind: '2', sort: false })),
  ['fmt --indent=2', 'fmt --minify', 'convert --to=yaml --indent=2', 'convert --to=csv', 'convert --to=ts --indent=2', 'fmt --to=schema --indent=2', 'diff a b', 'validate a --schema=b'], 'prompt text per mode');
eq([M.prompt({ mode: 'pretty', ind: 'tab', sort: true }), M.prompt({ mode: 'min', sort: true }), M.prompt({ mode: 'ts', ind: '4', sort: true }), M.prompt({ mode: 'yaml' })],
  ['fmt --indent=tab --sort-keys', 'fmt --minify --sort-keys', 'convert --to=ts --indent=4', 'convert --to=yaml --indent=2'], 'prompt text with indent and sort');
const S0 = { sample: 'SAMPLE' }, SH = { a: 'x', b: 'y', q: '.a', m: 'diff' }, PG = { mode: 'yaml', a: 'PA', b: 'PB', q: '.p', name: 'p.json' };
const TB = { a: { text: 'TA', name: 'ta.json' }, b: null }, SV = { mode: 'csv', buf: 'b' };
const st0 = o => (r => [r.mode, r.a.text, r.a.name, r.b.text, r.q, r.buf, r.from])(M.start(Object.assign({}, S0, o)));
eq(st0({}), ['pretty', 'SAMPLE', 'sample.json', '', '', 'a', 'sample'], 'start: nothing saved, no page');
eq(st0({ page: PG }), ['yaml', 'PA', 'p.json', 'PB', '.p', 'a', 'page'], 'start: first visit to a tool page uses its mode, input and query');
eq(st0({ page: PG, saved: SV, tabs: TB }), ['yaml', 'TA', 'ta.json', '', '', 'b', 'saved'], 'start: the page mode wins, saved input wins over the page input');
eq(st0({ saved: SV, tabs: TB }), ['csv', 'TA', 'ta.json', '', '', 'b', 'saved'], 'start: no page mode, the saved mode applies');
eq(st0({ page: PG, saved: Object.assign({ where: 'idb' }, SV), tabs: null }), ['yaml', '', '', '', '', 'b', 'lost'], 'start: stored text that is gone starts empty, not with the sample');
eq(st0({ page: PG, saved: { s: null, mode: 'csv' }, tabs: null })[6], 'lost', 'start: an older version that could not keep the input starts empty');
eq(st0({ page: PG, saved: SV, tabs: null }), ['yaml', 'PA', 'p.json', 'PB', '.p', 'a', 'page'], 'start: settings alone (theme, mode) are not saved input, the page sample loads');
eq(st0({ page: PG, saved: SV, tabs: TB, shared: SH }), ['diff', 'x', 'shared', 'y', '.a', 'a', 'shared'], 'start: a share link wins over everything');
eq([st0({ page: { mode: 'nope' }, saved: { mode: 'bad' } })[0], st0({ page: { mode: 'check' } })[0]], ['pretty', 'check'], 'start: unknown modes are ignored');
eq(M.ownKeys(['scanline-json', 'scanline-json.a', 'scanline-json.b', 'scanline-jsonx', 'other', 'other.scanline-json'], ['scanline-json']),
  ['scanline-json', 'scanline-json.a', 'scanline-json.b'], "clear saved data picks only this app's keys");

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
