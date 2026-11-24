const test=require('node:test');
const assert=require('node:assert/strict');
const {aiChatRequestValidators,getAiChatValidationError}=require('../services/aiChatValidation');

async function validate(body){
 const req={body,headers:{},params:{},query:{},cookies:{}};
 await Promise.all(aiChatRequestValidators.map(validator=>validator.run(req)));
 return getAiChatValidationError(req);
}

test('accepts a long question with a null session ID for a new conversation',async()=>{
 assert.equal(await validate({message:'x'.repeat(5000),sessionId:null}),null);
});

test('reports invalid question and session fields independently',async()=>{
 assert.equal(await validate({message:{text:'not a string'}}),'Question must be text.');
 assert.equal(await validate({message:'valid question',sessionId:42}),'Invalid chat session ID.');
});
