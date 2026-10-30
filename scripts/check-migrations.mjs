import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const manifest=JSON.parse(readFileSync(new URL('../supabase/SOURCE-MANIFEST.json',import.meta.url),'utf8'));
for(const [name,expected] of Object.entries(manifest)) {
const actual=createHash('sha256').update(readFileSync(new URL('../'+name,import.meta.url))).digest('hex');
if(actual!==expected) throw new Error('Local schema snapshot changed; re-export from the canonical schema owner');
}
console.log('Local schema snapshot verified');
