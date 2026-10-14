export const mappings={dynamic:'strict',properties:{
 id:{type:'keyword'},name:{type:'text',analyzer:'standard',fields:{keyword:{type:'keyword',ignore_above:256}}},
 description:{type:'text',analyzer:'standard'},priceInPaise:{type:'long'},createdAt:{type:'date'},updatedAt:{type:'date'},
 productVersion:{type:'long'},deleted:{type:'boolean'},
}};
