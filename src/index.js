import { copyFile, mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { PDFArray, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import pdfjs from 'pdfjs-dist/legacy/build/pdf.js';

const indexPDFBytes = await readFile('./input/INDEX.pdf');

const indexPDFTask = pdfjs.getDocument({ data: indexPDFBytes });
const pdfDoc = await indexPDFTask.promise;
const pageCount = pdfDoc.numPages;

// Extract each text "link" from the index PDF

/** @type Array<{text: string, x: number, y: number, pageIndex: number, w: number, h: number }> */
let extractedTextWithLocation = [];
for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent({ includeMarkedContent: false });

    const testPattern = /\d\d[A-Z]?-\d{1,3}/gm;
    for (const it of content.items) {
        /** @type import('pdfjs-dist/types/src/display/api').TextItem */
        // @ts-ignore
        const item = it;
        if (testPattern.test(item.str)) {
            extractedTextWithLocation.push({
                text: item.str,
                x: item.transform[ 4 ],
                y: item.transform[ 5 ],
                w: item.width,
                h: item.height,
                pageIndex: i - 1,
            });
        }
    }
}

const indexPDFDoc = await PDFDocument.load(indexPDFBytes);
const indexPDFPages = indexPDFDoc.getPages();

/** @type Array<PDFArray> */
const refMap = Array(indexPDFPages.length);
const files = await readdir('./input/');

// Keep cache of file page counts
const cache = new Map();

const docsBuild = process.argv.includes('google');

for (const link of extractedTextWithLocation) {
    const page = indexPDFPages[ link.pageIndex ];

    // Check if we have the annotations array for this page
    if (refMap[ link.pageIndex ] === undefined) {
        refMap[ link.pageIndex ] = page.node.lookup(PDFName.of('Annots'), PDFArray);
    }

    // Find all file in input that end with the extracted text, and is a PDF
    const filtered = files.filter(file => file.endsWith(link.text.split('-')[ 0 ] + '.pdf'));

    let pageAcc = 0; // Keep track of the accumulated page count, so we can figure out which file is the right file
    let pageOffset = 0; // Keep track of the page count of the last file (for the URI)
    let fileName = ""; // Name of the file we are looking for

    // Calculate which file/page number to link to
    for (const file of filtered) {
        // Check cache, otherwise open PDF and cache the length
        if (!cache.has(file)) {
            const pdf = await PDFDocument.load(await readFile('./input/' + file));
            cache.set(file, pdf.getPageCount());
        }

        // Find the number of pages
        pageAcc = pageAcc + cache.get(file);

        // If our page < pageAcc, then we have found the file
        if (link.pageIndex < pageAcc) {
            fileName = file;
            break;
        }

        pageOffset = pageAcc;
    }

    // TODO convert to valid URL
    const res = indexPDFDoc.context.register(
        indexPDFDoc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [ link.x, link.y, link.x + link.w, link.y + link.h ],
            Border: [ 0, 0, 2 ],
            C: [ 0, 0, 1 ],
            A: {
                Type: 'Action',
                S: 'URI',
                URI: PDFString.of(`${ docsBuild ? 'https://drive.google.com/viewerng/viewer?url=https://mexican-man.github.io/evo-manual-fix/google/' : './' }${ fileName }#page=${ Number(link.text.split('-')[ 1 ]) - pageOffset }`),
            }
        })
    );

    refMap[ link.pageIndex ].push(res);
}

// Copy input folder to output folder
for (const file of files) {
    await copyFile('./input/' + file, './output/' + (docsBuild ? 'google/' : '') + file)
        .catch(err => { });
}

// Save the updated PDF
const bytes = await indexPDFDoc.save();
await writeFile('./output/' + (docsBuild ? 'google/' : '') + 'INDEX.pdf', bytes);