// Loaded by mongosh. This definition is shared by initialization and verification.
const uuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const uuid = {bsonType: 'string', pattern: uuidPattern};
const hash = {bsonType: 'string', pattern: '^[a-f0-9]{64}$'};
const patch = {
  bsonType: 'object', additionalProperties: false,
  properties: {
    species: {bsonType: ['string', 'null'], minLength: 1, maxLength: 120, pattern: '.*\\S.*'},
    health: {enum: ['Good', 'Fair', 'Poor', null]},
    diameter_cm: {bsonType: ['decimal', 'null'], minimum: 0, maximum: 999999.99},
    guard_damage: {bsonType: ['bool', 'null']}
  }
};
const observations = {
  bsonType: 'array', maxItems: 20,
  items: {bsonType: 'object', required: ['category', 'note', 'observed_at'], additionalProperties: false,
    properties: {
      category: {enum: ['guard', 'trunk', 'root', 'branch', 'other']},
      note: {bsonType: 'string', minLength: 1, maxLength: 500, pattern: '.*\\S.*'},
      observed_at: {bsonType: 'date'}
    }}
};
const payload = {
  bsonType: 'object',
  required: ['client_submission_id','record_id','base_version_no','form_version','observed_at','patch'],
  additionalProperties: false,
  properties: {
    client_submission_id: uuid, record_id: uuid,
    base_version_no: {bsonType: 'int', minimum: 1}, form_version: {enum: ['tree-v1','tree-v2']},
    observed_at: {bsonType:'date'}, patch, observations, client_metadata: {bsonType:'object'}
  }
};
const sourceSchema = {
  bsonType: 'object', additionalProperties: false,
  required: ['_id','author_id','client_submission_id','record_id','form_version','received_at','payload_hash','payload','canonical_payload_json'],
  properties: {
    _id: uuid, author_id: uuid, client_submission_id: uuid, record_id: uuid,
    form_version: {enum:['tree-v1','tree-v2']}, batch_id: {bsonType:['string','null'], pattern:uuidPattern},
    received_at: {bsonType:'date'}, payload_hash:hash, payload,
    canonical_payload_json: {bsonType:'string', minLength:2, maxLength:262144}
  }
};
function decimalPrecision(path) {
  return {$cond: [{$eq:[{$type:path},'decimal']}, {$eq:[path,{$trunc:[path,2]}]}, true]};
}
const sourceValidator = {$and: [
  {$jsonSchema:sourceSchema},
  {$expr:{$and:[
    {$eq:['$client_submission_id','$payload.client_submission_id']},
    {$eq:['$record_id','$payload.record_id']}, {$eq:['$form_version','$payload.form_version']},
    decimalPrecision('$payload.patch.diameter_cm'),
    {$or:[{$ne:['$form_version','tree-v1']},{$eq:[{$type:'$payload.observations'},'missing']}]},
    {$or:[
      {$gt:[{$size:{$objectToArray:{$ifNull:['$payload.patch',{}]}}},0]},
      {$gt:[{$size:{$ifNull:['$payload.observations',[]]}},0]}
    ]}
  ]}}
]};
const formSchema = {
  bsonType:'object', additionalProperties:false,
  required:['_id','form_version','schema_hash','published_at','canonical_fields','optional_sections'],
  properties: {
    _id:uuid,form_version:{enum:['tree-v1','tree-v2']},schema_hash:hash,published_at:{bsonType:'date'},
    canonical_fields:{bsonType:'array',minItems:4,maxItems:4,items:{bsonType:'object',
      required:['name','type','nullable'],additionalProperties:false,properties:{
        name:{enum:['species','health','diameter_cm','guard_damage']},
        type:{enum:['string','enum','decimal','boolean']},nullable:{enum:[true]},
        max_length:{bsonType:'int'},values:{bsonType:'array',items:{bsonType:'string'}},
        unit:{enum:['cm']},scale:{enum:[2]},minimum:{bsonType:'decimal'},maximum:{bsonType:'decimal'}
      }}},
    optional_sections:{bsonType:'object',additionalProperties:false,properties:{observations:{
      bsonType:'object',required:['max_items','categories','max_note_length'],additionalProperties:false,
      properties:{max_items:{enum:[20]},categories:{bsonType:'array',items:{enum:['guard','trunk','root','branch','other']}},max_note_length:{enum:[500]}}
    }}}
  }
};
const draftSchema = {
  bsonType:'object',additionalProperties:false,
  required:['_id','owner_id','client_submission_id','record_id','base_version_no','form_version','revision_no','state','payload','created_at','updated_at','final_submission_id'],
  properties:{
    _id:uuid,owner_id:uuid,client_submission_id:uuid,record_id:uuid,
    base_version_no:{bsonType:'int',minimum:1},form_version:{enum:['tree-v1','tree-v2']},
    revision_no:{bsonType:'int',minimum:1},state:{enum:['editable','finalizing','finalized']},
    payload:{bsonType:'object',additionalProperties:false,properties:{
      patch,observed_at:{bsonType:'date'},observations,client_metadata:{bsonType:'object'}
    }},created_at:{bsonType:'date'},updated_at:{bsonType:'date'},
    final_submission_id:{bsonType:['string','null'],pattern:uuidPattern},
    canonical_payload_json:{bsonType:'string',minLength:2,maxLength:262144}
  }
};
const draftValidator = {$and:[{$jsonSchema:draftSchema},{$expr:{$and:[
  decimalPrecision('$payload.patch.diameter_cm'),
  {$cond:[{$eq:['$state','finalized']},{$ne:['$final_submission_id',null]},{$eq:['$final_submission_id',null]}]},
  {$or:[{$ne:['$form_version','tree-v1']},{$eq:[{$type:'$payload.observations'},'missing']}]}
]}}]};
globalThis.fmModel = {sourceValidator,formSchema,draftValidator};
