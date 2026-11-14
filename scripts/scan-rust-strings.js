const fs=require('fs'),path=require('path');
const root=process.argv[2];
const src=fs.readFileSync(path.join(root,'app/ui/i18n.js'),'utf8');
const EN=new Function('return '+src.match(/const EN = (\{[\s\S]*?\n\});/)[1])();
const norm=(s)=>s.replace(/\{[a-z_0-9]*\}/g,'{}');
const keys=new Set(Object.keys(EN).map(norm));
const files=['app/src-tauri/src/main.rs','core/src/lib.rs','core/src/node.rs','core/src/remote.rs','core/src/tor.rs','core/src/pool.rs'];
const miss=new Set();
for(const f of files){ const t=fs.readFileSync(path.join(root,f),'utf8');
  for(const m of t.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)){ const s=m[1].replace(/\\"/g,'"').replace(/\\n/g,'\n').replace(/\\\\/g,'\\');
    if(/[ğĞıİşŞçÇöÖüÜ]/.test(s) && !keys.has(norm(s))) miss.add(f.split('/').pop()+': '+s.slice(0,110)); } }
console.log([...miss].join('\n'));
