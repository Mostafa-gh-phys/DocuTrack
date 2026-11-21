declare module 'djvujs-dist/library/src/DjVuDocument.js' {
  export interface DjVuJsBookmark {
    description: string;
    url: string;
    children?: DjVuJsBookmark[];
  }

  export interface DjVuJsPage {
    getWidth(): number;
    getHeight(): number;
    getDpi(): number;
    getRotation(): number;
    getImageData(rotate?: boolean): ImageData;
    getText(): string;
    reset(): void;
  }

  export default class DjVuJsDocument {
    constructor(buffer: ArrayBuffer, options?: {baseUrl?: string | null; memoryLimit?: number});
    getPagesQuantity(): number;
    getPagesSizes(): Array<{width: number; height: number; dpi: number}>;
    getContents(): DjVuJsBookmark[];
    getPageNumberByUrl(url: string): number | null;
    getPage(pageNumber: number): Promise<DjVuJsPage>;
    getPageUnsafe(pageNumber: number): DjVuJsPage;
  }
}
