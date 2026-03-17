const protobuf = require('protobufjs');
const path = require('path');

try {
  const protoPath = path.join(__dirname, 'gw.proto');
  console.log('Loading proto from:', protoPath);
  
  const gwProto = protobuf.loadSync(protoPath);
  console.log('Proto loaded:', !!gwProto);
  console.log('Keys:', Object.keys(gwProto.nested || {}).slice(0, 5));
  
  const UplinkFrame = gwProto.lookupType('gw.UplinkFrame');
  console.log('UplinkFrame type:', !!UplinkFrame);
  
  // Test encoding
  const frame = UplinkFrame.create({
    rxInfo: {
      gatewayId: Buffer.from('0203040506070809', 'hex'),
      rssi: -100,
      snr: 10
    },
    txInfo: {
      frequency: 923200000
    },
    phyPayload: Buffer.from('YAAAAAAQAB+frmn4jg==', 'base64')
  });
  
  const encoded = UplinkFrame.encode(frame).finish();
  console.log('Encoded buffer:', encoded.length, 'bytes');
  console.log('First 10 bytes:', Array.from(encoded.slice(0, 10)).map(b => b.toString(16).padStart(2,'0')).join(' '));
  console.log('SUCCESS: Protobuf encoding works!');
} catch (e) {
  console.error('FAILED:', e.message);
}
