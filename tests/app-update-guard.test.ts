import test from 'node:test';
import assert from 'node:assert/strict';
import {canApplyAppUpdate, restoreUpdatePlace} from '../src/app-update-guard';
const place={id:'bengaluru',name:'Bengaluru',latitude:12.97,longitude:77.59,country:'India',countryCode:'IN',timezone:'Asia/Kolkata'};
const idle={query:'',searching:false,geoBusy:false,drawerOpen:false,notifications:false,place};
test('approved update restores the selected location and vetoes unsaved interactions',()=>{
 let value:string|null=null;const storage={getItem:()=>value,setItem:(_key:string,next:string)=>{value=next;}};
 assert.equal(canApplyAppUpdate(idle,storage),true);
 assert.deepEqual(restoreUpdatePlace(storage,{...place,name:'Fallback'}),place);
 for(const change of [{query:'Delhi'},{searching:true},{geoBusy:true},{drawerOpen:true},{notifications:true}])
  assert.equal(canApplyAppUpdate({...idle,...change},storage),false);
 assert.equal(canApplyAppUpdate(idle,{...storage,setItem(){throw Error('Quota');}}),false);
 assert.equal(restoreUpdatePlace({getItem(){throw Error('Blocked');},setItem(){}},place),place);
});
