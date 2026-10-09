import { readFile } from 'node:fs/promises';
const roadmap=JSON.parse(await readFile('docs/roadmap.json','utf8'));
const ids=new Set(roadmap.items.map(x=>x.id));
if(ids.size!==roadmap.items.length||roadmap.total!==ids.size) throw new Error('Roadmap count or duplicate ID');
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
  if(item.field_validated && !item.field_evidence)throw new Error(`Missing field evidence ${item.id}`);
  if(item.released && !item.release_evidence)throw new Error(`Missing release evidence ${item.id}`);
}
console.log(`${ids.size} roadmap items: counts and dependencies valid`);
