import test from 'node:test';
import assert from 'node:assert/strict';
import {addBookingSearchAliases} from './booking-search-aliases.mjs';

test('adds discoverable phrases only to the existing profile without changing other fields', () => {
  const profile = {id:'page-w-natalie-weber-index', url:'/w/natalie-weber/', title:'Natalie', aliases:[], body:'unchanged'};
  const other = {id:'unrelated', url:'/elsewhere/', aliases:['existing']};
  const input = [profile,other];
  const output = addBookingSearchAliases(input);
  assert.deepEqual(input, [profile,other]);
  assert.equal(output[1], other);
  assert.deepEqual({...output[0], aliases:[]}, profile);
  assert.deepEqual(output[0].aliases, ['Gesprächstermin anfragen','Telefontermin Natalie Weber','Discord-Gespräch Natalie Weber']);
  assert.deepEqual(addBookingSearchAliases(output), output);
});

test('fails closed for absent, duplicate or unexpectedly changed profile entries', () => {
  assert.throws(() => addBookingSearchAliases([]));
  const item={id:'page-w-natalie-weber-index',url:'/w/natalie-weber/',aliases:[]};
  assert.throws(() => addBookingSearchAliases([item,item]));
  assert.throws(() => addBookingSearchAliases([{...item,id:'different'}]));
  assert.throws(() => addBookingSearchAliases([{...item,aliases:'not-an-array'}]));
});
