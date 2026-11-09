#!/usr/bin/env node
/**
 * 릴리스: 버전 올리기 + CHANGELOG 정리 + release/vstags-<버전>.vsix 생성 + 커밋/태그 (push 는 하지 않음)
 *
 *   npm run release -- patch     0.2.0 -> 0.2.1  (버그 수정)
 *   npm run release -- minor     0.2.0 -> 0.3.0  (기능 추가)
 *   npm run release -- major     0.2.0 -> 1.0.0
 *   npm run release -- 0.4.0     버전 직접 지정
 *   npm run release -- minor --dry-run   파일만 바꾸고 vsix 는 만들되 커밋/태그는 하지 않음
 *
 * 순서: 커밋 안 된 변경 확인 -> CHANGELOG [Unreleased] 내용 확인 -> 테스트 -> 버전/CHANGELOG 갱신 -> vsix -> 커밋 + 태그
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
const out = (cmd) => execSync(cmd, { cwd: root }).toString().trim();
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bump = args.find((a) => !a.startsWith('--')) ?? 'patch';

// 1) 작업 트리가 깨끗해야 함 (릴리스 커밋에 다른 변경이 섞이지 않게)
if (!dryRun && out('git status --porcelain')) fail('커밋하지 않은 변경이 있습니다. 먼저 커밋하세요 (또는 --dry-run).');

// 2) 새 버전 계산
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [ma, mi, pa] = pkg.version.split('.').map(Number);
let version;
if (bump === 'major') version = `${ma + 1}.0.0`;
else if (bump === 'minor') version = `${ma}.${mi + 1}.0`;
else if (bump === 'patch') version = `${ma}.${mi}.${pa + 1}`;
else if (/^\d+\.\d+\.\d+$/.test(bump)) version = bump;
else fail(`알 수 없는 버전 지정: ${bump} (patch / minor / major / x.y.z)`);
if (out(`git tag --list v${version}`)) fail(`태그 v${version} 가 이미 있습니다.`);

// 3) CHANGELOG 의 [Unreleased] 에 내용이 있어야 함
const clPath = path.join(root, 'CHANGELOG.md');
const cl = fs.readFileSync(clPath, 'utf8').replace(/\r\n/g, '\n');
const m = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/.exec(cl);
if (!m || !m[1].trim()) fail('CHANGELOG.md 의 [Unreleased] 에 이번 변경 내용을 먼저 적어주세요.');

console.log(`\n▶ vstags ${pkg.version} -> ${version}\n`);

// 4) 테스트
run('npm test');

// 5) 버전 / CHANGELOG 갱신
const today = new Date();
const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}
fs.writeFileSync(clPath, cl.replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${version}] - ${date}\n`));

// 6) vsix
fs.mkdirSync(path.join(root, 'release'), { recursive: true });
const vsix = `release/vstags-${version}.vsix`;
run(`npx vsce package --allow-missing-repository -o ${vsix}`);

if (dryRun) {
  console.log(`\n✓ (dry-run) ${vsix} 생성. 커밋/태그는 하지 않았습니다.`);
  process.exit(0);
}

// 7) 커밋 + 태그 (RELEASE_TRAILER 가 있으면 커밋 메시지 끝에 붙임)
run(`git add package.json package-lock.json CHANGELOG.md ${vsix}`);
const msgFile = path.join(root, '.git', 'RELEASE_MSG');
fs.writeFileSync(msgFile, `Release v${version}\n` + (process.env.RELEASE_TRAILER ? `\n${process.env.RELEASE_TRAILER}\n` : ''));
run(`git commit -q -F "${msgFile}"`);
fs.unlinkSync(msgFile);
run(`git tag -a v${version} -m "vstags ${version}"`);
console.log(`\n✓ v${version} 릴리스: ${vsix} (커밋 + 태그 v${version}, push 는 하지 않음)`);
