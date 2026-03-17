const protobuf = require('protobufjs');
const path = require('path');

const gwProto = protobuf.loadSync('./gw.proto');
const gw = gwProto.nested.gw;

console.log('All message types in gw package:');
Object.keys(gw.nested).forEach(k => {
  if (gw.nested[k] instanceof protobuf.Type) {
    console.log('  -', k);
  }
});
