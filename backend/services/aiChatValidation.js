const {body,validationResult}=require('express-validator');

const aiChatRequestValidators=[
 body('message').isString(),
 body('sessionId').optional({values:'null'}).isString().trim().isLength({min:1,max:100})
];

function getAiChatValidationError(req){
 const errors=validationResult(req).array();
 if(!errors.length)return null;
 return errors.some(error=>error.path==='message')
  ?'Question must be text.'
  :'Invalid chat session ID.';
}

module.exports={aiChatRequestValidators,getAiChatValidationError};
