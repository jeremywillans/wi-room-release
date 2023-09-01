//
// Util Module
//

// Parse and return JWT decoded integration credentials
function parseJwt(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
}
exports.parseJwt = parseJwt;

// Abbreviate Device Id
function shortName(deviceId) {
  return `${deviceId.slice(0, 8)}...${deviceId.slice(-8)}`;
}
exports.shortName = shortName;

// Generate Unique Identifier for each Device (used in Logs)
function uniqueId(d, deviceId) {
  const result = deviceId.slice(-4);
  const existing = Object.keys(d).map((j) => d[j].id).includes(result);
  if (!existing) return result;
  return uniqueId(d, deviceId.slice(0, deviceId.length - 1));
}
exports.uniqueId = uniqueId;
