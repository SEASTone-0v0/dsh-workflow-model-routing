// Content-addressed sibling runtime keeps Node ESM caches from retaining an older
// linked plugin or any of its transitive modules after package reactivation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=(await fs.readdir(path.join(root,'lib'))).filter(f=>f.endsWith('.js')).sort();
const contents=await Promise.all(files.map(f=>fs.readFile(path.join(root,'lib',f))));
const hash=createHash('sha256');files.forEach((f,i)=>hash.update(f).update(contents[i]));
const folder='runtime-'+hash.digest('hex').slice(0,12);
await fs.mkdir(path.join(root,folder),{recursive:true});
for(let i=0;i<files.length;i++)await fs.writeFile(path.join(root,folder,files[i]),contents[i]);
const packageFile=path.join(root,'package.json');const pkg=JSON.parse(await fs.readFile(packageFile,'utf8'));
pkg.main=`./${folder}/index.js`;pkg.exports['.']=pkg.main;pkg.exports['./client']=`./${folder}/client.js`;
pkg.files=[...new Set([...(pkg.files||[]).filter(f=>f!=='runtime-*'),'runtime-*/**','release-notes.json'])];
await fs.writeFile(packageFile,JSON.stringify(pkg,null,2)+'\n');
console.log(JSON.stringify({folder,files:files.length,main:pkg.main}));
