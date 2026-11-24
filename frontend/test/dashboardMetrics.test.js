import test from 'node:test';
import assert from 'node:assert/strict';
import {getIgnitionCounts} from '../src/dashboardMetrics.js';

test('counts provider ON and OFF values separately and keeps unavailable values unknown',()=>{
 const rows=[
  {ignition:'ON'},
  {ignition:' on '},
  {ignition:'OFF'},
  {ignition:'N/A'},
  {ignition:null},
  {},
  {ignition:'1'},
  {ignition:true}
 ];
 assert.deepEqual(getIgnitionCounts(rows),{on:2,off:1,unknown:5});
});

test('an empty widget has no ON, OFF, or unknown vehicles',()=>{
 assert.deepEqual(getIgnitionCounts([]),{on:0,off:0,unknown:0});
 assert.deepEqual(getIgnitionCounts(null),{on:0,off:0,unknown:0});
});
