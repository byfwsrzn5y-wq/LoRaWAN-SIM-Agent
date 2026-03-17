const protobuf = require('protobufjs');
const path = require('path');

const gwProto = protobuf.loadSync('./gw.proto');
const UplinkFrame = gwProto.lookupType('gw.UplinkFrame');

console.log('UplinkFrame fields:');
UplinkFrame.fieldsArray.forEach(f => {
  console.log(`  ${f.name}: ${f.type} ${f.repeated ? '[]' : ''}`);
});

// Try encoding with minimal data
const frame = UplinkFrame.create({
  phyPayload: Buffer.from([0x00, 0x01, 0x02, 0x03])
});

console.log('Frame created:', !!frame);
const encoded = UplinkFrame.encode(frame).finish();
console.log('Encoded:', encoded.length, 'bytes');
console.log('SUCCESS!');
