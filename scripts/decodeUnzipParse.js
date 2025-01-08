/* Run the below command to get /src/static/ejs/partials/scripts/decodeUnzipParse.ejs */
/* ( echo '<script>'; npx browserify decodeUnzipParse.js --standalone decodeUnzipParse | npx uglify-js; echo '</script>' ) > decodeUnzipParse.ejs */
const { Readable } = require('readable-stream');
const { Base64Decode } = require('base64-stream');
const { createGunzip } = require('browserify-zlib');
const { parser } = require('stream-json');
const Asm = require('stream-json/Assembler');

module.exports = function parseGzipBase64Json(base64String) {
  return new Promise((resolve, reject) => {
    const pipeline = Readable.from([base64String])
      .pipe(new Base64Decode())
      .pipe(createGunzip())
      .pipe(parser());

    // Assembler to assemble the streamed JSON tokens
    const assembler = Asm.connectTo(pipeline);

    // On 'done' event, the entire JSON object is ready
    assembler.on('done', asm => {
      resolve(asm.current);
    });

    // If anything goes wrong at any stage, reject the promise
    pipeline.on('error', err => {
      reject(err);
    });
  });
};
