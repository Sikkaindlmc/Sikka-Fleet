import test from 'node:test';
import assert from 'node:assert/strict';
import {getIgnitionCounts} from '../src/dashboardMetrics.js';

test('counts explicit ignition values and preserves unknown values without changing source values',()=>{
 const rows=[
  {ignition:'ON'},
  {ignition:' on '},
  {ignition:true},
  {ignition:1},
  {ignition:'engine ignition ON'},
  {ignition:'OFF'},
  {ignition:false},
  {ignition:0},
  {ignition:'ignition switched OFF'},
  {ignition:'N/A'},
  {ignition:null},
  {},
  {ignition:'unknown'}
 ];
 assert.deepEqual(getIgnitionCounts(rows),{on:4,off:3,unknown:6});
});

test('prefers the normalized ignition status when it is present',()=>{
 assert.deepEqual(getIgnitionCounts([
  {ignition:true,ignitionStatus:'OFF'},
  {ignition:false,ignitionStatus:'UNKNOWN'}
 ]),{on:0,off:1,unknown:1});
});

test('an empty widget has no ON, OFF, or unknown vehicles',()=>{
 assert.deepEqual(getIgnitionCounts([]),{on:0,off:0,unknown:0});
 assert.deepEqual(getIgnitionCounts(null),{on:0,off:0,unknown:0});
});
