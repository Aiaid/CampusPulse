// Original code-native sedan geometry. No image files, remote assets or observed
// vehicle appearance are implied. Four views match NE,NW / SE,SW sprite cells.
function polygon(context, points, color) {
  context.fillStyle = color;
  context.beginPath();
  points.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
  context.closePath();
  context.fill();
}

export function createCarSprite() {
  const sheet = document.createElement('canvas');
  sheet.width = 192; sheet.height = 128;
  const context = sheet.getContext('2d');
  if (!context) return null;
  for (let row = 0; row < 2; row += 1) for (let column = 0; column < 2; column += 1) {
    context.save();
    context.translate(column * 96 + (column === 1 ? 94 : 2), row * 64 + 2);
    context.scale(column === 1 ? -1 : 1, 1);
    // The lower views reverse the ground-plane diagonal while keeping cabin
    // height vertical. Mirroring only left/right would lose NE versus SE.
    if (row === 1) context.transform(1, .53, 0, 1, 0, -25);
    // Four visible tyres, broad bonnet/boot and a separate glazed cabin make
    // this a car silhouette even at overview size. Front/rear lights distinguish
    // travel direction while the object stays upright in the map projection.
    for (const [x, y] of [[21, 32], [69, 23], [24, 43], [73, 34]]) {
      context.fillStyle = '#17222c';
      context.beginPath(); context.ellipse(x, y, 4.5, 6, -.15, 0, Math.PI * 2); context.fill();
    }
    polygon(context, [[8, 29], [61, 15], [86, 26], [34, 43]], '#d4e1eb');
    polygon(context, [[8, 29], [34, 39], [34, 47], [8, 37]], '#6c8198');
    polygon(context, [[34, 39], [86, 24], [86, 34], [34, 47]], '#9aadc2');
    polygon(context, [[28, 26], [38, 12], [59, 7], [73, 20], [51, 29]], '#b9cddd');
    polygon(context, [[31, 25], [40, 14], [43, 21], [47, 28]], row ? '#31576c' : '#49677b');
    polygon(context, [[45, 21], [61, 16], [69, 21], [51, 27]], '#26475b');
    polygon(context, [[40, 12], [58, 8], [65, 15], [45, 21]], '#e6edf1');
    polygon(context, [[51, 29], [73, 22], [77, 26], [54, 33]], row ? '#4d6d83' : '#29495f');
    context.strokeStyle = '#70879d'; context.lineWidth = .8;
    context.beginPath(); context.moveTo(55, 35); context.lineTo(55, 40); context.stroke();
    const front = '#fff2c8';
    const rear = '#e76a57';
    polygon(context, [[9, 32], [15, 34], [15, 37], [9, 35]], rear);
    polygon(context, [[36, 40], [42, 38], [42, 41], [36, 43]], rear);
    polygon(context, [[79, 28], [85, 26], [85, 30], [79, 32]], front);
    context.restore();
  }
  // Existing alpha-bound/material caches accept this local CanvasImageSource.
  // A stable identity keeps its materials separate from every bike/person sheet.
  sheet.src = 'campuspulse:original-code-car-v1';
  sheet.naturalWidth = sheet.width; sheet.naturalHeight = sheet.height;
  sheet.complete = true;
  return sheet;
}
