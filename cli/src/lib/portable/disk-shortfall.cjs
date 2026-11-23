module.exports.diskShortfall = function (availableBytes, floorBytes, reservedBytes, requestedBytes) {
  const requiredBytes = floorBytes + reservedBytes + requestedBytes;
  if (availableBytes >= requiredBytes) return 0;
  return requiredBytes - availableBytes;
};
