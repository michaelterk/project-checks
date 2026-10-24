import assert from 'node:assert/strict';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createFileSnapshot, createSnapshotContext } from '../src/index.mjs';

test('canonical projection retains named missing inputs and fresh supplemental bytes', async t => {
  const root = await mkdtemp(join(tmpdir(),'projection-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'test'));
  await writeFile(join(root,'test/a.test.mjs'),'a');
  await writeFile(join(root,'test/b.test.mjs'),'b');
  await writeFile(join(root,'runtime'),'one');
  const context = createSnapshotContext({inputConcurrency:1});
  let commonCalls = 0;
  const generations = new Set();
  const snapshot = await createFileSnapshot({root,testDirectory:'test',inputs:['missing'],coverage:false,
    snapshotContext:context,inputProjection:async(entries,options)=>{
      generations.add(options.generation);
      if(options.kind==='common') commonCalls++;
      return [entries.map(({path,identity})=>[path.slice(root.length),identity]),
        options.kind==='common' ? await options.identify([join(root,'runtime')]) : []];
    }});
  t.after(async()=>{await snapshot.close();await context.close();});
  context.beginScanGeneration();
  const prepared = await snapshot.prepare();
  await Promise.all(prepared.files.map(prepared.unit));
  assert.equal(commonCalls,1);
  assert.equal(generations.size,1);
  await context.finishScanGeneration();
  const before = await snapshot.snapshot();
  assert.deepEqual(before,prepared.value);
  await writeFile(join(root,'runtime'),'two');
  assert.notEqual((await snapshot.snapshot()).common,before.common);
  await writeFile(join(root,'missing'),'present');
  assert.notEqual((await snapshot.snapshot()).common,before.common);
});

test('canonical projection rejects non-JSON values without changing default snapshots', async t=>{
  const root=await mkdtemp(join(tmpdir(),'projection-json-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'test'));
  await writeFile(join(root,'test/a.test.mjs'),'a');
  const snapshot=await createFileSnapshot({root,testDirectory:'test',inputs:[],inputProjection:()=>({bad:undefined})});
  t.after(()=>snapshot.close());
  await assert.rejects(snapshot.snapshot(),/plain JSON/);
});

test('projection receives cancellation and cannot complete after abort', async t=>{
  const root=await mkdtemp(join(tmpdir(),'projection-abort-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'test'));
  await writeFile(join(root,'test/a.test.mjs'),'a');
  const controller=new AbortController();
  const snapshot=await createFileSnapshot({root,testDirectory:'test',inputs:[],signal:controller.signal,
    inputProjection:(_entries,{signal})=>{
      assert.equal(signal,controller.signal);
      controller.abort(new Error('cancelled projection'));
      return [];
    }});
  t.after(()=>snapshot.close());
  await assert.rejects(snapshot.snapshot(),/cancelled projection/);
});
