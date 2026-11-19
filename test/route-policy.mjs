import assert from 'node:assert/strict';
import * as p from '../lib/route-policy.js';
const providers=[
{id:'other',models:[{id:'m',name:'Model 1'},{id:'k',name:'Kimi 3'},{id:'h',name:'Model 1 Highspeed'},{id:'amb',name:'Ambiguous'}]},
{id:'other-vision',models:[{id:'m',name:'Model 1'},{id:'alias',name:'Model 1'},{id:'bad',name:'Missing'},{id:'amb',name:'Ambiguous'}]},
{id:'antigravity',models:[{id:'m',name:'Model 1',reasoningEfforts:['high']},{id:'a',name:'Ambiguous'}]},
{id:'kimi-subscription',models:[{id:'k',name:'Kimi 3'},{id:'b',name:'Ambiguous'}]},
];
const index=p.buildCatalogIndex({providers});let passed=0;
function check(name,fn){fn();passed++;console.log('ok - '+name);}
check('native image-input models are retained, only derived providers excluded',()=>{assert.equal(p.filterVisionProviders(providers).length,3);assert.equal(p.isVisionAliasProvider('antigravity'),false);});
check('exact id uses preferred provider without switching highspeed variants',()=>{assert.equal(p.findNonVisionTarget({provider:'other',model:'m'},index).provider,'antigravity');assert.equal(p.findNonVisionTarget({provider:'other',model:'h'},index).model,'h');});
check('nonvision same-id Kimi route prefers subscription',()=>assert.equal(p.migrateRouteObject({provider:'other',model:'k'},index).value.provider,'kimi-subscription'));
check('unique same-name alias matches but version/speed names remain distinct',()=>{assert.equal(p.findNonVisionTarget({provider:'other-vision',model:'alias'},index).model,'m');assert.notEqual(p.canonicalModelName('Model 1'),p.canonicalModelName('Model 1 Highspeed'));});
check('ambiguous different-id names never guessed',()=>{const idx=p.buildCatalogIndex({providers:[{id:'x-vision',models:[{id:'old',name:'Ambiguous'}]},...providers]});assert.equal(p.findNonVisionTarget({provider:'x-vision',model:'old'},idx),null);});
check('missing vision target errors, unknown nonvision custom route preserved',()=>{assert.ok(p.migrateRouteObject({provider:'other-vision',model:'bad'},index).error);assert.equal(p.migrateRouteObject({provider:'custom',model:'private'},index).error,null);});
check('invalid fixed or incomplete smart maps downgrade, declared values survive',()=>{assert.equal(p.migrateRouteObject({provider:'other-vision',model:'m',reasoningPolicy:'fixed',reasoningEffort:'max'},index).value.reasoningPolicy,'default');assert.equal(p.migrateRouteObject({provider:'other-vision',model:'m',reasoningPolicy:'fixed',reasoningEffort:'high'},index).value.reasoningEffort,'high');assert.equal(p.migrateRouteObject({provider:'other',model:'m',reasoningPolicy:'smart',smartMap:{low:'high'}},index).value.reasoningPolicy,'default');});
check('nested defaults, pairings, team and custom fields migrate losslessly',()=>{const route={provider:'other-vision',model:'m'};const input={enabled:false,revision:3,arbitrary:'keep',roles:[{defaultReviewer:route,pairings:[{authorProviders:['other-vision','other'],reviewer:route}]}],activeSnapshot:{enabledAt:'frozen',config:{team:{planner:route},extra:route}}};const r=p.migrateModesStore(input,index);assert.equal(r.errors.length,0);assert.equal(r.migrated.length,4);assert.equal(r.value.activeSnapshot.enabledAt,'frozen');assert.equal(r.value.revision,3);assert.deepEqual(r.value.roles[0].pairings[0].authorProviders,['other']);assert.equal(r.value.arbitrary,'keep');assert.equal(input.roles[0].defaultReviewer.provider,'other-vision');});
check('authorization collapses aliases after preferred mapping',()=>{const r=p.migrateAuthorizedModels([{provider:'other-vision',model:'m'},{provider:'antigravity',model:'m'},{provider:'other',model:'m'}],index);assert.deepEqual(r.after,[{provider:'antigravity',model:'m'}]);});
check('same display name prefers subscription even when the original nonvision id exists',()=>{const idx=p.buildCatalogIndex({providers:[{id:'other',models:[{id:'old-id',name:'Kimi K2.8 Preview'}]},{id:'kimi-subscription',models:[{id:'kimi-for-coding',name:'Kimi K2.8 Preview'}]}]});assert.equal(p.findNonVisionTarget({provider:'other',model:'old-id'},idx).provider,'kimi-subscription');});
console.log(`${passed} policy checks passed`);
