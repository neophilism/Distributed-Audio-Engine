import { readFile } from 'node:fs/promises';
const roadmap=JSON.parse(await readFile('docs/roadmap.json','utf8'));
const ids=new Set(roadmap.items.map(x=>x.id));
if(ids.size!==roadmap.items.length||roadmap.total!==ids.size) throw new Error('Roadmap count or duplicate ID');
const repositories={DAE:'Distributed-Audio-Engine',SS:'SceneSignal',DRE:'Distributed-Radio-Engine',TZ:'TrackZero'};
for(const [prefix,repository] of Object.entries(repositories)) {
  const actual=roadmap.items.filter(item=>item.id.startsWith(prefix+'-')).length;
  if(actual!==roadmap.counts[repository])throw new Error(`Repository count mismatch ${repository}`);
}
if(roadmap.items.filter(item=>item.origin==='original').length!==roadmap.original_baseline_total)throw new Error('Original baseline count mismatch');
const seen=new Set(); const visiting=new Set();
function visit(id) {
  if(seen.has(id))return;
  if(visiting.has(id))throw new Error(`Dependency cycle ${id}`);
  visiting.add(id);
  const item=roadmap.items.find(x=>x.id===id);
  for(const dep of item.depends_on) { if(!ids.has(dep))throw new Error(`Unknown dependency ${dep}`);visit(dep); }
  visiting.delete(id);seen.add(id);
}
for(const id of ids)visit(id);
for(const item of roadmap.items) {
  if(!['planned','implemented','merged','blocked'].includes(item.status))throw new Error(`Unknown status ${item.id}`);
  for(const key of ['deployed','integration_tested','field_validated','released'])if(typeof item[key]!=='boolean')throw new Error(`Missing evidence state ${item.id}.${key}`);
  if(item.status==='merged'&&(!Number.isInteger(item.github_pr)||item.github_pr<1||!item.github_prs?.includes(item.github_pr)))throw new Error(`Missing merged PR record ${item.id}`);
  if(item.partial&&item.released)throw new Error(`Partial package cannot be released ${item.id}`);
  if(item.portable_integration_tested&&item.portable_integration_evidence?.kind!=='software-with-explicit-test-adapters')throw new Error(`Missing portable integration evidence ${item.id}`);
  if(item.field_validated && !item.field_evidence)throw new Error(`Missing field evidence ${item.id}`);
  if(item.released && !item.release_evidence)throw new Error(`Missing release evidence ${item.id}`);
}
const mergedEngine=roadmap.items.filter(item=>item.id.startsWith('DAE-')&&item.status==='merged').length;
if(roadmap.progress.audio_engine_merged_roadmap_ids!==mergedEngine)throw new Error('Merged engine progress mismatch');
console.log(`${ids.size} roadmap items: counts and dependencies valid`);
