const fields = [
 {name:'species',type:'string',nullable:true,max_length:120},
 {name:'health',type:'enum',nullable:true,values:['Good','Fair','Poor']},
 {name:'diameter_cm',type:'decimal',nullable:true,unit:'cm',scale:2,minimum:0,maximum:999999.99},
 {name:'guard_damage',type:'boolean',nullable:true}
];
globalThis.fmForms = [1,2].map(i=>({
 _id:`50000000-0000-4000-8000-00000000000${i}`, form_version:`tree-v${i}`,
 canonical_fields:fields,
 optional_sections:i===1?{}:{observations:{max_items:20,categories:['guard','trunk','root','branch','other'],max_note_length:500}}
}));
