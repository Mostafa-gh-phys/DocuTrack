// Lightweight browser stub for unused pngjs/browser fallback inside djvujs-dist/DjVuPage.js
const pngStub = {
  PNG: class {
    width = 0;
    height = 0;
    data = new Uint8Array(0);
    static sync = {
      write() {
        return new Uint8Array(0);
      },
    };
  },
};

export default pngStub;
