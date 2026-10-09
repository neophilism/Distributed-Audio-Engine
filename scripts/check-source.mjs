import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
async function walk(dir) {
  const result=[];
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const path=join(dir,entry.name);
    if(entry.isDirectory()) result.push(...await walk(path)); else result.push(path);
  }
  return result;
}
for (const path of await walk('src')) {
  const source=await readFile(path,'utf8');
  for(const [name,pattern] of Object.entries({eval:/\beval\s*\(/, dynamicFunction:/\bnew\s+Function\b/,typeBypass:/@ts-(ignore|nocheck)/,weakCrypto:/['"](?:md5|sha1)['"]/i,plaintextKeyLogging:/console\.(?:log|debug|info)\(/})) {
    if(pattern.test(source)) throw new Error(`${path}: forbidden ${name}`);
  }
  if (/SceneSignal|TrackZero|Unlocked Groove|artistPoints|permitDocument/.test(source)) throw new Error(`${path}: consumer product logic in neutral core`);
}
console.log('Core boundary and secure-source checks passed');
