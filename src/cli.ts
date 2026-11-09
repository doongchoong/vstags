#!/usr/bin/env node
/**
 * vstags CLI - VSCode 없이 같은 색인 엔진을 쓰는 명령행 도구.
 *   빌드 서버에서 tags 파일을 만들거나, 파서 동작을 확인할 때 사용.
 *
 *   node out/cli.js <dir> [stats|defs NAME|refs NAME|callers NAME|callees NAME|search Q|dump FILE|ctags [OUT]]
 */
import * as fs from 'fs';
import * as path from 'path';
import { toCtags } from './core/ctags';
import { indexFiles } from './core/workerPool';
import { enclosingFunction, SymbolIndex } from './core/symbolIndex';
import { REF_STRIDE, RefFlag } from './core/types';
import { DEFAULT_ENCODING, indexFile } from './core/fileIndexer';

const EXTS = new Set(['.c', '.h', '.pc', '.pcc']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.vstags', '.svn']);

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out);
    } else if (EXTS.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
}

function flagStr(f: number): string {
  const s: string[] = [];
  if (f & RefFlag.Call) s.push('call');
  if (f & RefFlag.Member) s.push('member');
  if (f & RefFlag.Write) s.push('write');
  if (f & RefFlag.Sql) s.push('sql');
  if (f & RefFlag.PP) s.push('pp');
  if (f & RefFlag.Addr) s.push('addr');
  return s.join(',');
}

async function main() {
  const [dirArg, cmd = 'stats', arg] = process.argv.slice(2);
  if (!dirArg) {
    console.error('usage: vstags <dir> [stats|defs NAME|refs NAME|callers NAME|callees NAME|search Q|dump FILE|ctags [OUT]]');
    process.exit(1);
  }
  const root = path.resolve(dirArg);

  if (cmd === 'dump') {
    const fi = indexFile(path.resolve(root, arg), DEFAULT_ENCODING, 1 << 30);
    for (let i = 0; i < fi.defs.length; i++) {
      const d = fi.defs[i];
      const extra = [d.container && `in ${d.container}`, d.type && `type ${d.type}`, d.scope !== undefined && `scope #${d.scope}`, d.isStatic && 'static', d.endLine !== undefined && `end ${d.endLine + 1}`]
        .filter(Boolean)
        .join(', ');
      console.log(`#${i} ${d.kind.padEnd(10)} ${d.name.padEnd(24)} ${d.line + 1}:${d.col + 1}  ${extra}`);
      if (d.sig) console.log(`      ${d.sig.split('\n')[0]}`);
    }
    console.log(`includes: ${fi.includes.join(', ')}`);
    console.log('refs:');
    for (let k = 0; k < fi.refs.length; k += REF_STRIDE) {
      const enc = fi.refs[k + 4];
      console.log(`  ${fi.names[fi.refs[k]].padEnd(24)} ${fi.refs[k + 1] + 1}:${fi.refs[k + 2] + 1} [${flagStr(fi.refs[k + 3])}] in ${enc >= 0 ? fi.defs[enc].name : '<file>'}`);
    }
    return;
  }

  const files: string[] = [];
  walk(root, files);
  const idx = new SymbolIndex();
  const t0 = Date.now();
  const { errors } = await indexFiles(files, { enc: DEFAULT_ENCODING, maxSize: 4 << 20, workers: 0 }, (fi) => idx.setFile(fi));
  const ms = Date.now() - t0;
  const rel = (p: string) => path.relative(root, p);

  switch (cmd) {
    case 'stats': {
      const s = idx.stats();
      console.log(`files=${s.files} defs=${s.defs} refs=${s.refs} names=${s.names} time=${ms}ms errors=${errors.length}`);
      for (const e of errors) console.log(`  error: ${e.path}: ${e.message}`);
      break;
    }
    case 'defs':
      for (const h of idx.definitions(arg)) console.log(`${h.def.kind.padEnd(10)} ${rel(h.file.path)}:${h.def.line + 1}  ${h.def.sig ?? ''}`);
      break;
    case 'refs':
      for (const h of idx.references(arg, { excludeShadowed: true })) {
        const enc = h.enclosing >= 0 ? h.file.defs[h.enclosing].name : '<file>';
        console.log(`${rel(h.file.path)}:${h.line + 1}:${h.col + 1} [${flagStr(h.flags)}] in ${enc}`);
      }
      break;
    case 'callers':
      for (const g of idx.callers(arg, true)) {
        console.log(`${g.from ? g.from.def.name + ' (' + g.from.def.kind + ')' : '<file scope>'}  ${rel(g.file.path)}: ${g.hits.map((h) => h.line + 1).join(', ')}`);
      }
      break;
    case 'callees':
      for (const h of idx.definitions(arg).filter((x) => x.def.kind === 'function')) {
        console.log(`${arg} @ ${rel(h.file.path)}:${h.def.line + 1}`);
        for (const g of idx.callees(h.file, h.index)) {
          const target = idx.rankedDefinitions(g.name, h.file.path)[0];
          console.log(`  -> ${g.name} x${g.hits.length}  ${target ? rel(target.file.path) + ':' + (target.def.line + 1) : '(외부)'}`);
        }
      }
      break;
    case 'search':
      for (const h of idx.search(arg, 50)) console.log(`${h.def.name.padEnd(28)} ${h.def.kind.padEnd(10)} ${rel(h.file.path)}:${h.def.line + 1}`);
      break;
    case 'ctags': {
      const out = path.resolve(arg ?? path.join(root, 'tags'));
      fs.writeFileSync(out, toCtags(idx.allFiles(), path.dirname(out)));
      console.log(`wrote ${out}`);
      break;
    }
    case 'enclosing': {
      // enclosing FILE LINE
      const fi = idx.getFile(path.resolve(root, arg));
      const line = Number(process.argv[5]) - 1;
      if (fi) console.log(fi.defs[enclosingFunction(fi.defs, line)]?.name);
      break;
    }
    default:
      console.error('unknown command ' + cmd);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
